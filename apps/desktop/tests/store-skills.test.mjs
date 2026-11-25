import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StoreSkills,contextTransfer} from '../src/agents/managed/store-skills.mjs';

const params={skillId:contextTransfer,role:'frontdesk'};
const a={id:'a',instanceId:'first'}, b={id:'b',instanceId:'second'}, replacement={...a,instanceId:'replacement'};
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-store-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return path.join(dir,'store-skills.json');
}
const checks={assertCurrent(){},active:()=>false};
const invoke=(store,action,project=a,p=action==='list'?{}:params,overrides={})=>store.invoke(action,p,{...checks,project,...overrides});
const use=(store,project,run)=>store.use(contextTransfer,'frontdesk',project,checks.assertCurrent,run);
const status=async(store,project)=>(await invoke(store,'list',project))[0].roles;

test('role installs default to enabled and persistent opt-outs affect only the exact project instance',async t=>{
 const file=await fixture(t),store=new StoreSkills(file);
 for(const role of ['worker','orchestrator','unknown'])await assert.rejects(invoke(store,'install',a,{...params,role}),{code:'STORE_ROLE_INCOMPATIBLE'});
 await assert.rejects(invoke(store,'enable'),{code:'STORE_SKILL_NOT_INSTALLED'});
 await invoke(store,'install',null);
 assert.equal(await use(store,a,()=>true),true);
 assert.equal((await status(store,null))[0].enabled,false);
 await invoke(store,'disable',a);
 const reopened=new StoreSkills(file);
 assert.deepEqual(await status(reopened,a),[{id:'frontdesk',name:'前台',installed:true,enabled:false}]);
 await assert.rejects(use(reopened,a,()=>assert.fail('disabled instance use')),{code:'STORE_SKILL_NOT_ENABLED'});
 for(const project of [b,replacement])assert.equal(await use(reopened,project,()=>true),true);
 await assert.rejects(invoke(reopened,'uninstall',null,params,{active:()=>true}),{code:'STORE_SKILL_IN_USE'});
 await invoke(reopened,'uninstall',null);
 await assert.rejects(use(reopened,b,()=>assert.fail('uninstalled use')),{code:'STORE_SKILL_NOT_ENABLED'});
 await invoke(reopened,'install',null);
 assert.equal((await status(reopened,a))[0].enabled,false);
 await invoke(reopened,'enable',a);
 assert.equal(await use(reopened,a,()=>true),true);
});

test('legacy installations are visible without a previous project binding',async t=>{
 const file=await fixture(t);
 await fs.writeFile(file,JSON.stringify({schema:1,installs:[{...params,revision:1}],bindings:[]}));
 const store=new StoreSkills(file);
 assert.equal(await use(store,b,()=>true),true);
 await invoke(store,'disable',b);
 await assert.rejects(use(new StoreSkills(file),b,()=>assert.fail('lost override')),{code:'STORE_SKILL_NOT_ENABLED'});
});

test('disable waits for an admitted use and rejects subsequent uses',async t=>{
 const store=new StoreSkills(await fixture(t));
 await invoke(store,'install');
 const {promise:entered,resolve:enter}=Promise.withResolvers();
 const {promise:release,resolve:finish}=Promise.withResolvers();
 const running=use(store,a,async()=>{enter();await release;return 'completed';});
 await entered;
 const disabled=invoke(store,'disable');
 const denied=assert.rejects(use(store,a,()=>assert.fail('disabled use')),{code:'STORE_SKILL_NOT_ENABLED'});
 finish();assert.equal(await running,'completed');
 assert.equal((await disabled)[0].roles[0].enabled,false);
 await denied;
});
