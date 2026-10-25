import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAgentSettings} from '../src/renderer/settings-agents.mjs';
function fixture(invoke,getProjectId=()=>null){
 const nodes=new Map();
 const container={innerHTML:'',querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{value:'',disabled:false,textContent:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},reportValidity:()=>true});return nodes.get(selector);}};
 const panel=mountAgentSettings({invoke,container,getProjectId});
 return {panel,container,node:selector=>container.querySelector(`[data-agent-${selector}]`),submit:()=>container.querySelector('[data-agent-limits-form]').listeners.submit({preventDefault(){}})};
}
const status={globalLimit:8,globalUsed:4,projectLimit:3,projectUsed:2,agents:[{projectId:'A',target:'frontdesk',state:'sleeping'},{projectId:'B',target:'work-1',state:'waiting'}]};
test('without a project only global quota is editable and saved',async()=>{
 const calls=[];const ui=fixture(async(op,payload)=>{calls.push([op,payload]);return {ok:true,value:status};});await ui.panel.refresh();
 assert.equal(ui.node('project-limit').disabled,true);assert.equal(ui.node('project-limit').value,'');assert.match(ui.node('project-used').textContent,/尚未打开项目/);assert.equal(ui.node('limits-save').disabled,false);
 ui.node('global-limit').value='9';await ui.submit();assert.deepEqual(calls[1],['settings.agents.save',{globalLimit:9}]);
});
test('status failure disables save; failed save preserves edited quota and exposes backend message',async()=>{
 let failure='status';const ui=fixture(async op=>failure===op.split('.').at(-1)?{ok:false,error:{message:'额度低于当前占用'}}:{ok:true,value:status});
 await ui.panel.refresh();assert.equal(ui.node('limits-save').disabled,true);assert.match(ui.node('limits-status').textContent,/额度低于当前占用/);
 failure='save';await ui.panel.refresh();ui.node('global-limit').value='2';await ui.submit();assert.equal(ui.node('global-limit').value,'2');assert.equal(ui.node('limits-save').disabled,false);assert.match(ui.node('limits-status').textContent,/额度低于当前占用/);
});
test('project change before submit refreshes the new project instead of saving stale quota',async()=>{
 let project='A';const calls=[];const ui=fixture(async(op,payload)=>{calls.push([op,payload]);return {ok:true,value:status};},()=>project);await ui.panel.refresh();project='B';await ui.submit();assert.deepEqual(calls.at(-1),['settings.agents.status',{projectId:'B'}]);assert(!calls.some(([op])=>op==='settings.agents.save'));
});
test('edited resource limits survive revisiting and cannot be rebound to another project',async()=>{
 let project='A';const calls=[];const ui=fixture(async(op,payload)=>{calls.push([op,payload]);return {ok:true,value:status};},()=>project);await ui.panel.refresh();ui.node('global-limit').value='12';ui.node('limits-form').listeners.input();await ui.panel.refresh();assert.equal(ui.node('global-limit').value,'12');project='B';await ui.panel.projectChanged();assert.equal(ui.node('limits-save').disabled,true);await ui.submit();assert(!calls.some(([op])=>op==='settings.agents.save'));project='A';await ui.panel.projectChanged();await ui.submit();assert.deepEqual(calls.at(-1),['settings.agents.save',{globalLimit:12,projectId:'A',projectLimit:3}]);
});
test('a late successful save retains edits made after submission',async()=>{
 let finish;const ui=fixture(async op=>op.endsWith('.save')?new Promise(resolve=>{finish=resolve;}):{ok:true,value:status},()=> 'A');await ui.panel.refresh();ui.node('global-limit').value='12';ui.node('limits-form').listeners.input();const saving=ui.submit();ui.node('global-limit').value='13';ui.node('limits-form').listeners.input();finish({ok:true,value:{...status,globalLimit:12}});await saving;assert.equal(ui.node('global-limit').value,'13');assert.match(ui.node('limits-status').textContent,/新输入尚未保存/);assert.equal(ui.node('limits-save').disabled,false);
});
test('a project change during save refreshes the current project after settlement',async()=>{
 let project='A',finish;const calls=[];const ui=fixture(async(op,payload)=>{calls.push([op,payload]);return op.endsWith('.save')?new Promise(resolve=>{finish=resolve;}):{ok:true,value:{...status,projectLimit:payload.projectId==='B'?5:3}};},()=>project);await ui.panel.refresh();ui.node('global-limit').value='12';ui.node('limits-form').listeners.input();const saving=ui.submit();project='B';await ui.panel.projectChanged();finish({ok:true,value:{...status,globalLimit:12}});await saving;assert.equal(ui.node('project-limit').value,5);assert.equal(ui.node('limits-save').disabled,false);assert.deepEqual(calls.at(-1),['settings.agents.status',{projectId:'B'}]);
});
