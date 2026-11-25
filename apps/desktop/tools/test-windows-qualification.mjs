// Native Windows qualification runner. Explicit binaries, no shell, isolated
// synthetic profile, authenticated child identity and content-free diagnostics.
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {finished} from 'node:stream/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {windowsQualificationPassed,windowsReleaseCases} from './windows-qualification-verdict.mjs';
const sourceApp=path.resolve(import.meta.dirname,'..');
const [host,suite,label,application=sourceApp,outputRoot=process.env.NOZELI_TEST_OUTPUT_ROOT]=process.argv.slice(2);
if(!['node','electron'].includes(host)||!label||!/^[a-z0-9-]+$/.test(label)||!outputRoot)throw Error('Usage: fixed-node tools/test-windows-qualification.mjs node|electron suite unique-label [application] [output-root]');
function packagedAllowed(platform,arch,host,versions){return platform==='win32'&&arch==='x64'&&host==='node'&&versions.node==='22.23.4'&&!versions.electron;}
const suites={
 'model-auth':['windows-pi-model-auth.test.mjs'],
 'v57-config':['windows-pi-model-auth.test.mjs','windows-pi-settings.test.mjs','windows-cold-settings.test.mjs','windows-cold-model-auth.test.mjs'],
 'metadata':['windows-pi-metadata.test.mjs','pi-session-admission.test.mjs'],
 'metadata-owner-smoke':['--test-name-pattern=actual stopped-normal host death|normal Pi startup preserves','windows-pi-owner.test.mjs'],
 'deep-home':['--test-name-pattern=actual owner starts, serves and retains original material under','windows-pi-owner.test.mjs'],
 'role-skills':['windows-pi-role-skills.test.mjs','pi-native-skills.test.mjs'],
 'forcequit':['windows-tool-lifecycle.test.mjs','force-quit-process.test.mjs'],
 'launcher':['windows-launcher-verification.test.mjs'],
 'release':['--test-name-pattern=^(?:'+windowsReleaseCases.map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')$','windows-launcher-verification.test.mjs','windows-package-install.test.mjs','windows-desktop-update.test.mjs'],
 'file-transactions':['windows-desktop-project-git.test.mjs','windows-desktop-file-tree.test.mjs','windows-desktop-file-clipboard.test.mjs'],
 'elevation':['privilege-broker.test.mjs'],
 'production-managed':['windows-owner-configuration-source.test.mjs','windows-desktop-managed-production.test.mjs'],
 'refusals':['platform-process-boundary.test.mjs','windows-alpha6-boundaries.test.mjs','omp-tui-session.test.mjs','project-semantic-initialization.test.mjs'],
 'model-auth-reentry':['--test-name-pattern=async storage rejects direct','windows-pi-model-auth.test.mjs'],
 'model-auth-json-root':['--test-name-pattern=invalid configuration roots','windows-pi-model-auth.test.mjs'],
 'model-auth-evidence':['--test-name-pattern=evidence directory replacement','windows-pi-model-auth.test.mjs'],
 'integration-helpers':['pi-context-budget.test.mjs','pi-facts.test.mjs','pi-questions.test.mjs','provider-http-observer.test.mjs'],
 'settings':['windows-pi-settings.test.mjs'],
 'cold-settings':['windows-cold-settings.test.mjs'],
 'cold-model-auth':['windows-cold-model-auth.test.mjs'],
 'owner':['windows-pi-owner.test.mjs'],
 'owner-readiness':['--test-name-pattern=actual (abrupt-host-tool-pending|abrupt-host-tool-returned|abrupt-host-tool-result-unknown|stopped-normal|stopped-forced|stopped-truncated) host death','windows-pi-owner.test.mjs'],
 'profile':['windows-desktop-profile.test.mjs','windows-desktop-configuration.test.mjs'],
 'terminal-cwd':['--test-name-pattern=same-path replacement of the registered project','windows-project-terminal-native.test.mjs'],
 'terminal':['project-terminal-host.test.mjs','windows-project-terminal-native.test.mjs'],
 'tools':['windows-tool-lifecycle.test.mjs','host-language-service.test.mjs','tex-build.test.mjs'],
 'lifecycle':['windows-tool-lifecycle.test.mjs'],
 'lsp':['host-language-service.test.mjs'],
 'tex-missing':['--test-name-pattern=missing TeX executables','tex-build.test.mjs'],
 'tex-retention':['--test-name-pattern=Windows TeX transport failure','tex-build.test.mjs'],
 'install':['windows-package-install.test.mjs'],
 'resources':['pi-runtime-resources.test.mjs','pi-native-skills.test.mjs'],
 'provider':['pi-provider-runtime.test.mjs','pi-zai-coding-plan.test.mjs','pi-discovery-listing.test.mjs'],
 'worker':['windows-worker-flow.test.mjs'],
 'archive':['windows-cold-evidence-archive.test.mjs'],
 'archive-focused':['--test-name-pattern=archive: normal |archive: ready-lost-reply ','windows-cold-evidence-archive.test.mjs'],
 'native':['windows-native-read.test.mjs','windows-native-write.test.mjs','windows-native-replacement.test.mjs','windows-native-security.test.mjs','windows-native-persistence.test.mjs','windows-native-versioned-write.test.mjs'],
 'process':['windows-process-identity.test.mjs','windows-process-supervisor.test.mjs'],
 'identity':[],
};
if(!Object.hasOwn(suites,suite))throw Error('Unknown qualification suite');
if(suite==='release'&&(!packagedAllowed(process.platform,process.arch,host,process.versions)))throw Error('Release qualification requires native Windows x64 Node 22.23.4');
const app=path.resolve(application),packaged=app!==sourceApp;
const directory=path.join(outputRoot,'20261114-windows-goal',label);await fs.mkdir(directory,{recursive:false});
const profiles=path.join(directory,'synthetic-profile'),probes=path.join(directory,'runtime-probes');await fs.mkdir(profiles);await fs.mkdir(probes);
const tempRoot=path.join(path.parse(app).root,'dev-cache','t');await fs.mkdir(tempRoot,{recursive:true});
const temp=await fs.mkdtemp(path.join(tempRoot,'w-'));
const nodeExecutable=packaged?path.join(app,'runtime/node/node.exe'):suite==='release'?process.execPath:path.resolve(sourceApp,'../../../.tools/node-v22.23.4-win-x64/node.exe');
const executable=host==='electron'?(packaged?path.resolve(app,'../../Nozeli.exe'):path.join(app,'node_modules/electron/dist/electron.exe')):nodeExecutable;
if(path.extname(executable).toLowerCase()!=='.exe')throw Error('An explicit executable is required');await fs.access(executable);
const env={};for(const [key,value] of Object.entries(process.env))if(!/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)&&!/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)&&!['PATH','NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase()))env[key]=value;
const nonce=randomUUID();Object.assign(env,{HOME:profiles,USERPROFILE:profiles,XDG_CONFIG_HOME:path.join(profiles,'config'),XDG_DATA_HOME:path.join(profiles,'data'),XDG_CACHE_HOME:path.join(profiles,'cache'),XDG_STATE_HOME:path.join(profiles,'state'),TEMP:temp,TMP:temp,Path:'C:\\Windows\\System32',GIT_CONFIG_GLOBAL:path.join(profiles,'.gitconfig'),GIT_CONFIG_NOSYSTEM:'1',NOZELI_TEST_LIVE:'1',NOZELI_TEST_OUTPUT_ROOT:directory,NOZELI_QUALIFICATION_NONCE:nonce,NOZELI_QUALIFICATION_HOST:host,NOZELI_QUALIFICATION_PROBES:probes});
env.NOZELI_TEST_NODE_EXECUTABLE=nodeExecutable;
if(packaged)env.NOZELI_TEST_PACKAGED_APP='1';
if(host==='electron')env.ELECTRON_RUN_AS_NODE='1';if(packaged)env.NOZELI_TEST_PI_ROOT=path.join(app,'integrations/pi');
const args=['--require',path.join(sourceApp,'tools/windows-runtime-probe.cjs'),...(suite==='identity'?['-e','process.stdout.write("runtime identity bound\\n")']:['--test','--test-concurrency=1','--test-reporter=tap',...suites[suite].map(file=>file.startsWith('--')?file:'tests/'+file)])];
const tap=createWriteStream(path.join(directory,'result.tap'),{flags:'wx'}),buffers={stdout:'',stderr:''};
const sanitize=line=>{
 if(/^(TAP version|# Subtest:|ok \d|not ok \d|1\.\.\d|# (tests|pass|fail|skipped|cancelled|duration_ms) )/.test(line)||/^\s*(code: '[A-Z_0-9]+'|failureType: '[a-zA-Z_]+'|win32Code: \d+)$/.test(line))return line;
 if(/^\s*error:/.test(line)&&/Git /.test(line)){
  if(/filename too long|path.{0,24}too long/i.test(line))return '  diagnostic: GIT_PATH_TOO_LONG';
  if(/permission denied|access is denied/i.test(line))return '  diagnostic: GIT_ACCESS_DENIED';
  return '  diagnostic: GIT_OPERATION_FAILED';
 }
 if(!/^\s*(?:location:|at |[A-Za-z_$][\w.$<> ]*\s*\()/.test(line))return null;
 const location=line.match(/(?:file:\/\/\/[^\s)]+\.(?:mjs|cjs|js):\d+:\d+|[A-Za-z]:\\[^\r\n']+\.(?:mjs|cjs|js):\d+:\d+)/);
 return location?'  source: '+location[0]:null;
};
const startedAt=new Date().toISOString(),child=spawn(executable,args,{cwd:app,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',spawnError=null;
const consume=(channel,chunk)=>{const text=chunk.toString();if(channel==='stdout')stdout+=text;else stderr+=text;const lines=(buffers[channel]+text).split(/\r?\n/);buffers[channel]=lines.pop();for(const line of lines){const safe=sanitize(line);if(safe)tap.write(safe+'\n');}};
child.stdout.on('data',b=>consume('stdout',b));child.stderr.on('data',b=>consume('stderr',b));child.on('error',e=>{spawnError=e.code??e.name;});
const completion=new Promise(resolve=>child.once('close',(exitCode,signal)=>resolve({exitCode,signal})));
console.log(JSON.stringify({state:'started',host,suite,label,pid:child.pid,executable}));
await fs.writeFile(path.join(directory,'launch.json'),JSON.stringify({startedAt,pid:child.pid,executable,args,host,suite,nonce},null,2)+'\n');
await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({state:'running',passed:false,host,suite,label,startedAt,pid:child.pid},null,2)+'\n',{flag:'wx'});
const ended=await completion;
for(const line of Object.values(buffers)){const safe=sanitize(line);if(safe)tap.write(safe+'\n');}tap.end();await finished(tap);
const identities=[];for(const name of await fs.readdir(probes))identities.push(JSON.parse(await fs.readFile(path.join(probes,name),'utf8')));
const identityVerified=identities.some(row=>row.pid===child.pid&&row.nonce===nonce&&path.resolve(row.executable).toLowerCase()===path.resolve(executable).toLowerCase()&&(host==='electron'?row.electron==='44.9.1':row.node==='22.23.4'&&row.electron===null));
const counts={};for(const name of ['tests','pass','fail','skipped','cancelled'])counts[name]=Number(stdout.match(new RegExp('^# '+name+' (\\d+)\\r?$','m'))?.[1]??0);
const failures=[...stdout.matchAll(/^not ok \d+ - (.+)\r?$/gm)].map(m=>m[1].trim());
const passed=windowsQualificationPassed({suite,exitCode:ended.exitCode,identityVerified,counts,tap:stdout});
const result={schema:1,label,host,suite,startedAt,finishedAt:new Date().toISOString(),...ended,spawnError,executable,identityVerified,identities,counts,failures,passed,rawPrivateDiagnosticsRetained:false,stderrBytes:Buffer.byteLength(stderr),qualifiedBaselineVersion:50,productionReady:false,goalComplete:false};
await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({label,passed,identityVerified,...ended,counts,failures}));process.exitCode=passed?0:1;
