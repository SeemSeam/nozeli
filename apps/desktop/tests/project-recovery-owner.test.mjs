import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {assertRecoverySourceStopped as linuxAssert} from '../src/main/project-recovery-owner.mjs';
import * as linuxRecoveryOwner from '../src/platform/linux/recovery-owner.mjs';

// The wrapper's capability selector picks the host platform's adapter, so on
// macOS these /proc fixtures would never reach the Linux algorithm under test.
// Inject the linux selection explicitly (the same shape selectCapability
// returns on Linux) instead of mocking the selector.
const assertRecoverySourceStopped=root=>linuxAssert(root,{selection:{state:'available',platform:'linux',implementation:linuxRecoveryOwner}});

// Synthetic /proc reads only: no live account, project or process is changed.
function probe(t,{args=['/usr/lib/systemd/systemd','--user'],cmdError,exeError='EACCES',exe='/fixture/nozeli',changed=false,stoppedAfterExe=false,parentArgs=['/usr/lib/systemd/systemd','--user'],parentChanged=false,parentUid=process.getuid(),parentExe='/fixture/nozeli',parentExeError,fdError='EACCES'}={}){
 const pid=process.pid+1000000,parent=pid+1;let stamps=0,parentStamps=0,exeReads=0,fdReads=0;
 t.mock.method(fs,'readdir',async directory=>{if(directory==='/proc')return [String(pid)];assert.equal(directory,`/proc/${pid}/fd`);fdReads++;if(fdError)throw Object.assign(Error('synthetic inaccessible fd directory'),{code:fdError});return [];});
 t.mock.method(fs,'stat',async file=>{assert(['/proc/'+pid,'/proc/'+parent].includes(file));return {uid:file==='/proc/'+parent?parentUid:process.getuid()};});
 t.mock.method(fs,'readlink',async file=>{
  if(file==='/proc/self/exe')return '/fixture/nozeli';
  if(file===`/proc/${parent}/exe`){if(parentExeError)throw Object.assign(Error('synthetic inaccessible parent executable'),{code:parentExeError});return parentExe;}
  assert.equal(file,`/proc/${pid}/exe`);exeReads++;if(exeError)throw Object.assign(Error('synthetic inaccessible executable'),{code:exeError});return exe;
 });
 t.mock.method(fs,'readFile',async file=>{
  if(file==='/proc/sys/kernel/random/boot_id')return 'synthetic-boot\n';
  if(file===`/proc/${pid}/stat`||file===`/proc/${parent}/stat`){const parts=Array(20).fill('0');parts[0]=stoppedAfterExe&&exeReads&&file===`/proc/${pid}/stat`?'Z':'S';parts[1]=String(parent);parts[19]=String(file===`/proc/${parent}/stat`?(parentChanged&&parentStamps++?'224':'223'):(changed&&stamps++?'124':'123'));return `${pid} (synthetic process) ${parts.join(' ')}`;}
  if(file===`/proc/${pid}/cmdline`){if(cmdError)throw Object.assign(Error('synthetic inaccessible command'),{code:cmdError});return Buffer.from(args.join('\0')+'\0');}
  if(file===`/proc/${parent}/cmdline`)return Buffer.from(parentArgs.join('\0')+'\0');
  if(file===`/proc/${pid}/environ`)throw Object.assign(Error('synthetic inaccessible environment'),{code:'EACCES'});
  throw Error('Unexpected probe read '+file);
 });
 return {exeReads:()=>exeReads,fdReads:()=>fdReads};
}

test('fixed system manager full argv is excluded without reading its inaccessible executable',async t=>{
 const p=probe(t);await assertRecoverySourceStopped('/synthetic/project');assert.equal(p.exeReads(),0);
});
for(const [name,args] of [
 ['basename only',['systemd','--user']],
 ['unrecognized path',['/tmp/systemd','--user']],
 ['extra application argument',['/usr/lib/systemd/systemd','--user','/fixture/nozeli']],
 ['different system manager mode',['/usr/lib/systemd/systemd','--system']],
 ['Electron executable',['/fixture/electron','/fixture/nozeli']],
 ['empty command line',[]],
])test(name+' remains fail-closed when executable cannot be verified',async t=>{
 const p=probe(t,{args});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});assert.equal(p.exeReads(),1);
});

test('unreadable command line remains fail-closed',async t=>{
 const p=probe(t,{cmdError:'EACCES'});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});assert.equal(p.exeReads(),0);
});
test('PID stamp change invalidates even an otherwise fixed unrelated argv',async t=>{
 probe(t,{changed:true});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});
});
test('a related executable with an unreadable fd directory is not ignored',async t=>{
 const p=probe(t,{args:['/fixture/nozeli'],exeError:null});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});assert.equal(p.exeReads(),1);
});

const fixedServices=[
 ['SSH agent',['/usr/bin/ssh-agent','-D']],
 ['KDE policy agent',['/usr/lib/x86_64-linux-gnu/libexec/polkit-kde-authentication-agent-1']],
 ['KDE power service',['/usr/lib/x86_64-linux-gnu/libexec/org_kde_powerdevil']],
 ['Wayland compositor',['/usr/bin/kwin_wayland','--wayland-fd','7','--socket','wayland-0','--xwayland-fd','8','--xwayland-fd','9','--xwayland-display',':0','--xwayland-xauthority',`/run/user/${process.getuid()}/xauth_fixture`,'--xwayland']],
 ['system manager PAM child',['(sd-pam)']],
];
for(const [name,args] of fixedServices){
 test(name+' exact launch is excluded without reading exe',async t=>{const p=probe(t,{args});await assertRecoverySourceStopped('/synthetic/project');assert.equal(p.exeReads(),0);});
 for(const extra of ['','/fixture/nozeli'])test(name+' rejects an additional '+(extra?'app argument':'empty argument'),async t=>{probe(t,{args:[...args,extra]});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});});
}
test('PAM process with a non-systemd parent remains fail-closed',async t=>{probe(t,{args:['(sd-pam)'],parentArgs:['/fixture/nozeli']});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});});
test('PAM process with a changed parent identity remains fail-closed',async t=>{probe(t,{args:['(sd-pam)'],parentChanged:true});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});});
test('PAM process with a different uid parent remains fail-closed',async t=>{probe(t,{args:['(sd-pam)'],parentUid:process.getuid()+1});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});});
test('compositor with an arbitrary authority path remains fail-closed',async t=>{const args=[...fixedServices[3][1]];args[12]='/tmp/user-project';probe(t,{args});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});});

