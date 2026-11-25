import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
const integration=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const {OwnerRuntime}=await import(pathToFileURL(path.join(integration,'src/bridge.mjs')));
const {ownerRuntimeResources}=await import(pathToFileURL(path.join(integration,'src/native-skills.mjs')));
const {createPiSdkDriver}=await import(pathToFileURL(path.join(integration,'dist/vendor/pi-gui/packages/pi-sdk-driver/index.js')));
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-resource-boundary-'));
 const project=path.join(root,'project'),home=path.join(root,'owner'),agentDir=path.join(home,'config');
 await fs.mkdir(path.join(project,'.pi','extensions'),{recursive:true});await fs.mkdir(agentDir,{recursive:true});
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const key='PI_CODING_AGENT_DIR',before=process.env[key];delete process.env[key];
 t.after(()=>{if(before===undefined)delete process.env[key];else process.env[key]=before;});
 return {root,project,home,agentDir,workspace:{workspaceId:'synthetic-resources',path:project},settings:path.join(project,'.pi','settings.json')};
}
async function extension(file,marker){
 await fs.mkdir(path.dirname(file),{recursive:true});
 await fs.writeFile(file,`import {appendFileSync} from 'node:fs';export default function(){appendFileSync(${JSON.stringify(marker)},'executed\\n');}`);
}
test('owner settings discovery and reload never execute project, user, configured or package extensions',async t=>{
 const f=await fixture(t),marker=path.join(f.root,'untrusted-executed.txt'),external=path.join(f.root,'external.js'),pkg=path.join(f.root,'package');
 await extension(path.join(f.project,'.pi','extensions','synthetic.js'),marker);
 await extension(path.join(f.agentDir,'extensions','synthetic.js'),marker);await extension(external,marker);
 // A final override alone would still read these paths before discarding them.
 for(const base of [path.join(f.project,'.pi'),f.agentDir])for(const name of ['SYSTEM.md','APPEND_SYSTEM.md'])await fs.mkdir(path.join(base,name));
 await extension(path.join(pkg,'index.js'),marker);await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'synthetic-package',pi:{extensions:['index.js']}}));
 const resources={extensions:[external],packages:[pkg],skills:[path.join(f.root,'external-skill')],prompts:[path.join(f.root,'external-prompt.md')]};
 await fs.writeFile(f.settings,JSON.stringify({...resources,defaultProvider:'project-synthetic',defaultModel:'project-model',defaultThinkingLevel:'low'}));
 await fs.writeFile(path.join(f.agentDir,'settings.json'),JSON.stringify({...resources,defaultProvider:'global-synthetic',defaultModel:'global-model'}));
 const before=await fs.readFile(f.settings),runtime=new OwnerRuntime({send:()=>{}});
 await runtime.ensureInitialized(f);const supervisor=runtime.driver.runtimeSupervisor;
 const first=await supervisor.getRuntimeSnapshot(f.workspace);
 assert.equal(first.settings.defaultProvider,'project-synthetic');assert.equal(first.settings.defaultModelId,'project-model');assert.equal(first.settings.defaultThinkingLevel,'low');
 assert.deepEqual(first.skills,[]);assert.ok(first.extensions.every(row=>row.sourceInfo.source==='builtin'));
 assert.ok(first.providers.some(row=>row.id==='zai'),'trusted Nozeli provider remains registered');
 assert.ok(first.extensions.some(row=>row.path==='<inline:nozeli-zai-coding-plan>'),'trusted extension retains its name and settings identity');
 await assert.rejects(fs.stat(marker),{code:'ENOENT'});assert.deepEqual(await fs.readFile(f.settings),before);
 await fs.writeFile(f.settings,JSON.stringify({...resources,defaultProvider:'changed-synthetic',defaultModel:'changed-model',defaultThinkingLevel:'high'}));
 const refreshed=await supervisor.refreshRuntime(f.workspace);assert.equal(refreshed.settings.defaultModelId,'changed-model');assert.equal(refreshed.settings.defaultThinkingLevel,'high');
 await supervisor.setProjectDefaultModel(f.workspace,{provider:'updated-synthetic',modelId:'updated-model'});
 await supervisor.setProjectDefaultThinkingLevel(f.workspace,'medium');
 const stored=JSON.parse(await fs.readFile(f.settings,'utf8'));assert.equal(stored.defaultModel,'updated-model');assert.equal(stored.defaultThinkingLevel,'medium');
 for(const [key,value] of Object.entries(resources))assert.deepEqual(stored[key],value,'unrelated project resource settings stay on disk');
 await assert.rejects(fs.stat(marker),{code:'ENOENT'});
});
test('driver without an owner resource policy retains upstream project extension behavior',async t=>{
 const f=await fixture(t),marker=path.join(f.root,'default-executed.txt');
 await extension(path.join(f.project,'.pi','extensions','synthetic.js'),marker);
 const driver=createPiSdkDriver({agentDir:f.agentDir});await driver.runtimeSupervisor.getRuntimeSnapshot(f.workspace);
 assert.equal(await fs.readFile(marker,'utf8'),'executed\n');
});
test('owner resource settings preserve SDK missing and malformed configuration behavior without rewriting bytes',async t=>{
 const f=await fixture(t);let policy=ownerRuntimeResources(f.project,f.agentDir);
 assert.equal(policy.settingsManager.getDefaultModel(),undefined);await assert.rejects(fs.stat(f.settings),{code:'ENOENT'});
 const malformed=Buffer.from('{"defaultModel":');await fs.writeFile(f.settings,malformed);
 policy=ownerRuntimeResources(f.project,f.agentDir);assert.equal(policy.settingsManager.getDefaultModel(),undefined);
 assert.ok(policy.settingsManager.drainErrors().some(row=>row.scope==='project'));assert.deepEqual(await fs.readFile(f.settings),malformed);
 await fs.writeFile(f.settings,JSON.stringify({defaultProvider:'repaired',defaultModel:'repaired-model'}));await policy.settingsManager.reload();
 assert.equal(policy.settingsManager.getDefaultProvider(),'repaired');assert.equal(policy.settingsManager.getDefaultModel(),'repaired-model');
});
