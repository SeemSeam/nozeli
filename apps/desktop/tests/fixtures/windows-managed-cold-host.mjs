// Synthetic crashed host with registered original native Jobs and retained I/O.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ProjectStorage} from '../../src/main/project-storage.mjs';
import {acquireExperimentalHostLease} from '../../src/platform/windows/experimental-host-lease.mjs';
import {createOwnerLaunchRegistry} from '../../src/main/owner-launch-registry.mjs';
import {prepareExperimentalProcessTransport} from '../../src/platform/windows/experimental-process-transport.mjs';
import {createExperimentalProcessJob} from '../../src/platform/windows/experimental-process-job.mjs';
import {experimentalSupervisorEndpoint} from '../../src/platform/windows/experimental-process-supervisor.mjs';

const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const storage=new ProjectStorage(input.profile,{windowsDesktopProjects:true});
const lease=await acquireExperimentalHostLease({storage,projectId:input.projectId});
const registry=createOwnerLaunchRegistry(storage,input.projectId,{hostLease:lease}),endpoints=[];
for(const target of input.targets){
  const intent=await registry.begin({target,ownerId:randomUUID(),generation:randomUUID(),launchId:randomUUID(),home:path.join(input.profile,'synthetic-home-'+target)});
  const marker=path.join(input.root,'descendant-'+target),ended=marker+'-ended';
  const descendantCode=input.expiredDescendant?`const descendant=require('node:child_process').spawn(${JSON.stringify(fileURLToPath(new URL('../../native/windows-process/build/Release/nozeli_process_fixture.exe',import.meta.url)))},['hold',${JSON.stringify(marker)}],{stdio:'ignore',windowsHide:true});descendant.once('exit',()=>require('node:fs').writeFileSync(${JSON.stringify(ended)},'exited'));`:'const descendant=null;';
  const spec={command:process.execPath,args:['-e',descendantCode+"process.stderr.write('原诊断 😀\\n');process.stdin.on('data',b=>{process.stdout.write(b);if(descendant&&b.toString().startsWith('STOP'))descendant.kill();});setInterval(()=>{},1000);"],cwd:input.root,env:input.env};
  const transport=input.withoutStdio?null:prepareExperimentalProcessTransport(spec);
  const job=transport?.lease??createExperimentalProcessJob(spec),pin=registry.startSupervisor(job,intent.record.launchId);
  transport?.attachSupervisor(pin);
  const facts=job.snapshot();
  await registry.register(intent,{schema:1,platform:'win32',pid:facts.pid,creationTime100ns:facts.creationTime100ns,stamp:facts.stamp},pin);
  if(transport){
    transport.stdout.resume();transport.stderr.resume();transport.resume();
    await new Promise((resolve,reject)=>transport.stdin.write('原始输入 '+target+' 😀\n',error=>error?reject(error):resolve()));
    const deadline=performance.now()+15000;
    while(!pin.snapshot().stdoutBytes){if(performance.now()>deadline)throw Error('Synthetic owner did not echo original input');await delay(5);}
    if(input.expiredDescendant){
      let descendant;
      for(;;){
        try{descendant=JSON.parse(await fs.readFile(marker,'utf8'));if(pin.snapshot().members.some(member=>member.pid===descendant.pid))break;}
        catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
        if(performance.now()>deadline)throw Error('Original helper did not retain synthetic descendant');await delay(5);
      }
      await new Promise((resolve,reject)=>transport.stdin.write('STOP descendant\n',error=>error?reject(error):resolve()));
      for(;;){try{await fs.stat(ended);break;}catch(error){if(error.code!=='ENOENT')throw error;}if(performance.now()>deadline)throw Error('Synthetic descendant exit not confirmed');await delay(5);}
    }
  }else job.resume();
  endpoints.push(experimentalSupervisorEndpoint(pin));
}
if(input.reservedOnly)await registry.begin({target:'native-intent',ownerId:randomUUID(),generation:randomUUID(),launchId:randomUUID(),home:path.join(input.profile,'synthetic-incomplete-home')});
await fs.writeFile(input.ready,JSON.stringify({endpoints,host:lease.facts()}));
for(;;){try{await fs.stat(input.stop);process.exit(91);}catch(error){if(error.code!=='ENOENT')throw error;}await delay(5);}