test('a related main without catalog handles never guesses the default profile',async t=>{const p=probe(t,{args:['/fixture/nozeli'],exeError:null,fdError:null});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});assert.equal(p.fdReads(),1);});
for(const type of ['zygote','renderer','gpu-process','utility','broker'])test('exact merged Chromium '+type+' child does not require a main catalog',async t=>{const p=probe(t,{args:[`/fixture/nozeli --type=${type} --synthetic`],exeError:null});await assertRecoverySourceStopped('/synthetic/project');assert.equal(p.fdReads(),0);});
for(const title of ['/fixture/nozeli /tmp/--type=renderer --synthetic','/fixture/nozeli --type=unknown --synthetic','/other/executable --type=renderer'])test('ambiguous process title is not classified as Chromium child: '+title,async t=>{probe(t,{args:[title],exeError:null,fdError:null});await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});});

for(const type of ['zygote','renderer','gpu-process','utility','broker']){
 for(const merged of [false,true])test('non-dumpable Chromium '+type+' requires exact executable parent provenance'+(merged?' (merged title)':''),async t=>{
  const args=merged?[`/fixture/nozeli --type=${type} --synthetic`]:['/fixture/nozeli',`--type=${type}`,'--synthetic'];
  const p=probe(t,{args});await assertRecoverySourceStopped('/synthetic/project');assert.equal(p.exeReads(),1);assert.equal(p.fdReads(),0);
 });
 test('non-dumpable Chromium '+type+' accepts only empty argv padding after merged title',async t=>{
  probe(t,{args:[`/fixture/nozeli --type=${type} --synthetic`,'','']});await assertRecoverySourceStopped('/synthetic/project');
 });
}
for(const [name,options] of [
 ['different executable parent',{parentExe:'/other/nozeli'}],
 ['unreadable unknown parent',{parentExeError:'EACCES'}],
 ['different uid parent',{parentUid:process.getuid()+1}],
 ['changed parent incarnation',{parentChanged:true}],
 ['changed child incarnation',{changed:true}],
 ['unknown child type',{args:['/fixture/nozeli','--type=unknown']}],
 ['type flag after application argument',{args:['/fixture/nozeli','/project/main.cjs','--type=renderer']}],
 ['basename-only executable',{args:['nozeli','--type=renderer']}],
 ['main without child type',{args:['/fixture/nozeli']}],
 ['merged title followed by real application argument',{args:['/fixture/nozeli --type=renderer','/project/main.cjs']}],
])test('inaccessible Chromium candidate fails closed: '+name,async t=>{
 probe(t,{args:['/fixture/nozeli','--type=zygote'],...options});
 await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});
});
test('EACCES followed by a kernel-confirmed zombie is stopped, not an unknown live owner',async t=>{
 const p=probe(t,{args:['/unknown/application'],stoppedAfterExe:true});await assertRecoverySourceStopped('/synthetic/project');assert.equal(p.exeReads(),1);
});

for(const changed of [false,true])test('non-dumpable renderer through non-dumpable zygote '+(changed?'rejects changed main identity':'reaches verified main identity'),async t=>{
 const renderer=process.pid+1000000,zygote=renderer+1,main=renderer+2,exe='/fixture/nozeli';let mainStamps=0;
 t.mock.method(fs,'readdir',async directory=>{assert.equal(directory,'/proc');return [String(renderer)];});
 t.mock.method(fs,'stat',async file=>{assert([renderer,zygote,main].some(pid=>file===`/proc/${pid}`));return {uid:process.getuid()};});
 t.mock.method(fs,'readlink',async file=>{
  if(file==='/proc/self/exe'||file===`/proc/${main}/exe`)return exe;
  assert([renderer,zygote].some(pid=>file===`/proc/${pid}/exe`));throw Object.assign(Error('non-dumpable Chromium child'),{code:'EACCES'});
 });
 t.mock.method(fs,'readFile',async file=>{
  if(file==='/proc/sys/kernel/random/boot_id')return 'synthetic-boot\n';
  for(const pid of [renderer,zygote,main]){
   if(file===`/proc/${pid}/stat`){const parts=Array(20).fill('0');parts[0]='S';parts[1]=String(pid+1);parts[19]=String(pid===main&&changed&&mainStamps++?pid+100:pid);return `${pid} (synthetic) ${parts.join(' ')}`;}
   if(file===`/proc/${pid}/cmdline`)return Buffer.from([exe,`--type=${pid===renderer?'renderer':'zygote'}`,''].join('\0'));
  }
  throw Error('Unexpected ancestry read '+file);
 });
 if(changed)await assert.rejects(assertRecoverySourceStopped('/synthetic/project'),{code:'RECOVERY_OWNER_UNVERIFIED'});
 else await assertRecoverySourceStopped('/synthetic/project');
});
