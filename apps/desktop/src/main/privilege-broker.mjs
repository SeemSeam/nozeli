// privilege-broker.mjs — Nozeli 特权执行代理（TrustedRuntimeElevation，2026-10-28；审计修订版 3）。
// EffectAuthorization 冻结 API：capabilities()/authenticate()/execute()（状态集合不变）。
//
// 信任模型（明示，不做超界声明）：
//  - admin 提权入口只经“绝对路径+全祖先 root-owned 且无组/其他写位”的系统解释器
//    （Linux /usr/bin/python3，`-I` 隔离 import；逐符号链接解析），运行随源码内联的固定代码；
//    请求用户可写的 helper/解释器（含 bundled OMP runtime / Electron）一律不提权。
//  - root 端独占创建结果目录（root-owned 0711 容器：可穿透不可列目），其中文件 0644 且
//    **只含身份/digest/退出事实等非敏感内容**；命令 stdout/stderr 绝不落公开文件，经机制独占的
//    stdout 管道分帧返回（命令自身输出已在 root 端捕获重定向，无法注入该管道；非 root 进程
//    不持有该管道写端）。控制目录路径在命令发射**之前**输出（pre 记录后立即 flush），
//    因此发射后任何异常都可定位 pre → 状态 unknown，绝不报“未执行”。
//  - 批准即冻结：effectHash 由 task-permissions 共享算法对**完整冻结对象**整体计算（含
//    resolvedCommand/cwdIdentity/commandDigest/elevation 等全部字段，消费端不裁剪、不本地重算）；
//    实际执行 resolvedCommand；其字节 digest 在批准时冻结，执行端 O_NOFOLLOW 打开 pinned fd
//    校验 digest 后将**已哈希字节快照**到 root-owned 只读副本再 exec（消除就地改写竞态）；
//    cwdIdentity(dev,ino) 在准备期与 root 端双重核对。
//  - 完整 root 授权不承诺防御恶意 root 命令本身；本设计保证非 root 伪造不可通过
//    （root-owned 结果目录 + 数值 flags O_NOFOLLOW + 已开目录 fd 绑定访问 + 快照执行）。
//  - 取消/撤销：execution 记录绑定 grantId/sessionId，撤销只终止对应执行；admin 发射后无法
//    证明 root 后代终止 → 一律 unknown（含“直接子进程已退出但后代仍持有管道”的情况：root 端
//    killpg 后标 unknown），不声称零效果/无孤儿/可安全重试。
//  - darwin/win32：producer/consumer 协议完整实现，但未在真机验证；capabilities 如实标注
//    platformVerification=implemented-untested 与 resultChannel，不伪称已验证。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { constants as fsConstants } from 'node:fs';
import { effectHash as sharedEffectHash } from '../agents/managed/task-permissions.mjs';

const HELPER_PATH = fileURLToPath(new URL('./privilege-helper.cjs', import.meta.url));
const DEFAULT_HELPER_TIMEOUT_MS = 10_000;
const MECHANISM_OVERHEAD_MS = 180_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const RECEIPT_RING = 200;
const LINUX_PYTHON = '/usr/bin/python3';
const O_FLAGS = { RDONLY_NOFOLLOW: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW, DIR: fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW };

export const computeEffectHash = sharedEffectHash; // 单一共享实现方；无本地回退

// ── Linux admin 内联 launcher（固定代码；`python -I -c` 传入；不加载用户文件/用户模块路径）──
export const LINUX_ADMIN_PYTHON = String.raw`
import os,sys,json,time,stat as stmod,hashlib,tempfile,signal,select,base64,ctypes
def die(c,m):
    sys.stderr.write('NOZELI_ADMIN_PY_FAIL %d %s\n'%(c,m)); sys.exit(c)
def out(line):
    sys.stdout.write(line+'\n'); sys.stdout.flush()
def ancestors(p):
    out_=[]; cur=os.path.realpath(p)
    while True:
        out_.append(cur); parent=os.path.dirname(cur)
        if parent==cur: break
        cur=parent
    return out_
def trusted_file(p):
    s=os.stat(p)
    return s.st_uid==0 and not (s.st_mode&0o022)
exe=os.path.realpath(sys.executable)
if not trusted_file(exe): die(20,'interpreter not root-owned/unwritable')
for d in ancestors(os.path.dirname(exe)):
    if not trusted_file(d): die(20,'interpreter ancestor not trusted: '+d)
argv=sys.argv[1:]
opts={}; i=0
while i<len(argv):
    k=argv[i]
    if k in ('--manifest','--expect-digest','--timeout','--out-max'):
        if i+1>=len(argv): die(2,'missing value '+k)
        opts[k]=argv[i+1]; i+=2
    elif k=='--': i+=1
    elif k=='--identity': opts['--identity']=True; i+=1
    else: die(2,'unknown arg '+k)
ident={'uid':os.getuid(),'euid':os.geteuid(),'gid':os.getgid(),'egid':os.getegid(),'platform':'linux','root':os.geteuid()==0}
if opts.get('--identity'):
    if not ident['root']:
        sys.stderr.write('NOZELI_ADMIN_NOT_ELEVATED\n'); sys.exit(7)
    d=tempfile.mkdtemp(prefix='nozeli-rootres-'); os.chmod(d,0o711)
    f=os.open(os.path.join(d,'control.jsonl'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
    os.write(f,(json.dumps({'phase':'identity','identity':ident},sort_keys=True,separators=(',',':'))+'\n').encode()); os.fsync(f); os.close(f)
    out('NOZELI_ADMIN_DIR '+d); sys.exit(0)
raw=open(opts['--manifest'],'rb').read()
if hashlib.sha256(raw).hexdigest()!=opts['--expect-digest']: die(3,'manifest digest mismatch (tamper)')
m=json.loads(raw.decode('utf-8'))
for k in ('requestId','grantId','effectHash','command','cwd','action','commandDigest','scope'):
    if not isinstance(m.get(k),str) or not m[k]: die(4,'manifest field '+k)
if not isinstance(m.get('args'),list) or not all(isinstance(x,str) for x in m['args']): die(4,'args')
if str(m.get('v'))!='1' or m['scope']!='admin': die(4,'version/scope')
if not os.path.isabs(m['command']) or not os.path.isabs(m['cwd']): die(4,'abs paths')
try: timeout_s=float(opts['--timeout'])/1000.0
except Exception: die(4,'timeout')
try: maxout=int(opts.get('--out-max','65536'))
except Exception: die(4,'out-max')
if not ident['root']:
    sys.stderr.write('NOZELI_ADMIN_NOT_ELEVATED\n'); sys.exit(7)
cwdfd=os.open(m['cwd'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
ci=m.get('cwdIdentity')
if isinstance(ci,dict) and 'dev' in ci and 'ino' in ci:
    cs=os.fstat(cwdfd)
    if int(cs.st_dev)!=int(ci['dev']) or int(cs.st_ino)!=int(ci['ino']): die(25,'cwd identity != approved')
src=os.open(m['command'],os.O_RDONLY|os.O_NOFOLLOW)
try:
    ss=os.fstat(src)
    if not stmod.S_ISREG(ss.st_mode): die(22,'command not regular file')
    if ss.st_mode&0o022: die(22,'command group/world writable')
    h=hashlib.sha256(); size=0
    while True:
        b=os.read(src,1<<20)
        if not b: break
        h.update(b); size+=len(b)
    if h.hexdigest()!=m['commandDigest']: die(23,'command bytes != approved commandDigest')
    # 快照执行：把已哈希字节复制为 root-owned 0555 副本并 exec 副本——
    # 源文件此后任何就地改写都不影响实际执行内容。
    d=tempfile.mkdtemp(prefix='nozeli-rootres-'); os.chmod(d,0o711)
    snap=os.path.join(d,'exec.bin')
    dst=os.open(snap,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o500)
    os.lseek(src,0,os.SEEK_SET); copied_hash=hashlib.sha256()
    while True:
        b=os.read(src,1<<20)
        if not b: break
        copied_hash.update(b)
        view=memoryview(b)
        while view:
            n=os.write(dst,view)
            view=view[n:]
    if copied_hash.hexdigest()!=m['commandDigest']: die(23,'snapshot bytes != approved commandDigest')
    os.fsync(dst); os.close(dst)
    snapfd=os.open(snap,os.O_RDONLY)
    def wrec(obj):
        f=os.open(os.path.join(d,'control.jsonl'),os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o644)
        try:
            os.write(f,(json.dumps(obj,sort_keys=True,separators=(',',':'))+'\n').encode()); os.fsync(f)
        finally: os.close(f)
    wrec({'phase':'pre','identity':ident,'effectHash':m['effectHash'],'commandDigest':m['commandDigest']})
    out('NOZELI_ADMIN_DIR '+d)  # 发射前公布可信控制通道：此后异常=unknown，不可报“未执行”
    r1,w1=os.pipe(); r2,w2=os.pipe(); er,ew=os.pipe2(os.O_CLOEXEC)
    pid=os.fork()
    if pid==0:
        try:
            os.setsid(); os.dup2(w1,1); os.dup2(w2,2)
            for x in (r1,r2,w1,w2): os.close(x)
            os.close(er); os.fchdir(cwdfd); os.set_inheritable(snapfd,True)
            env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','TMPDIR':'/tmp','LANG':'C.UTF-8'}
            av=[m['command']]+m['args']
            try:
                libc=ctypes.CDLL(None,use_errno=True)
                ap=(ctypes.c_char_p*(len(av)+1))(*[x.encode() for x in av],None)
                el=[k+'='+v for k,v in env.items()]
                ep=(ctypes.c_char_p*(len(el)+1))(*[x.encode() for x in el],None)
                libc.fexecve(snapfd,ap,ep)
            except Exception:
                os.execve('/proc/self/fd/%d'%snapfd,av,env)
            os.write(ew,b'exec failed'); os._exit(127)
        except BaseException:
            os.write(ew,b'child setup failed'); os._exit(126)
    os.close(w1); os.close(w2); os.close(ew)
    bufs={r1:bytearray(),r2:bytearray()}; tot={r1:0,r2:0}; live=[r1,r2]
    deadline=time.time()+timeout_s
    while live and time.time()<deadline:
        rr,_,_=select.select(live,[],[],0.05)
        for r in rr:
            b=os.read(r,65536)
            if not b: live.remove(r); continue
            tot[r]+=len(b)
            if len(bufs[r])<maxout: bufs[r]+=b[:maxout-len(bufs[r])]
    timed=False; descendants=False; status=None
    while True:
        wp,status=os.waitpid(pid,os.WNOHANG)
        if wp==pid: break
        if time.time()>=deadline:
            timed=True
            try: os.killpg(pid,signal.SIGKILL)
            except Exception:
                try: os.kill(pid,signal.SIGKILL)
                except Exception: pass
            status=os.waitpid(pid,0)[1]; break
        time.sleep(0.02)
    if not timed and live:
        # 直接子进程已退出但仍有后代持有输出管道：整组终止，结果按未知处理。
        descendants=True
        try: os.killpg(pid,signal.SIGKILL)
        except Exception: pass
    exitc=None; sig=None
    if os.WIFEXITED(status): exitc=os.WEXITSTATUS(status)
    elif os.WIFSIGNALED(status): sig=os.WTERMSIG(status)
    spawn_error=os.read(er,4096).decode('utf-8','replace') or None; os.close(er)
    unknown=bool(timed or descendants)
    wrec({'phase':'post','identity':ident,'effectHash':m['effectHash'],'exitCode':exitc,'signal':sig,'timedOut':timed,'descendantsKilled':descendants,'spawnError':spawn_error})
    # 公开 root 文件只含非敏感事实；输出经机制独占 stdout 管道分帧（命令无法注入）。
    rec={'v':1,'effectHash':m['effectHash'],'commandDigest':m['commandDigest'],'identity':ident,'exitCode':exitc,'signal':sig,'timedOut':timed,'descendantsKilled':descendants,'spawnError':spawn_error,'stdoutBytes':tot[r1],'stderrBytes':tot[r2],'truncated':tot[r1]>maxout or tot[r2]>maxout,'requestId':m['requestId'],'grantId':m['grantId'],'controlPhases':['pre','post']}
    f=os.open(os.path.join(d,'receipt.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
    try:
        os.write(f,(json.dumps(rec,sort_keys=True,separators=(',',':'))+'\n').encode()); os.fsync(f)
    finally: os.close(f)
    def b64(x): return base64.b64encode(bytes(x)).decode('ascii')
    out('NOZELI_ADMIN_OUT_BEGIN'); out(b64(bufs[r1])); out('NOZELI_ADMIN_OUT_END')
    out('NOZELI_ADMIN_ERR_BEGIN'); out(b64(bufs[r2])); out('NOZELI_ADMIN_ERR_END')
    sys.exit(1 if unknown else 0)
finally:
    try: os.close(src)
    except Exception: pass
    try: os.close(cwdfd)
    except Exception: pass
    try: os.close(snapfd); os.unlink(snap)
    except Exception: pass
`;

