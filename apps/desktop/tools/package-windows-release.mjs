// Native Windows draft artifacts only. Never installs, signs, uploads or publishes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import JSZip from 'jszip';
import {packageWindowsCandidate,validateWindowsCandidate} from './package-windows-candidate.mjs';

if(process.platform!=='win32'||process.arch!=='x64'||process.versions.node!=='22.23.4'||process.versions.electron)throw Error('Use native Windows x64 Node 22.23.4');
const [destination,mode,tag,...extra]=process.argv.slice(2);
if(!destination||!path.isAbsolute(destination)||extra.length||(mode!==undefined&&mode!=='--manual')||(tag!==undefined&&!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)))throw Error('usage: node tools/package-windows-release.mjs <absolute-new-output-directory> [--manual [release-tag]]');
const manual=mode==='--manual';
const source=path.resolve(import.meta.dirname,'..'),repository=path.resolve(source,'../..'),output=path.resolve(destination);
const relative=path.relative(repository,output);
if(!relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw Error('Output must be outside the repository');
const git=(...args)=>execFileSync('git',args,{cwd:repository,encoding:'utf8'}).trim();
if(git('status','--porcelain','--untracked-files=normal'))throw Error('Commit all source changes before release packaging');
const commit=git('rev-parse','HEAD');
if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Exact source SHA required');
const pkg=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version))throw Error('Invalid version');
if(tag&&(tag!==`v${pkg.version}`||git('rev-parse','--verify',`refs/tags/${tag}^{commit}`)!==commit))throw Error('Windows release tag does not match the package version and source commit');
const inventory=JSON.parse(await fs.readFile(path.join(source,'compliance-inventory.json'),'utf8'));
if(!['pending','complete'].includes(inventory.publicRedistributionAudit))throw Error('Explicit redistribution audit status required');
await fs.mkdir(output); // Exclusive: never reuse an existing artifact directory.
const stem=`Nozeli-${pkg.version}-windows-x64`,staging=await fs.mkdtemp(path.join(output,'.staging-')),verify=await fs.mkdtemp(path.join(output,'.verify-'));
const candidate=path.join(staging,stem),zipName=stem+'.zip',sourceName=`Nozeli-${pkg.version}-source.tar.gz`,usageName='USAGE-windows.zh-CN.md';
const build=script=>execFileSync(process.execPath,[path.join(source,'tools',script)],{cwd:source,stdio:'inherit'});
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
let complete=false;
try{
  build('build-windows-native.mjs');build('build-windows-process.mjs');
  await fs.rm(path.join(source,'dist/renderer'),{recursive:true,force:true});
  build('build-renderer.mjs');
  const record={application:'Nozeli',version:pkg.version,commit,platform:'win32',arch:'x64',format:'manual-candidate-zip',distribution:'local-beta',codesign:'unsigned',authenticode:false,autoUpdate:manual?'unsupported':'native-windows-health-v1',nodeNpmRequired:false,publicRedistributionAudit:inventory.publicRedistributionAudit};
  const manifest=await packageWindowsCandidate({source,candidate,recordNativeProvenance:true,releaseRecord:record});
  const zip=new JSZip();
  for(const entry of manifest.entries){if(entry.type==='file')zip.file(stem+'/'+entry.path,await fs.readFile(path.join(candidate,entry.path)));else zip.folder(stem+'/'+entry.path);}
  zip.file(stem+'/WINDOWS-CANDIDATE.json',await fs.readFile(path.join(candidate,'WINDOWS-CANDIDATE.json')));
  await fs.writeFile(path.join(output,zipName),await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}}),{flag:'wx'});
  // Validate and execute the extracted bytes, not the build tree.
  const archived=await JSZip.loadAsync(await fs.readFile(path.join(output,zipName)));
  for(const entry of Object.values(archived.files)){
    if(entry.name!==entry.unsafeOriginalName&&entry.unsafeOriginalName!==undefined||entry.name.split('/').some(p=>p==='..')||/[\\:\0]/.test(entry.name)||!entry.name.startsWith(stem+'/'))throw Error('Unsafe release ZIP path');
    const target=path.join(verify,entry.name);
    if(entry.dir)await fs.mkdir(target,{recursive:true});else{await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,await entry.async('nodebuffer'),{flag:'wx'});}
  }
  const extracted=path.join(verify,stem),checked=await validateWindowsCandidate(extracted);
  try{
    if(JSON.stringify(JSON.parse(checked.tree.read('RELEASE.json')))!==JSON.stringify(record))throw Error('ZIP release metadata mismatch');
    if(tag&&`v${checked.manifest.version}`!==tag)throw Error('Extracted Windows candidate does not match the release tag');
  }finally{checked.tree.close();}
  const app=path.join(extracted,'resources/app'),node=path.join(app,'runtime/node/node.exe');
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_OPTIONS;delete env.NODE_PATH;
  const smokeScript=`const path=require('node:path');if(process.platform!=='win32'||process.arch!=='x64')throw Error('Wrong native host');for(const name of ['windows/Release/nozeli_windows_read.node','windows-process/Release/nozeli_windows_process.node'])require(path.join(process.argv[1],'native',name.replace('/Release/','/build/Release/')));process.stdout.write(JSON.stringify({node:process.versions.node,electron:process.versions.electron??null}));`;
  const smoke={};
  for(const [host,executable] of [['node',node],['electron',path.join(extracted,'Nozeli.exe')]])smoke[host]=JSON.parse(execFileSync(executable,['-e',smokeScript,app],{env,cwd:app,encoding:'utf8'}));
  if(smoke.node.node!=='22.23.4'||smoke.node.electron!==null||smoke.electron.electron!=='44.9.1')throw Error('Extracted runtime version mismatch');
  const gitEntry=manifest.entries.find(e=>e.type==='file'&&e.path.includes('/node_modules/dugite/')&&e.path.endsWith('/git.exe'));
  smoke.git=execFileSync(path.join(extracted,gitEntry.path),['--version'],{cwd:app,env,encoding:'utf8'}).trim();
  await fs.writeFile(path.join(output,'WINDOWS-SMOKE.json'),JSON.stringify({schema:1,commit,version:pkg.version,tag:tag??null,manifestSha256:checked.digest,archive:zipName,archiveSha256:await digest(path.join(output,zipName)),scope:'extracted Node/Electron native bridge load and Git execution; not GUI, install, update or full qualification',smoke},null,2)+'\n',{flag:'wx'});
  execFileSync('git',['archive','--format=tar.gz',`--prefix=Nozeli-${pkg.version}-source/`,'-o',path.join(output,sourceName),commit],{cwd:repository,stdio:'inherit'});
  const updateUsage=manual?'此候选仅支持手动更新，不自动下载或应用。可以主动检查版本。':'原生独立安装提供 native-windows-health-v1 自动更新。源码与未登记安装仅检查；旧版首次仍需手动安装支持该协议的版本。';
  await fs.writeFile(path.join(output,usageName),`# Nozeli ${pkg.version} Windows x64 本地候选\n\n解压 ${zipName}，保留完整目录。无需系统 Node/npm/Git。仅 Windows x64；打包不代表完整原生验收或稳定发行授权。\n\n本包未经 Authenticode 签名，无发行者认证；SmartScreen 可能阻止运行，不要求关闭安全策略。${updateUsage}\n\n手动隔离安装使用包内 runtime/node/node.exe 执行 tools/install-windows.mjs install --root <不存在的专用绝对目录> --candidate <解压目录>（工具位于 resources/app 下）；upgrade/rollback/status/list/launch 见该工具。不要使用日常配置目录。直接运行 Nozeli.exe 不替代隔离安装。\n\n源码提交 ${commit}，源码归档 ${sourceName}；第三方对应源码义务未因此完成。公开分发审计 ${inventory.publicRedistributionAudit}，本地打包不授权上传、发布或日常安装。配置、项目数据不随程序版本回退。\n\nSHA256SUMS.txt 仅检测传输损坏，不是数字签名。WINDOWS-SMOKE.json 仅记录本次解压后运行时／原生模块／Git 检查，不证明 GUI 更新旅程、完整业务、断电恢复、物理 IME 或多屏资格。\n\nNozeli 自有代码 AGPL-3.0-only，见 NOZELI-LICENSE；Electron/Chromium 和依赖许可、SOURCES.md、assets/licenses 及 Pi/PPTist 声明随包保留。AI 服务须自行配置；包不附个人凭据。\n`,{flag:'wx'});
  const sums=[];for(const name of [zipName,sourceName,usageName,'WINDOWS-SMOKE.json'])sums.push(`${await digest(path.join(output,name))}  ${name}`);
  await fs.writeFile(path.join(output,'SHA256SUMS.txt'),sums.join('\n')+'\n',{flag:'wx'});
  complete=true;console.log(JSON.stringify({output,...record,zip:zipName,smoke},null,2));
}finally{
  await fs.rm(staging,{recursive:true,force:true});await fs.rm(verify,{recursive:true,force:true});
  if(!complete)console.error('Packaging failed; retained output is incomplete and must not be accepted or reused: '+output);
}
