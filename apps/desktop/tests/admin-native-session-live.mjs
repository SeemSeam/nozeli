// Explicit native-runtime integration: no model requests, private temporary state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ADMIN_TOOLS} from '../src/agents/admin-agent.mjs';
import {OwnerRuntime} from '../../../integrations/pi/src/bridge.mjs';
test('real native driver creates and resumes admin history only inside explicit private sessionDir without inference',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-admin-native-'));const agentDir=path.join(root,'shared-settings'),home=path.join(root,'admin-home'),cwd=path.join(root,'admin-cwd'),sessionDir=path.join(home,'sessions');
 await fs.mkdir(agentDir,{recursive:true});await fs.mkdir(cwd,{recursive:true});
 await fs.writeFile(path.join(agentDir,'models.json'),JSON.stringify({providers:{'local-fixture':{baseUrl:'http://127.0.0.1:1/v1',api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Scripted offline',reasoning:true,input:['text'],contextWindow:65536,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
 const packageRoot=fileURLToPath(new URL('../src/agents/admin/roles',import.meta.url));const roleSkillCatalog=['nozeli-admin-project-management','nozeli-admin-configuration'].map(name=>({name,filePath:path.join(packageRoot,'admin','skills',name,'SKILL.md')}));
 const params={home,cwd,agentDir,sessionDir,role:'admin',rolePackageRoot:packageRoot,roleSkillCatalog,tools:ADMIN_TOOLS,nativeTools:['read'],model:'local-fixture/scripted',effort:'low'};
 const oldAgentDir=process.env.PI_CODING_AGENT_DIR;const runtimes=[];t.after(async()=>{for(const runtime of runtimes)await runtime.stop();if(oldAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldAgentDir;await fs.rm(root,{recursive:true,force:true});});
 const create=()=>{const runtime=new OwnerRuntime({send(){}});runtimes.push(runtime);return runtime;};
 const first=create();const opened=await first.start(params);assert.equal(path.dirname(opened.sessionFile),sessionDir);assert.equal(opened.hasPrompted,false);await first.stop();
 const resumed=await create().start({...params,sessionId:opened.sessionId,sessionFile:opened.sessionFile});assert.equal(resumed.sessionId,opened.sessionId);assert.equal(resumed.sessionFile,opened.sessionFile);assert.equal(resumed.hasPrompted,false);
 const foreign=path.join(agentDir,'sessions','foreign.jsonl');await fs.mkdir(path.dirname(foreign),{recursive:true});await fs.copyFile(opened.sessionFile,foreign);
 await assert.rejects(create().start({...params,sessionId:opened.sessionId,sessionFile:foreign}),{code:'PI_SESSION_SCOPE'});
 await assert.rejects(create().start({...params,sessionDir:path.join(agentDir,'sessions')}),{code:'PI_SESSION_SCOPE'});
});