const sha256File = async file => {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

const STRATEGIES = {
  linux: { authMethod: 'pkexec-python3', executable: 'pkexec', cancellationExitCodes: [126], needsPython: true, deps: [] },
  darwin: { authMethod: 'osascript-admin', executable: '/usr/bin/osascript', cancellationExitCodes: [], needsPython: false, deps: ['/usr/bin/openssl', '/usr/bin/base64', '/usr/bin/id'] },
  win32: { authMethod: 'uac-powershell', executable: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', cancellationExitCodes: [1], needsPython: false, deps: [] },
};
export const describeStrategies = () => structuredClone(STRATEGIES);
const PLATFORM_VERIFICATION = { linux: 'implemented', darwin: 'implemented-untested', win32: 'implemented-untested' };
const RESULT_CHANNEL = { linux: 'root-owned-facts+pipe-frames', darwin: 'root-owned-facts+pipe-frames (untested)', win32: 'caller-owned-receipt-file (unverified channel, untested)' };

const posixQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
const powershellQuote = value => `'${String(value).replaceAll("'", "''")}'`;
export const powershellArgumentList = items => `@(${items.map(powershellQuote).join(',')})`;
export function parsePowershellArgumentList(text) {
  if (!text.startsWith('@(') || !text.endsWith(')')) throw Error('not a powershell array literal');
  const body = text.slice(2, -1);
  const items = [];
  for (let i = 0; i < body.length;) {
    if (body[i] !== '\'') throw Error(`element ${items.length} is not single-quoted at ${i}`);
    let value = ''; i++;
    for (;;) {
      const next = body.indexOf('\'', i);
      if (next < 0) throw Error('unterminated quote');
      if (body[next + 1] === '\'') { value += body.slice(i, next) + '\''; i = next + 2; continue; }
      value += body.slice(i, next); i = next + 1; break;
    }
    items.push(value);
    if (i >= body.length) break;
    if (body[i] !== ',') throw Error(`expected ',' at ${i}`);
    i++;
  }
  return items;
}
const utf16leB64 = text => Buffer.from(text, 'utf16le').toString('base64');

// 机制 stdout 分帧解析（命令无法注入该管道；帧即 root 端结构化输出）。
function parseAdminFrames(stdoutText) {
  const frames = { dir: null, outB64: null, errB64: null };
  const dirLine = stdoutText.split('\n').map(line => line.trim()).filter(line => line.startsWith('NOZELI_ADMIN_DIR ')).at(-1);
  if (dirLine) frames.dir = dirLine.slice('NOZELI_ADMIN_DIR '.length).trim();
  const grab = name => {
    const match = stdoutText.match(new RegExp(`NOZELI_ADMIN_${name}_BEGIN\\n([\\s\\S]*?)\\nNOZELI_ADMIN_${name}_END`));
    return match ? match[1].replace(/\s+/g, '') : null;
  };
  frames.outB64 = grab('OUT');
  frames.errB64 = grab('ERR');
  return frames;
}

// 平台机制调用构造（纯函数，供平台选择测试）。
export function buildMechanismInvocation({ platform, mechanismPath, interpreter, helperPath, electronAsNode = false, helperArgs, prompt = 'Nozeli 特权执行', admin = {} }) {
  if (platform === 'linux') {
    if (admin.enabled) {
      // -I：隔离模式（忽略用户 site/环境 PYTHON*，不注入当前目录到 import 路径）。
      const pyArgs = ['-I', '-c', admin.pythonCode ?? LINUX_ADMIN_PYTHON, '--', '--manifest', admin.manifestPath, '--expect-digest', admin.expectDigest, '--timeout', String(admin.timeoutMs ?? 60_000), ...(admin.identity ? ['--identity'] : []), ...(admin.outMax ? ['--out-max', String(admin.outMax)] : [])];
      return { command: mechanismPath, args: [interpreter, ...pyArgs] };
    }
    const interpreterArgs = [interpreter, helperPath, ...helperArgs];
    return { command: mechanismPath, args: [...(electronAsNode ? ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1'] : []), ...interpreterArgs] };
  }
  if (platform === 'darwin') {
    if (admin.enabled) {
      const q = posixQuote;
      const setup = [
        `umask 077`,
        `U=$(/usr/bin/id -u); [ "$U" = 0 ] || { echo NOZELI_ADMIN_NOT_ELEVATED >&2; exit 7; }`,
        `D=$(/usr/bin/mktemp -d /tmp/nozeli-rootres-XXXXXX) && /bin/chmod 0711 "$D" || exit 3`,
      ];
      const identity = admin.identity
        ? [...setup, `printf '%s\\n' '{"phase":"identity","identity":{"uid":0,"euid":0,"root":true}}' > "$D/control.jsonl"`, `/bin/chmod 0644 "$D/control.jsonl"`, `echo "NOZELI_ADMIN_DIR $D"`].join('; ')
        : [...setup,
          `S=$(/usr/bin/mktemp -d /tmp/nozeli-rootsec-XXXXXX)`,
          `/bin/cp ${q(admin.command)} "$S/exec" || exit 3`,
          `H=$(/usr/bin/openssl dgst -sha256 "$S/exec" | /usr/bin/awk '{print $NF}')`,
          `[ "$H" = ${q(admin.commandDigest)} ] || { echo NOZELI_ADMIN_TAMPER >&2; exit 3; }`,
          `/bin/chmod 0500 "$S/exec"`,
          `printf '%s\\n' ${q(JSON.stringify({phase:'pre',uid:0,euid:0,root:true,effectHash:admin.effectHash,commandDigest:admin.commandDigest}))} > "$D/control.jsonl"`,
          `/bin/chmod 0644 "$D/control.jsonl"`,
          `echo "NOZELI_ADMIN_DIR $D"`,
          `cd ${q(admin.cwd)} || exit 24`,
          `/usr/bin/perl -e ${q('use POSIX (); my $seconds=shift; my $pid=fork(); die "fork" unless defined $pid; if(!$pid){POSIX::setsid(); exec @ARGV; exit 127;} $SIG{ALRM}=sub{kill 9,-$pid; waitpid($pid,0); exit 124;}; alarm $seconds; waitpid($pid,0); my $s=$?; alarm 0; kill 9,-$pid; exit(($s & 127)?128+($s & 127):($s>>8));')} ${Math.ceil((admin.timeoutMs??60000)/1000)} "$S/exec" ${admin.args.map(q).join(' ')} > "$S/out.bin" 2> "$S/err.bin"`,
          `RC=$?; T=false; [ "$RC" = 124 ] && T=true`,
          `printf '%s\\n' "{\\"phase\\":\\"post\\",\\"uid\\":0,\\"exitCode\\":$RC,\\"timedOut\\":$T}" >> "$D/control.jsonl"`,
          `printf '%s\\n' "{\\"exitCode\\":$RC,\\"timedOut\\":$T}" > "$D/receipt.json"; /bin/chmod 0644 "$D/receipt.json"`,
          `echo NOZELI_ADMIN_OUT_BEGIN; /usr/bin/base64 < "$S/out.bin"; echo NOZELI_ADMIN_OUT_END`,
          `echo NOZELI_ADMIN_ERR_BEGIN; /usr/bin/base64 < "$S/err.bin"; echo NOZELI_ADMIN_ERR_END`,
          `/bin/rm -rf "$S"`,
        ].join('; ');
      return { command: mechanismPath, args: ['-e', `do shell script ${JSON.stringify(identity)} with administrator privileges with prompt ${JSON.stringify(prompt)}`] };
    }
    const interpreterArgs = [interpreter, helperPath, ...helperArgs];
    const shellLine = [...(electronAsNode ? ['ELECTRON_RUN_AS_NODE=1'] : []), ...interpreterArgs.map(posixQuote)].join(' ');
    return { command: mechanismPath, args: ['-e', `do shell script ${JSON.stringify(shellLine)} with administrator privileges with prompt ${JSON.stringify(prompt)}`] };
  }
  if (platform === 'win32') {
    if (admin.enabled) {
      // UAC child writes facts only beneath an Administrators-owned protected directory.
      // The unelevated launcher verifies ownership/DACL before returning the receipt.
      const resultName = 'nozeli-admin-' + randomUUID();
      const resultDir = `[IO.Path]::Combine([Environment]::GetFolderPath('CommonApplicationData'),${powershellQuote(resultName)})`;
      const quoteArg = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
      const inner = [
        `$ErrorActionPreference='Stop'`,
        `$id=[Security.Principal.WindowsIdentity]::GetCurrent(); $pr=New-Object Security.Principal.WindowsPrincipal($id)`,
        `if(-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){ exit 7 }`,
        `$d=${resultDir}; if(Test-Path -LiteralPath $d){exit 3}`,
        `$admins=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544'); $system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18'); $caller=New-Object Security.Principal.SecurityIdentifier('__NOZELI_CALLER_SID__')`,
        `$acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($admins)`,
        `foreach($sid in @($admins,$system)){ $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }`,
        `$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($caller,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))`,
        `[IO.Directory]::CreateDirectory($d,$acl) | Out-Null`,
        `$rec=@{v=1;nonce=${powershellQuote(resultName)};user=$id.Name;admin=$true;effectHash=${powershellQuote(admin.effectHash??'')};phase='identity'}`,
        ...(admin.identity ? [] : [
          `$snap=Join-Path $d 'exec.exe'; Copy-Item -LiteralPath ${powershellQuote(admin.command)} -Destination $snap`,
          `$h=(Get-FileHash -LiteralPath $snap -Algorithm SHA256).Hash; if($h -ne ${powershellQuote(String(admin.commandDigest).toUpperCase())}){exit 3}`,
          `$rec.phase='pre'; $rec.commandDigest=$h.ToLowerInvariant(); $pre=Join-Path $d 'pre.json'; [IO.File]::WriteAllText($pre,($rec|ConvertTo-Json -Compress))`,
          `$si=New-Object Diagnostics.ProcessStartInfo; $si.FileName=$snap; $si.Arguments=${powershellQuote((admin.args??[]).map(quoteArg).join(' '))}; $si.WorkingDirectory=${powershellQuote(admin.cwd)}; $si.UseShellExecute=$false; $si.RedirectStandardOutput=$true; $si.RedirectStandardError=$true`,
          `$p=New-Object Diagnostics.Process; $p.StartInfo=$si; [void]$p.Start(); $ot=$p.StandardOutput.ReadToEndAsync(); $et=$p.StandardError.ReadToEndAsync()`,
          `$done=$p.WaitForExit(${Math.min(admin.timeoutMs??60000,600000)}); if(-not $done){ & "$env:SystemRoot\\System32\\taskkill.exe" /PID $p.Id /T /F | Out-Null; $rec.timedOut=$true } else { $rec.exitCode=$p.ExitCode; $rec.timedOut=$false }`,
          `$rec.phase='post'; if($ot.Wait(3000) -and $et.Wait(3000)){ $rec.stdoutB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ot.Result)); $rec.stderrB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($et.Result)) } else { $rec.timedOut=$true }`,
        ]),
        `$r=Join-Path $d 'receipt.json'; [IO.File]::WriteAllText($r,($rec|ConvertTo-Json -Compress)); $fa=Get-Acl -LiteralPath $r; $fa.SetOwner($admins); Set-Acl -LiteralPath $r -AclObject $fa`,
        `exit 0`,
      ].join('; ');
      const encoded = utf16leB64(inner);
      const script = [
        `$ErrorActionPreference='Stop'; $src=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(${powershellQuote(encoded)})); $src=$src.Replace('__NOZELI_CALLER_SID__',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value); $code=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($src))`,
        `try{$p=Start-Process -FilePath ${powershellQuote(interpreter)} -ArgumentList @('-NoProfile','-EncodedCommand',$code) -Verb RunAs -Wait -PassThru -WindowStyle Hidden}catch{ if($_.Exception.NativeErrorCode -eq 1223){exit 1}; throw }`,
        `$d=${resultDir}; if($p.ExitCode -ne 0){exit $p.ExitCode}`,
        `foreach($f in @($d,(Join-Path $d 'receipt.json'))){$item=Get-Item -LiteralPath $f; if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse result'}; $a=Get-Acl -LiteralPath $f; if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544'){throw 'untrusted owner'}; foreach($rule in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){ if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @('S-1-5-32-544','S-1-5-18') -and ([int]$rule.FileSystemRights -band 852310)){throw 'untrusted write ACL'} } }`,
        `$raw=[IO.File]::ReadAllText((Join-Path $d 'receipt.json')); $r=$raw|ConvertFrom-Json; if($r.nonce -ne ${powershellQuote(resultName)}){throw 'receipt nonce'}; [Console]::WriteLine('NOZELI_WIN_RECEIPT '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($raw)))`,
      ].join('; ');
      return { command: mechanismPath, args: ['-NoProfile', '-NonInteractive', '-Command', script] };
    }
    const script = [
      ...(electronAsNode ? [`$env:ELECTRON_RUN_AS_NODE='1'`] : []),
      `$p=Start-Process -FilePath ${powershellQuote(interpreter)} -ArgumentList ${powershellArgumentList([helperPath, ...helperArgs])} -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
      'exit $p.ExitCode',
    ].join('; ');
    return { command: mechanismPath, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] };
  }
  throw Object.assign(Error(`unsupported platform ${platform}`), { code: 'PLATFORM_UNSUPPORTED' });
}

const collector = limit => {
  const chunks = []; let kept = 0, total = 0, truncated = false;
  return {
    push(chunk) {
      total += chunk.length;
      const room = limit - kept;
      if (room > 0) chunks.push(chunk.subarray(0, room));
      kept += Math.min(chunk.length, room);
      if (total > limit) truncated = true;
    },
    text() { return Buffer.concat(chunks).toString('utf8'); },
    get totalBytes() { return total; },
    get truncated() { return truncated; },
  };
};

class ChildRun {
  constructor({ command, args, env, extraFd = false }) {
    this.stdout = collector(MAX_STREAM_BYTES);
    this.stderr = collector(64 * 1024);
    this.controlText = extraFd ? collector(1024 * 1024) : null;
    const stdio = ['ignore', 'pipe', 'pipe', ...(extraFd ? ['pipe'] : [])];
    // POSIX 独立进程组：尽力整组终止（user 作用域可证）。admin 目标可能为 root，普通 uid
    // kill 会 EPERM——此时不假设已终止，状态按 unknown 处理，绝不声称“无提权孤儿”。
    const detached = process.platform !== 'win32';
    this.child = spawn(command, args, { env, stdio, ...(detached ? { detached: true } : {}) });
    this.detached = detached;
    this.child.stdout?.on('data', chunk => this.stdout.push(chunk));
    this.child.stderr?.on('data', chunk => this.stderr.push(chunk));
    if (extraFd) this.child.stdio[3]?.on('data', chunk => this.controlText.push(chunk));
    this.exitPromise = new Promise((resolve, reject) => {
      this.child.on('error', reject);
      this.child.on('close', (code, signal) => resolve({ code, signal }));
    });
    this.killed = false;
    this.killFailed = false;
  }
  kill() {
    this.killed = true;
    try {
      if (this.detached && this.child.pid) process.kill(-this.child.pid, 'SIGKILL');
      else this.child.kill('SIGKILL');
      return true;
    } catch { this.killFailed = true; return false; }
  }
  async waitOrWatchdog(timeoutMs, graceMs = 5000) {
    let graceTimer = null;
    const watchdog = setTimeout(() => this.kill(), timeoutMs);
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise(resolve => { graceTimer = setTimeout(() => resolve({ code: null, signal: null, grace: true }), timeoutMs + graceMs); }),
      ]);
    } finally { clearTimeout(watchdog); clearTimeout(graceTimer); }
  }
}

const parseControlLines = text => text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const validControl = (record, secret, phase) => record && record.phase === phase
  && typeof record.proof === 'string' && record.proof === createHash('sha256').update(secret + ':' + phase).digest('hex');
const parseReceiptLine = text => {
  const lines = text.split('\n').filter(line => line.startsWith('@@NOZELI-RECEIPT@@'));
  if (!lines.length) return null;
  try { return JSON.parse(lines.at(-1).slice('@@NOZELI-RECEIPT@@'.length)); } catch { return null; }
};

// root 结果目录核验（Linux）：数值 flags O_NOFOLLOW 打开目录，fstat 属主/类型/模式；
// 子文件经 /proc/self/fd/<dirFd>/<name> 打开——绑定到已验证的目录 inode，避免路径交换。
// 任何一环失败→null（调用方必须拒绝）。
async function readRootResults(dirPath, names) {
  if (process.platform === 'win32') return null; // Windows 无该核验原语：不走此通道
  const dirHandle = await fs.open(dirPath, O_FLAGS.DIR).catch(() => null);
  if (!dirHandle) return null;
  try {
    const dirStat = await dirHandle.stat();
    if (!dirStat.isDirectory() || dirStat.uid !== 0 || (dirStat.mode & 0o777) !== 0o711) return null;
    // Linux：经 /proc/self/fd 绑定已验证目录 inode；darwin：无 /proc，直接路径 + O_NOFOLLOW + 属主核验
    //（路径交换残余窗口在 platformVerification=implemented-untested 中明示）。
    const boundRoot = process.platform === 'linux' ? `/proc/self/fd/${dirHandle.fd}` : dirPath;
    const out = {};
    for (const name of names) {
      const handle = await fs.open(path.join(boundRoot, name), O_FLAGS.RDONLY_NOFOLLOW).catch(() => null);
      if (!handle) { out[name] = null; continue; }
      try {
        const stat = await handle.stat();
        if (stat.uid !== 0 || stat.mode & 0o022 || stat.size > 2 * 1024 * 1024) { out[name] = null; continue; }
        out[name] = await handle.readFile('utf8');
      } finally { await handle.close(); }
    }
    return out;
  } finally { await dirHandle.close(); }
}

export function createPrivilegeBroker(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const helperPath = options.helperPath ?? HELPER_PATH;
  const defaultMaxOutput = Math.min(Math.max(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT, 4096), 1024 * 1024);
  const now = options.now ?? (() => Date.now());
  const effectHashFn = options.effectHashFn ?? sharedEffectHash;
  const strategy = STRATEGIES[platform];
  if (!strategy) throw Object.assign(Error(`unsupported platform ${platform}`), { code: 'PLATFORM_UNSUPPORTED' });

  const grants = new Map();
  const sessions = new Map();
  const executions = new Map(); // executionId → {run|null, scope, grantId, sessionId, stage, cancelRequested, startedMs}
  const receipts = new Map();
  const rememberReceipt = receipt => {
    const id = randomUUID();
    receipts.set(id, receipt);
    while (receipts.size > RECEIPT_RING) receipts.delete(receipts.keys().next().value);
    return id;
  };

  // ── admin 可信系统解释器（仅 Linux 使用；darwin/win32 有各自机制，不解析 python）──
  let trustedPythonCache;
  const resolveTrustedPython = async () => {
    if (platform !== 'linux') return { trusted: true, path: null, reason: null };
    if (trustedPythonCache) return trustedPythonCache;
    const target = options.pythonPath ?? LINUX_PYTHON;
    const result = { path: target, trusted: false, reason: null };
    try {
      const real = await fs.realpath(target);
      const parts = real.split(path.sep).filter(Boolean);
      let current = path.sep;
      for (let index = 0; index <= parts.length; index++) {
        const stat = await fs.stat(current);
        if (stat.uid !== 0 || stat.mode & 0o022) { result.reason = `不可信路径组件（非root可写）：${current}`; trustedPythonCache = result; return result; }
        if (index < parts.length) current = path.join(current, parts[index]);
      }
      const fileStat = await fs.stat(real);
      if (fileStat.uid !== 0 || fileStat.mode & 0o022 || !(fileStat.mode & 0o111)) { result.reason = 'python3 非 root-owned 或可被组/其他写'; trustedPythonCache = result; return result; }
      result.path = real; result.trusted = true;
    } catch (error) { result.reason = `解析失败：${error.message}`; }
    trustedPythonCache = result;
    return result;
  };

  // user 作用域解释器（bundled node 助手；不提权，user-writable 可接受）
  let interpreterCache;
  let helperSha256;
  const resolveInterpreter = async () => {
    if (interpreterCache) return interpreterCache;
    const probe = async (candidatePath, electronAsNode) => {
      const probeEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin', ...(electronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
      const run = new ChildRun({ command: candidatePath, args: [helperPath, '--selftest'], env: probeEnv });
      const exit = await run.waitOrWatchdog(DEFAULT_HELPER_TIMEOUT_MS, 1000);
      return exit.code === 0 && !exit.grace && /^NOZELI-HELPER-OK /m.test(run.stdout.text());
    };
    const candidates = [];
    if (options.interpreter) candidates.push({ path: options.interpreter, electronAsNode: false, kind: 'pinned' });
    else {
      try {
        const { resolveBundledOmpRuntime } = await import('../agents/managed/omp-runtime.mjs');
        const runtime = await resolveBundledOmpRuntime({ appRoot: options.appRoot });
        candidates.push({ path: runtime.command, electronAsNode: false, kind: 'bundled-omp' });
      } catch { /* 打包 runtime 缺失时降级到进程解释器 */ }
      if (!process.versions.electron) candidates.push({ path: process.execPath, electronAsNode: false, kind: 'node' });
      candidates.push({ path: process.execPath, electronAsNode: true, kind: 'electron-as-node' });
    }
    for (const candidate of candidates) {
      if (await probe(candidate.path, candidate.electronAsNode).catch(() => false)) {
        interpreterCache = { ...candidate, sha256: await sha256File(candidate.path) };
        return interpreterCache;
      }
    }
    interpreterCache = { error: 'no interpreter can run the privilege helper' };
    return interpreterCache;
  };
  const interpreterReady = async () => {
    const interpreter = await resolveInterpreter();
    if (interpreter.error) throw Object.assign(Error(interpreter.error), { code: 'INTERPRETER_UNAVAILABLE' });
    return interpreter;
  };
  const helperDigest = async () => helperSha256 ??= await sha256File(helperPath);

  const findExecutable = async name => {
    if (path.isAbsolute(name)) return await fs.access(name, fs.constants.X_OK).then(() => name, () => null);
    for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, name);
      if (await fs.access(candidate, fs.constants.X_OK).then(() => true, () => false)) return candidate;
    }
    return null;
  };
  let mechanismCache;
  const resolveMechanism = async () => mechanismCache ??= await findExecutable(strategy.executable);

  const currentIdentity = () => {
    if (platform === 'win32') return { platform, account: env.USERNAME ? `${env.USERDOMAIN ?? ''}\\${env.USERNAME}` : null };
    return { platform, uid: process.getuid?.(), euid: process.geteuid?.(), gid: process.getgid?.(), egid: process.getegid?.() };
  };

  const assertGrantLive = grantId => {
    if (typeof grantId !== 'string' || !grantId) throw Object.assign(Error('grantId required'), { code: 'GRANT_INVALID' });
    const grant = grants.get(grantId) ?? { revoked: false, seenAt: now() };
    grants.set(grantId, grant);
    if (grant.revoked) throw Object.assign(Error('grant 已撤销'), { code: 'GRANT_REVOKED' });
  };
  const sessionFor = ({ sessionId, grantId, generation }) => {
    if (!sessionId) return null;
    const session = sessions.get(sessionId);
    if (!session) throw Object.assign(Error('sessionId 无效'), { code: 'SESSION_INVALID' });
    if (session.revoked) throw Object.assign(Error('session 已撤销'), { code: 'SESSION_REVOKED' });
    if (session.grantId !== grantId) throw Object.assign(Error('session 与 grant 不匹配'), { code: 'SESSION_GRANT_MISMATCH' });
    if (session.generation != null && generation != null && session.generation !== generation) throw Object.assign(Error('generation 不匹配'), { code: 'SESSION_GENERATION_MISMATCH' });
    if (session.expiresAt != null && session.expiresAt <= now()) throw Object.assign(Error('session 已过期'), { code: 'SESSION_EXPIRED' });
    return session;
  };

  const childEnvFor = (interp, extra = {}) => { const base = { PATH: env.PATH ?? '/usr/bin:/bin', ...extra }; if (interp.electronAsNode) base.ELECTRON_RUN_AS_NODE = '1'; return base; };

  // 冻结效果校验：字段全量交由共享哈希；此处仅校验可执行性事实并确定执行目标 resolvedCommand。
  const validateFrozenEffect = frozenEffect => {
    if (!frozenEffect || typeof frozenEffect !== 'object') return { problem: 'frozenEffect required' };
    if (frozenEffect.version !== 1) return { problem: 'frozenEffect.version must be 1' };
    const exec = frozenEffect.resolvedCommand ?? frozenEffect.command;
    if (typeof exec !== 'string' || !path.isAbsolute(exec)) return { problem: 'resolvedCommand/command must be an absolute path' };
    if (!Array.isArray(frozenEffect.args) || frozenEffect.args.some(arg => typeof arg !== 'string')) return { problem: 'args must be string[]' };
    if (typeof frozenEffect.cwd !== 'string' || !path.isAbsolute(frozenEffect.cwd)) return { problem: 'cwd must be an absolute path' };
    if (frozenEffect.scope !== 'host-exec') return { problem: "frozenEffect.scope must be 'host-exec'" };
    if (frozenEffect.elevation !== 'user' && frozenEffect.elevation !== 'admin') return { problem: "frozenEffect.elevation must be 'user'|'admin'" };
    if (typeof frozenEffect.action !== 'string' || !frozenEffect.action) return { problem: 'action required' };
    if (!/^[0-9a-f]{64}$/.test(frozenEffect.commandDigest ?? '')) return { problem: 'commandDigest (approved executable bytes sha256) required' };
    if (frozenEffect.cwdIdentity != null && (typeof frozenEffect.cwdIdentity.dev !== 'number' || typeof frozenEffect.cwdIdentity.ino !== 'number')) return { problem: 'cwdIdentity must be {dev,ino}(,birth)' };
    return { exec };
  };

  const execTarget = frozenEffect => frozenEffect.resolvedCommand ?? frozenEffect.command;

  // —— user 作用域：node 助手 + 继承 fd 控制通道（命令无法伪造，不经文件）——
  const runUserExecution = async ({ execution, files, interpreter, timeoutMs }) => {
    const helperArgs = ['--manifest', files.manifestPath, '--expect-digest', files.digest, '--proof', files.proofPath, '--control-fd', '3'];
    const run = new ChildRun({ command: interpreter.path, args: [helperPath, ...helperArgs], env: childEnvFor(interpreter, { HOME: os.homedir(), TMPDIR: files.dir }), extraFd: true });
    execution.run = run;
    if (execution.cancelRequested) { run.kill(); return { run, controlText: '' }; }
    const exit = await run.waitOrWatchdog(timeoutMs, MECHANISM_OVERHEAD_MS);
    return { exit, run, controlText: run.controlText?.text() ?? '' };
  };

  // —— admin 作用域：逐平台机制 producer ——
  const adminInvocationParts = ({ mechanismPath, trustedPython, files, frozenEffect, timeoutMs, maxOutputBytes, identity }) => {
    if (platform === 'linux') {
      return buildMechanismInvocation({ platform, mechanismPath, interpreter: trustedPython.path, admin: { enabled: true, pythonCode: options.pythonCode, manifestPath: files.manifestPath, expectDigest: files.digest, timeoutMs, outMax: maxOutputBytes, identity } });
    }
    if (platform === 'darwin') {
      return buildMechanismInvocation({
        platform, mechanismPath, interpreter: mechanismPath,
        admin: { enabled: true, identity, command: frozenEffect ? execTarget(frozenEffect) : null, args: frozenEffect?.args ?? [], cwd: frozenEffect?.cwd, commandDigest: frozenEffect?.commandDigest, effectHash: files.effectHash, timeoutMs },
        prompt: `Nozeli 特权执行：${String(frozenEffect?.action ?? '身份验证').slice(0, 120)}`,
      });
    }
    return buildMechanismInvocation({
      platform, mechanismPath, interpreter: mechanismPath,
      admin: { enabled: true, identity, command: frozenEffect ? execTarget(frozenEffect) : null, args: frozenEffect?.args ?? [], cwd: frozenEffect?.cwd, commandDigest: frozenEffect?.commandDigest, receiptPath: files.receiptPath, effectHash: files.effectHash, timeoutMs },
      prompt: `Nozeli 特权执行：${String(frozenEffect?.action ?? '身份验证').slice(0, 120)}`,
    });
  };
  const runAdminExecution = async ({ execution, mechanismPath, trustedPython, files, frozenEffect, timeoutMs, maxOutputBytes, identity = false, effectHash }) => {
    const invocation = adminInvocationParts({ mechanismPath, trustedPython, files, frozenEffect, timeoutMs, maxOutputBytes, identity, effectHash });
    const adminEnv=platform==='win32'?{SystemRoot:env.SystemRoot??'C:\\Windows',WINDIR:env.SystemRoot??'C:\\Windows',PATH:path.win32.join(env.SystemRoot??'C:\\Windows','System32'),TEMP:env.TEMP??os.tmpdir(),TMP:env.TMP??os.tmpdir()}:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin'};
    const run = new ChildRun({ command: invocation.command, args: invocation.args, env: adminEnv });
    execution.run = run;
    if (execution.cancelRequested) { run.kill(); return { run, stdoutText: '' }; }
    const exit = await run.waitOrWatchdog(timeoutMs + MECHANISM_OVERHEAD_MS);
    return { exit, run, stdoutText: run.stdout.text() };
  };

  const prepareRunFiles = async ({ requestId, grantId, effectHash, frozenEffect, scope, timeoutMs, maxOutputBytes, interpreter, dir }) => {
    const manifest = {
      v: 1, requestId, grantId, effectHash, scope, elevation: frozenEffect.elevation,
      command: execTarget(frozenEffect), args: frozenEffect.args, cwd: frozenEffect.cwd, action: frozenEffect.action,
      commandDigest: frozenEffect.commandDigest,
      ...(frozenEffect.cwdIdentity ? { cwdIdentity: frozenEffect.cwdIdentity } : {}),
      frozen: frozenEffect,
      timeoutMs, maxOutputBytes,
      pins: {
        helper: { path: helperPath, sha256: await helperDigest() },
        interpreter: { path: interpreter.path, sha256: interpreter.sha256 },
        command: { path: execTarget(frozenEffect), sha256: frozenEffect.commandDigest },
      },
    };
    const manifestPath = path.join(dir, 'manifest.json');
    const proofPath = path.join(dir, 'proof.secret');
    const controlPath = path.join(dir, 'control.jsonl');
    const receiptPath = path.join(dir, 'receipt.json');
    const secret = randomBytes(48).toString('hex');
    await fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await fs.writeFile(proofPath, secret, { mode: 0o600 });
    const digest = createHash('sha256').update(await fs.readFile(manifestPath)).digest('hex');
    return { manifest, manifestPath, digest, secret, proofPath, controlPath, receiptPath, dir, effectHash };
  };

  // admin 结果消费（逐平台）。返回 {status, exitCode?, actualIdentity?, output?, error?}。
  const consumeAdminOutcome = async ({ exit, run, stdoutText, frozenEffect, effectHash }) => {
    const stderrText = run.stderr.text();
    const frames = parseAdminFrames(stdoutText);
    const commonFail = (code, message, extra = {}) => ({ status: 'failed', error: { code, message }, ...extra });
    if (run.killed) return { status: 'unknown', killed: true };
    if (stderrText.includes('NOZELI_ADMIN_NOT_ELEVATED') || exit.code === 7) return commonFail('NOT_ELEVATED', 'admin 作用域未获得真实提权身份，已拒绝执行');
    if (platform === 'win32') {
      if (strategy.cancellationExitCodes.includes(exit.code)) return { status: 'cancelled' };
      const frame = stdoutText.match(/^NOZELI_WIN_RECEIPT ([A-Za-z0-9+/=]+)$/m);
      let receipt;
      try { receipt = JSON.parse(Buffer.from(frame?.[1] ?? '', 'base64').toString('utf8')); } catch {}
      if (!receipt || receipt.admin !== true || receipt.effectHash !== effectHash || receipt.commandDigest !== frozenEffect.commandDigest || receipt.phase !== 'post') return {status:'unknown',error:{code:'CONTROL_UNVERIFIED',message:'系统授权后的执行回执缺失或不匹配；不自动重放'}};
      const actualIdentity = {platform,user:receipt.user,admin:true,channel:'administrator-owned-acl'};
      return {status:receipt.timedOut?'unknown':'completed',exitCode:receipt.exitCode,actualIdentity,output:{stdoutB64:receipt.stdoutB64??'',stderrB64:receipt.stderrB64??''}};
    }
    if (!frames.dir) {
      if (strategy.cancellationExitCodes.includes(exit.code) || /User canceled|user canceled|-128/i.test(stderrText)) return { status: 'cancelled' };
      if (exit.code === 3 || /NOZELI_ADMIN_PY_FAIL (3|23|25)/.test(stderrText) || stderrText.includes('NOZELI_ADMIN_TAMPER')) return commonFail('EFFECT_TAMPERED', '批准内容与实际执行对象不符（digest/身份校验失败），未执行');
      if (exit.code === 127) return { status: 'unavailable', error: { code: 'MECHANISM_TARGET_MISSING', message: `机制无法启动目标进程：${stderrText.slice(0, 300)}` } };
      return commonFail('EXECUTION_FAILED', `机制 exit=${exit.code ?? exit.signal}；${stderrText.slice(0, 300)}`);
    }
    const results = await readRootResults(frames.dir, ['control.jsonl', 'receipt.json']);
    if (!results) return commonFail('CONTROL_UNVERIFIED', '结果目录/文件非 root-owned（O_NOFOLLOW/目录绑定核验失败），拒绝采信');
    const records = results['control.jsonl'] ? parseControlLines(results['control.jsonl']) : [];
    const receiptPayload = results['receipt.json'] ? (() => { try { return JSON.parse(results['receipt.json']); } catch { return null; } })() : null;
    const pre = records.find(record => record.phase === 'pre');
    const post = records.find(record => record.phase === 'post');
    const identity = pre?.identity ?? pre;
    if (!pre || identity?.root !== true || identity.euid !== 0 || identity.uid !== 0) return commonFail('CONTROL_UNVERIFIED', '控制记录缺失或未证明真实 root 身份');
    if (pre.effectHash !== undefined && pre.effectHash !== effectHash) return commonFail('EFFECT_TAMPERED', '控制记录与批准效果不符，拒绝采信');
    if (pre.commandDigest !== undefined && pre.commandDigest !== frozenEffect.commandDigest) return commonFail('EFFECT_TAMPERED', '控制记录与批准 digest 不符，拒绝采信');
    const actualIdentity = {
      platform, uid: identity.uid, euid: identity.euid, gid: identity.gid ?? null, egid: identity.egid ?? null,
      root: true, channel: 'root-owned-file',
    };
    const output = receiptPayload || post ? {
      stdoutB64: frames.outB64 ?? '', stderrB64: frames.errB64 ?? '',
      stdoutBytes: receiptPayload?.stdoutBytes ?? null, stderrBytes: receiptPayload?.stderrBytes ?? null,
      truncated: receiptPayload?.truncated ?? false,
    } : undefined;
    if (receiptPayload && post) {
      if (receiptPayload.spawnError) return commonFail('SPAWN_FAILED', `命令未能启动：${receiptPayload.spawnError}`, { actualIdentity, output });
      if (receiptPayload.timedOut || receiptPayload.descendantsKilled) return { status: 'unknown', actualIdentity, output };
      return { status: 'completed', exitCode: receiptPayload.exitCode, actualIdentity, output };
    }
    // pre 已公布但无 post：发射后中断 → 结果未知（绝不报“未执行”/可重试）。
    return { status: 'unknown', actualIdentity, output };
  };

  const authenticate = async request => {
    const { requestId, effectHash: requestedHash = null, grantId, generation = null, expiresAt = null, elevation } = request ?? {};
    if (elevation !== 'user' && elevation !== 'admin') return { status: 'failed', error: { code: 'ELEVATION_INVALID', message: "elevation 必须是 'user'|'admin'" } };
    if (typeof grantId !== 'string' || !grantId) return { status: 'failed', error: { code: 'GRANT_INVALID', message: 'grantId required' } };
    try { assertGrantLive(grantId); } catch (error) { return { status: 'failed', error: { code: error.code, message: error.message } }; }
    if (elevation === 'user') {
      let interpreter;
      try { interpreter = await interpreterReady(); } catch (error) { return { status: 'unavailable', error: { code: 'INTERPRETER_UNAVAILABLE', message: error.message } }; }
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-priv-'));
      try {
        await fs.chmod(dir, 0o700);
        const secret = randomBytes(48).toString('hex');
        const proofPath = path.join(dir, 'proof.secret');
        await fs.writeFile(proofPath, secret, { mode: 0o600 });
        const run = new ChildRun({ command: interpreter.path, args: [helperPath, '--identity', '--proof', proofPath, '--control-fd', '3'], env: childEnvFor(interpreter), extraFd: true });
        const exit = await run.waitOrWatchdog(30_000, 5000);
        const records = parseControlLines(run.controlText?.text() ?? '');
        const identityRecord = records.find(record => validControl(record, secret, 'identity'));
        if (identityRecord && exit.code === 0 && !exit.grace) {
          const sessionId = randomUUID();
          sessions.set(sessionId, { sessionId, grantId, generation, scope: 'user', effectHash: requestedHash, expiresAt, createdAt: now(), lastUsedAt: now(), revoked: false });
          return { status: 'authenticated', sessionId, actualIdentity: { ...identityRecord.identity, channel: 'inherited-fd' } };
        }
        return { status: 'failed', error: { code: 'IDENTITY_PROBE_FAILED', message: `exit=${exit.code ?? exit.signal} ${run.stderr.text().slice(0, 300)}` } };
      } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
    }
    const mechanismPath = await resolveMechanism();
    if (!mechanismPath) return { status: 'unavailable', error: { code: 'MECHANISM_UNAVAILABLE', message: `未找到提权机制 ${strategy.executable}` } };
    const trustedPython = await resolveTrustedPython();
    if (!trustedPython.trusted) return { status: 'unavailable', error: { code: 'TRUSTED_INTERPRETER_UNAVAILABLE', message: `系统提权解释器不可信：${trustedPython.reason}` } };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-priv-'));
    try {
      await fs.chmod(dir, 0o700);
      const files = { manifestPath: path.join(dir, 'identity'), digest: '', receiptPath: path.join(dir, 'admin-receipt.json'), dir, effectHash: requestedHash };
      const execution = { run: null, scope: 'admin', grantId, sessionId: null, stage: 'preparing', requestId, cancelRequested: false, startedMs: now() };
      const { exit, run, stdoutText } = await runAdminExecution({ execution, mechanismPath, trustedPython, files, frozenEffect: null, identity: true, timeoutMs: 30_000, maxOutputBytes: 0 });
      const stderrText = run.stderr.text();
      if (run.killed && !parseAdminFrames(stdoutText).dir) return { status: 'cancelled' };
      if (stderrText.includes('NOZELI_ADMIN_NOT_ELEVATED') || exit.code === 7) return { status: 'failed', error: { code: 'NOT_ELEVATED', message: '系统机制未产生真实提权身份，拒绝认证' } };
      if (platform === 'win32') {
        const frame = stdoutText.match(/^NOZELI_WIN_RECEIPT ([A-Za-z0-9+/=]+)$/m);
        let receipt; try { receipt=JSON.parse(Buffer.from(frame?.[1]??'', 'base64').toString('utf8')); } catch {}
        if (!receipt || receipt.admin!==true || receipt.phase!=='identity') return {status:strategy.cancellationExitCodes.includes(exit.code)?'cancelled':'failed',error:{code:'IDENTITY_PROBE_FAILED',message:'UAC身份回执缺失或未通过管理员ACL校验'}};
        assertGrantLive(grantId);
        const sessionId=randomUUID();
        sessions.set(sessionId,{sessionId,grantId,generation,scope:'admin',effectHash:requestedHash,expiresAt,createdAt:now(),lastUsedAt:now(),revoked:false});
        return {status:'authenticated',sessionId,actualIdentity:{platform,user:receipt.user,admin:true,channel:'administrator-owned-acl'}};
      }
      const dirPath = parseAdminFrames(stdoutText).dir;
      if (!dirPath) {
        if (strategy.cancellationExitCodes.includes(exit.code) || /User canceled|user canceled|-128/i.test(stderrText)) return { status: 'cancelled' };
        if (stderrText.includes('ENOENT')) return { status: 'unavailable', error: { code: 'MECHANISM_UNAVAILABLE', message: stderrText.slice(0, 300) } };
        return { status: 'failed', error: { code: 'IDENTITY_PROBE_FAILED', message: `exit=${exit.code ?? exit.signal} ${stderrText.slice(0, 300)}` } };
      }
      const results = await readRootResults(dirPath, ['control.jsonl']);
      const records = results?.['control.jsonl'] ? parseControlLines(results['control.jsonl']) : null;
      const identityRecord = records?.find(record => record.phase === 'identity');
      const identityFromRecord = identityRecord?.identity ?? (platform === 'darwin' ? identityRecord : null);
      if (!results || !identityRecord || !identityFromRecord?.root) {
        return { status: 'failed', error: { code: results ? 'NOT_ELEVATED' : 'CONTROL_UNVERIFIED', message: results ? '未获得真实提权身份' : '控制通道非 root-owned，拒绝认证' } };
      }
      const sessionId = randomUUID();
      sessions.set(sessionId, { sessionId, grantId, generation, scope: 'admin', effectHash: requestedHash, expiresAt, createdAt: now(), lastUsedAt: now(), revoked: false });
      return { status: 'authenticated', sessionId, actualIdentity: { ...identityFromRecord, channel: 'root-owned-file' } };
    } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  };

  const execute = async ({ requestId, effectHash, grantId, sessionId = null, frozenEffect }) => {
    const executionId = randomUUID();
    const startedMs = now();
    const execution = { run: null, scope: null, grantId, sessionId, stage: 'validating', requestId, cancelRequested: false, startedMs };
    executions.set(executionId, execution); // 立即注册并绑定 grant/session：撤销只影响对应执行
    const remember = receipt => rememberReceipt({ executionId, requestId, grantId, startedMs, endedMs: now(), ...receipt });
    const fail = (status, code, message, extra = {}) => {
      const receiptId = remember({ status, error: { code, message }, executed: false, ...extra });
      return { executionId, status, error: { code, message }, receiptId, executed: false, ...extra };
    };
    try {
      const validated = validateFrozenEffect(frozenEffect);
      if (validated.problem) return fail('failed', 'EFFECT_INVALID', validated.problem);
      if (typeof effectHash !== 'string' || effectHash !== effectHashFn(frozenEffect)) return fail('failed', 'EFFECT_HASH_MISMATCH', 'effectHash 与冻结效果不符（共享哈希算法，全字段）');
      try { assertGrantLive(grantId); } catch (error) { return fail('failed', error.code, error.message); }
      let scope = 'user';
      try {
        if (sessionId) {
          const session = sessionFor({ sessionId, grantId, generation: null });
          scope = session.scope; session.lastUsedAt = now();
        } else scope = frozenEffect.elevation;
        if (sessionId && scope !== frozenEffect.elevation) return fail('failed', 'ELEVATION_MISMATCH', `会话作用域 ${scope} 与冻结效果 ${frozenEffect.elevation} 不一致`);
      } catch (error) { return fail('failed', error.code, error.message); }
      execution.scope = scope;

      const exec = validated.exec;
      // 批准即冻结：执行前重读执行目标字节与 cwd 身份，≠批准值 → 拒绝（需重新批准）。
      const currentDigest = await sha256File(exec).catch(() => null);
      if (currentDigest !== frozenEffect.commandDigest) return fail('failed', 'EFFECT_CHANGED', `执行目标自批准后已变化（当前 ${currentDigest ?? '不可读'}），需重新批准`);
      if (frozenEffect.cwdIdentity) {
        const cwdStat = await fs.stat(frozenEffect.cwd).catch(() => null);
        if (!cwdStat || cwdStat.dev !== frozenEffect.cwdIdentity.dev || cwdStat.ino !== frozenEffect.cwdIdentity.ino) return fail('failed', 'EFFECT_CHANGED', 'cwd 身份（dev/ino）与批准时不符，需重新批准');
      }

      if (scope === 'admin') {
        const mechanismPath = await resolveMechanism();
        if (!mechanismPath) return fail('unavailable', 'MECHANISM_UNAVAILABLE', `未找到提权机制 ${strategy.executable}；不伪称可用`);
        const trustedPython = await resolveTrustedPython();
        if (!trustedPython.trusted) return fail('unavailable', 'TRUSTED_INTERPRETER_UNAVAILABLE', `系统提权解释器不可信：${trustedPython.reason}；不降级用用户可写解释器`);
      } else {
        try { await interpreterReady(); } catch (error) { return fail('unavailable', 'INTERPRETER_UNAVAILABLE', error.message); }
      }

      const timeoutMs = Math.min(Math.max(Number(frozenEffect.timeoutMs ?? 60_000), 1000), 600_000);
      const maxOutputBytes = Math.min(Math.max(Number(frozenEffect.maxOutputBytes ?? defaultMaxOutput), 1024), 1024 * 1024);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-priv-'));
      execution.stage = 'preparing';
      try {
        await fs.chmod(dir, 0o700);
        const interpreter = scope === 'admin' ? { path: '(platform-mechanism)', sha256: '' } : await interpreterReady();
        const files = await prepareRunFiles({ requestId, grantId, effectHash, frozenEffect, scope, timeoutMs, maxOutputBytes, interpreter, dir });
        if (options.onPrepared) await options.onPrepared({ dir, manifest: files.manifest, manifestPath: files.manifestPath });
        try { assertGrantLive(grantId); if (sessionId) sessionFor({ sessionId, grantId, generation: null }); } catch (error) { return fail('failed', error.code, `${error.message}（临发射重验）`); }
        if (execution.cancelRequested) return fail('cancelled', 'CANCELLED_BEFORE_LAUNCH', '撤销发生在准备期，未发射');
        execution.stage = 'launched';

        if (scope === 'user') {
          const { exit, run, controlText } = await runUserExecution({ execution, files, interpreter, timeoutMs });
          const records = parseControlLines(controlText);
          const pre = records.find(record => validControl(record, files.secret, 'pre'));
          const post = records.find(record => validControl(record, files.secret, 'post'));
          const abort = records.find(record => validControl(record, files.secret, 'abort'));
          const receiptPayload = parseReceiptLine(run.stdout.text());
          const actualIdentity = (post ?? pre ?? abort)?.identity ?? null;
          const common = () => ({
            actualIdentity: actualIdentity && { ...actualIdentity, channel: 'inherited-fd' },
            output: receiptPayload ? { stdoutB64: receiptPayload.stdoutB64, stderrB64: receiptPayload.stderrB64, stdoutBytes: receiptPayload.stdoutBytes, stderrBytes: receiptPayload.stderrBytes, truncated: receiptPayload.truncated } : undefined,
          });
          if (run.killed) {
            const status = run.killFailed || exit?.grace || (pre && !post) ? 'unknown' : 'cancelled';
            const receiptId = remember({ status, scope, killed: true, killFailed: run.killFailed, controlPhases: records.map(record => record.phase), ...common() });
            return { executionId, status, receiptId, ...common() };
          }
          if (abort?.reason === 'not-elevated') return fail('failed', 'NOT_ELEVATED', '助手报告未提权，已拒绝执行', { ...common() });
          if (receiptPayload && post && receiptPayload.effectHash === effectHash) {
            if (receiptPayload.spawnError) return fail('failed', 'SPAWN_FAILED', `命令未能启动：${receiptPayload.spawnError}`, { ...common() });
            const status = receiptPayload.timedOut ? 'unknown' : 'completed';
            const receiptId = remember({ status, scope, exitCode: receiptPayload.exitCode, signal: receiptPayload.signal, controlPhases: receiptPayload.controlPhases, ...common() });
            return { executionId, status, ...(receiptPayload.exitCode != null ? { exitCode: receiptPayload.exitCode } : {}), receiptId, ...common() };
          }
          const stderrText = run.stderr.text();
          if (!records.length) {
            if (exit.code === 3) return fail('failed', 'EFFECT_TAMPERED', 'manifest/pin 校验失败，判定篡改，未执行任何命令');
            return fail('failed', 'EXECUTION_FAILED', `helper exit=${exit.code ?? exit.signal}；无控制记录。${stderrText.slice(0, 300)}`);
          }
          if (pre && !post) {
            const receiptId = remember({ status: 'unknown', scope, exitCode: exit.code ?? null, signal: exit.signal ?? null, controlPhases: records.map(record => record.phase), ...common() });
            return { executionId, status: 'unknown', receiptId, ...common() };
          }
          const tampered = exit.code === 3;
          return fail('failed', tampered ? 'EFFECT_TAMPERED' : 'EXECUTION_FAILED', tampered ? 'manifest/pin 校验失败，判定篡改，未执行' : `helper exit=${exit.code ?? exit.signal}；${stderrText.slice(0, 300)}`, { ...common() });
        }

        // admin：逐平台 producer + 统一消费
        const mechanismPath = await resolveMechanism();
        const trustedPython = await resolveTrustedPython();
        const { exit, run, stdoutText } = await runAdminExecution({ execution, mechanismPath, trustedPython, files, frozenEffect, timeoutMs, maxOutputBytes, effectHash });
        const outcome = await consumeAdminOutcome({ exit, run, stdoutText, frozenEffect, effectHash });
        const receiptId = remember({ ...outcome, scope });
        return { executionId, status: outcome.status, ...(outcome.exitCode != null ? { exitCode: outcome.exitCode } : {}), ...(outcome.actualIdentity ? { actualIdentity: outcome.actualIdentity } : {}), ...(outcome.output ? { output: outcome.output } : {}), ...(outcome.error ? { error: outcome.error } : {}), receiptId };
      } finally {
        executions.delete(executionId);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      // 发射后的异常：不能证明未执行 → unknown（不可当作安全重试的失败）。
      if (execution.stage === 'launched') {
        const receiptId = remember({ status: 'unknown', scope: execution.scope, error: { code: error.code ?? 'BROKER_INTERNAL', message: error.message ?? String(error) }, executed: 'unknown' });
        return { executionId, status: 'unknown', receiptId };
      }
      return fail('failed', error.code ?? 'BROKER_INTERNAL', error.message ?? String(error));
    } finally {
      executions.delete(executionId);
    }
  };

  return {
    effectHash: effectHashFn,
    computeEffectHash: effectHashFn,
    async capabilities() {
      const interpreter = await resolveInterpreter();
      const mechanismPath = await resolveMechanism();
      const trustedPython = await resolveTrustedPython();
      const missingDeps = [];
      for (const dep of strategy.deps) if (!await findExecutable(dep)) missingDeps.push(dep);
      const elevationAvailable = !interpreter.error && Boolean(mechanismPath) && (platform === 'linux' ? trustedPython.trusted : true) && !missingDeps.length;
      return {
        platform,
        authMethod: strategy.authMethod,
        currentIdentity: currentIdentity(),
        elevationAvailable,
        reason: interpreter.error ? `解释器不可用：${interpreter.error}`
          : !mechanismPath ? `未找到提权机制 ${strategy.executable}`
          : (platform === 'linux' && !trustedPython.trusted) ? `提权解释器不可信：${trustedPython.reason}`
          : missingDeps.length ? `机制依赖缺失：${missingDeps.join(', ')}`
          : undefined,
        interpreter: interpreter.error ? null : { kind: interpreter.kind, path: interpreter.path, sha256: interpreter.sha256, electronAsNode: interpreter.electronAsNode, scope: 'user' },
        adminInterpreter: platform === 'linux' ? { path: trustedPython.path, trusted: trustedPython.trusted } : null,
        mechanism: mechanismPath ? { path: mechanismPath } : null,
        // 每次经 OS 提权机制启动；OS 决定是否提示；不声称每次密码验证。sessionId 只是宿主准入状态，
        // 不是 OS 凭据；capabilities 永不作为 root 证明——root 身份只以逐次执行的
        // actualIdentity（root-owned 通道）为准。
        osAuthPerLaunch: true,
        platformVerification: PLATFORM_VERIFICATION[platform],
        resultChannel: RESULT_CHANNEL[platform],
        trustModel: 'root 作用域信任被批准命令本身（完整 root grant 不防御恶意 root 命令）；保证非 root 伪造不可通过：root-owned 0711 事实目录（仅非敏感内容）+ 数值 flags O_NOFOLLOW/目录 fd 绑定读取 + 命令输出走机制独占 stdout 管道分帧 + 批准 digest 的 root 端只读快照执行。',
        scopes: ['user', 'admin'],
        maxOutputBytes: defaultMaxOutput,
      };
    },
    authenticate,
    execute,
    revoke({ grantId = null, sessionId = null, all = false } = {}) {
      const matches = execution => (grantId && execution.grantId === grantId) || (sessionId && execution.sessionId === sessionId);
      if (all) {
        for (const session of sessions.values()) session.revoked = true;
        for (const grant of grants.values()) grant.revoked = true;
        for (const execution of executions.values()) { execution.cancelRequested = true; execution.run?.kill(); }
        return { revoked: 'all' };
      }
      if (grantId) {
        const grant = grants.get(grantId) ?? { revoked: false, seenAt: now() };
        grant.revoked = true;
        grants.set(grantId, grant);
        for (const session of sessions.values()) if (session.grantId === grantId) session.revoked = true;
        // 只终止绑定该 grant 的执行；不动其他任务已批准的操作。
        for (const execution of executions.values()) if (matches(execution)) { execution.cancelRequested = true; execution.run?.kill(); }
      }
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          session.revoked = true;
          for (const execution of executions.values()) if (execution.sessionId === sessionId) { execution.cancelRequested = true; execution.run?.kill(); }
        }
      }
      return { revoked: { grantId, sessionId } };
    },
    async cancel(executionId) {
      const execution = executions.get(executionId);
      if (!execution) return { executionId, cancelled: false, reason: 'not-running' };
      execution.cancelRequested = true;
      const killed = execution.run ? execution.run.kill() : true;
      // admin 目标可能无法被普通 uid 终止：不能证明停止，调用方按 unknown 处理。
      return { executionId, cancelled: true, killConfirmed: killed };
    },
    runningExecutions() { return [...executions.entries()].map(([executionId, execution]) => ({ executionId, requestId: execution.requestId, grantId: execution.grantId, scope: execution.scope, stage: execution.stage, startedMs: execution.startedMs, preparing: !execution.run })); },
    getReceipt(receiptId) { return receipts.get(receiptId) ?? null; },
    listReceipts() { return [...receipts.keys()]; },
  };
}
