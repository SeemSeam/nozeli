import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAttentionDialogue} from '../src/renderer/attention-dialogue.mjs';
// Minimal DOM double: only the structural surface the dialogue consumes.
// Selector support is limited to tag, [data-attr] and [data-attr="value"].
const datasetKey=name=>name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
class Node{
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this.value='';this.checked=false;this.type='';}
 append(...children){this.children.push(...children);}
 setAttribute(name,value=''){this.attributes[name]=String(value);}
 matches(selector){return selector.split(/(?=\[)/).every(part=>{if(part.startsWith('[')){const match=part.match(/^\[([^\]=]+)(?:="(.*)")?\]$/);if(!match)return false;const value=this.dataset[datasetKey(match[1])]??this.attributes[match[1]];return match[2]===undefined?value!==undefined:value===match[2];}return this.tagName===part;});}
 querySelectorAll(selector){return this.children.flatMap(child=>typeof child==='object'&&child!==null?[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]:[]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
function fixture(destination,invoke,{drafts=new Map(),confirm,onRefresh,todo}={}){
 const document={createElement:tag=>new Node(tag)},container=new Node('div');
 const effectiveTodo=todo??{id:'todo',status:'open',destination,text:'source question'};
 let valid=true;
 const ui=mountAttentionDialogue(container,{document,projectId:'project',todo:effectiveTodo,invoke,current:()=>valid,onRefresh:onRefresh??(async()=>{}),openSettings:()=>{},drafts,...(confirm?{confirm}:{})});
 return {container,ui,todo:effectiveTodo,drafts,query:selector=>container.querySelector(selector),nodes:tag=>container.querySelectorAll(tag),stale:()=>{valid=false;}};
}
const askDialog={kind:'conversation',ownerId:'owner',interactionId:'interaction',question:{method:'askDialog',questions:[
 {id:'checks',question:'pick checks',multi:true,options:[{label:'Review logs'},{label:'Review config'}]},
 {id:'custom',question:'give a route',options:[{label:'Default route'}]},
]}};
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
const submit=async f=>{f.nodes('form')[0].onsubmit({preventDefault(){}});await settle();};
const click=async(node)=>{node.onclick();await settle();};
test('stale binding never submits; answer controls retain unsent text after refresh',async()=>{
 const calls=[],f=fixture({kind:'conversation',ownerId:'owner',interactionId:'interaction',question:{method:'input'}},async(...args)=>{calls.push(args);return {ok:false,error:{message:'not ready'}};});
 const input=f.nodes('input')[0];input.value='unsent';input.oninput();f.ui.update(f.todo);await submit(f);
 assert.equal(input.value,'unsent');assert.equal(f.drafts.size,1);
 f.stale();await submit(f);assert.equal(calls.length,1);
});
test('selecting a choice card marks it and never answers by itself',async()=>{
 const calls=[],f=fixture(askDialog,async(...args)=>{calls.push(args);return {ok:true,value:{}};});
 const card=f.query('[data-attention-option="Review logs"]');
 const radio=f.nodes('input').find(node=>node.value==='Review logs');
 radio.checked=true;radio.onchange();
 assert.equal(card.dataset.attentionSelected,'true','chosen card is observably marked');
 assert.equal(f.query('[data-attention-option="Review config"]').dataset.attentionSelected,undefined,'unchosen card stays unmarked');
 assert.equal(calls.length,0,'selection must not submit an answer');
 const restored=fixture(askDialog,async()=>({ok:true,value:{}}),{drafts:f.drafts});
 assert.equal(restored.query('[data-attention-option="Review logs"]').dataset.attentionSelected,'true','a restored draft keeps the card marked');
});
test('optional fields stay collapsed until a retained draft reopens them',async()=>{
 const calls=[],drafts=new Map(),identity=JSON.stringify(['project','todo',undefined,'owner',undefined,'interaction']);
 drafts.set(identity,{'custom:1':'kept custom answer'});
 const f=fixture(askDialog,async(...args)=>{calls.push(args);return {ok:true,value:{}};},{drafts});
 assert.equal(f.query('[data-attention-extra="custom:1"]').open,true,'nonempty draft reopens its collapsed field');
 assert.equal(f.query('[data-attention-extra="note:1"]').open,undefined,'empty optional fields remain collapsed');
 const details=f.query('[data-attention-extra="custom:1"]');
 details.open=false; // closing the toggle is a view action only
 assert.equal(f.query('[data-attention-input="custom:1"]').value,'kept custom answer','closing the toggle never discards the draft');
 assert.equal(drafts.get(identity)['custom:1'],'kept custom answer');
});
test('cancellation interrupts only after explicit confirmation',async()=>{
 const calls=[],confirmations=[];
 let confirmed=false;
 const f=fixture({kind:'conversation',ownerId:'owner',interactionId:'interaction',question:{method:'input'}},async(...args)=>{calls.push(args);return {ok:true,value:{}};},{confirm:async message=>{confirmations.push(message);return confirmed;}});
 const cancel=f.nodes('button').find(button=>'attentionCancel' in button.dataset);
 await click(cancel); // dismissed confirmation sends nothing
 assert.equal(confirmations.length,1);assert.equal(calls.length,0,'a dismissed confirmation must not interrupt the native turn');
 confirmed=true;await click(cancel);
 assert.equal(calls.length,1);assert.equal(calls[0][0],'managed.attention.respond','confirmed cancellation targets the native respond operation');assert.equal(calls[0][1].cancel,true,'confirmed cancellation interrupts the original turn');
 assert.equal(calls[0][1].answer,undefined,'cancellation never fabricates an answer');
});
for(const action of ['chat','cancel'])test(`askDialog ${action} preserves typed and multi-select answers without sending them`,async()=>{
 const calls=[],f=fixture(askDialog,async(...args)=>{calls.push(args);return {ok:true,value:{}};},{confirm:async()=>true});
 const selected=f.nodes('input').find(node=>node.value==='Review logs');selected.checked=true;selected.onchange();
 const custom=f.query('[data-attention-input="custom:1"]');custom.value='retained typed answer';custom.oninput();
 await click(f.query(action==='chat'?'[data-attention-chat]':'[data-attention-cancel]'));
 assert.equal(calls.length,1);assert.equal(f.drafts.size,1);
 assert.deepEqual(calls[0][1].answer,action==='chat'?{kind:'chat'}:undefined);
 const restored=fixture(askDialog,async()=>({ok:true}),{drafts:f.drafts});
 assert.equal(restored.query('[data-attention-input="custom:1"]').value,'retained typed answer');
 assert.equal(restored.nodes('input').find(node=>node.value==='Review logs').checked,true);
 const other=fixture({...askDialog,ownerId:'different-owner'},async()=>({ok:true}),{drafts:f.drafts});
 assert.equal(other.query('[data-attention-input="custom:1"]').value,'');
});
test('accepted answer stays settled even when the following refresh fails; no resend',async()=>{
 const calls=[];let refreshFails=false;
 const f=fixture({kind:'conversation',ownerId:'owner',interactionId:'interaction',question:{method:'input'}},async(...args)=>{calls.push(args);return {ok:true,value:{}};},{onRefresh:async()=>{if(refreshFails)throw Error('refresh failed');}});
 const input=f.nodes('input')[0];input.value='final answer';input.oninput();
 refreshFails=true;await submit(f);
 assert.equal(calls.length,1,'the answer was accepted exactly once');
 assert.equal(f.query('[data-attention-status]').dataset.state,'ok','an accepted answer stays visibly settled');
 await submit(f);
 assert.equal(calls.length,1,'a repeated submit after a failed refresh must not resend the answer');
});
test('confirmed cancellation is withheld when the source changed during confirmation',async()=>{
 const calls=[];let staleDuringDialog=false;
 const f=fixture({kind:'conversation',ownerId:'owner',interactionId:'interaction',question:{method:'input'}},async(...args)=>{calls.push(args);return {ok:true,value:{}};},{confirm:async()=>{if(staleDuringDialog)f.stale();return true;}});
 const cancel=f.nodes('button').find(button=>'attentionCancel' in button.dataset);
 staleDuringDialog=true;await click(cancel);
 assert.equal(calls.length,0,'a source that changed during confirmation must not receive the interruption');
 assert.equal(f.query('[data-attention-status]').dataset.state,'error','the withheld cancellation is visibly reported');
});
test('unsupported native methods have no fake submit or cancel',()=>{
 const f=fixture({kind:'conversation',question:{method:'custom'}},async()=>{throw Error('must not invoke');});
 assert.equal(f.nodes('button').some(b=>'attentionSubmit' in b.dataset||'attentionCancel' in b.dataset),false);
});
test('known native method without response capability has no answer controls',()=>{
 const f=fixture({kind:'conversation',question:{method:'input',capability:{respond:false,cancel:false,reason:'resolver absent'}}},async()=>{throw Error('must not invoke');});
 assert.equal(f.nodes('input').length,0);assert.equal(f.nodes('button').some(b=>'attentionSubmit' in b.dataset||'attentionCancel' in b.dataset),false);
});
test('native cancellation capability can independently hide cancel',()=>{
 const f=fixture({kind:'conversation',question:{method:'input',capability:{respond:true,cancel:false}}},async()=>{throw Error('must not invoke');});
 assert.equal(f.nodes('input').length,1);assert.equal(f.nodes('button').some(b=>'attentionSubmit' in b.dataset),true);assert.equal(f.nodes('button').some(b=>'attentionCancel' in b.dataset),false);
});

const routeDestination=(patch={})=>({kind:'frontdesk-route',proposalId:'proposal',expectedVersion:2,sourceJobId:'source-job',question:{method:'frontdesk-route',title:'处理方式决定',originalText:'修复 <calc> 后执行检查',remainingActions:'运行 checks/verify.mjs，不改检查脚本',reason:'剩余步骤需后台执行',completedOperations:[{ok:true,op:'apply',operationId:'saved-once',value:{relPath:'calc.mjs',revision:3}}]},...patch});
const chooseRoute=(f,action)=>{const input=f.query('[data-attention-route-action="'+action+'"]');for(const other of f.nodes('input'))other.checked=false;input.checked=true;input.onchange();return input;};
test('route todo exposes source, remainder and receipts with accessible explicit choices only',async()=>{
 const calls=[],destination=routeDestination(),f=fixture(destination,async(...args)=>{calls.push(args);return {ok:true,value:{accepted:true}};});
 assert.equal(f.query('[data-frontdesk-context="original"]').querySelector('pre').textContent,destination.question.originalText);
 assert.equal(f.query('[data-frontdesk-context="remaining"]').querySelector('pre').textContent,destination.question.remainingActions);
 assert.deepEqual(JSON.parse(f.query('[data-frontdesk-context="receipts"]').querySelector('pre').textContent),destination.question.completedOperations);
 const radios=f.nodes('input');assert.equal(radios.length,3);assert.ok(radios.every(input=>input.type==='radio'&&!input.checked));
 const group=f.query('[data-attention-choices]');assert.ok(group.querySelector('legend').textContent);assert.equal(group.querySelectorAll('label').length,3);assert.ok(group.querySelectorAll('label').every(label=>label.querySelector('input')&&label.querySelector('span').querySelector('span').textContent));
 assert.equal(f.query('[data-attention-submit]').type,'submit');assert.equal(f.query('[data-attention-status]').attributes.role,'status');
 await submit(f);assert.equal(calls.length,0,'Enter without a decision never defaults to approval');
 chooseRoute(f,'background');assert.equal(calls.length,0,'keyboard/radio selection alone never submits');await submit(f);
 assert.deepEqual(calls,[['managed.attention.respond',{projectId:'project',attentionKind:'frontdesk-route',attentionId:'proposal',expectedVersion:2,action:'background',sourceJobId:'source-job',requestKey:'attention:proposal:2:background'}]]);
 assert.equal(f.query('[data-attention-submit]').disabled,true);assert.equal(f.query('[data-attention-status]').dataset.state,'ok');
});
test('each route action uses the same version-bound authority; cancel never retries or sends conversation text',async()=>{
 for(const action of ['continue','cancel']){
  const calls=[],drafts=new Map([['main-conversation',{text:'unsent main draft',materials:['image']}]]),f=fixture(routeDestination(),async(...args)=>{calls.push(args);return {ok:true,value:{accepted:true}};},{drafts,onRefresh:async()=>{throw Error('offline refresh');}});
  chooseRoute(f,action);await submit(f);await submit(f);f.ui.update(f.todo);await submit(f);
  assert.equal(calls.length,1);assert.equal(calls[0][0],'managed.attention.respond');assert.equal(calls[0][1].action,action);assert.equal(calls[0][1].cancel,undefined);assert.equal(calls[0][1].text,undefined);
  assert.deepEqual(drafts.get('main-conversation'),{text:'unsent main draft',materials:['image']});assert.equal(f.query('[data-attention-submit]').disabled,true);
 }
});
test('route drafts stay attached to exact proposal version and source across refreshes',async()=>{
 const calls=[],destination=routeDestination(),f=fixture(destination,async(...args)=>{calls.push(args);return {ok:false,error:{code:'STALE_ATTENTION',message:'changed'}};});
 chooseRoute(f,'background');await submit(f);assert.equal(calls.length,1);assert.equal(f.query('[data-attention-status]').dataset.state,'error');
 const same=fixture(destination,async()=>({ok:true}),{drafts:f.drafts});assert.equal(same.query('[data-attention-route-action="background"]').checked,true);
 for(const patch of [{expectedVersion:3},{sourceJobId:'replacement-source'},{proposalId:'replacement-proposal'}]){
  const next=routeDestination(patch);f.ui.update({...f.todo,destination:next});await submit(f);assert.equal(calls.length,1);
  assert.equal(f.query('[data-attention-submit]').disabled,true);assert.equal(f.nodes('fieldset')[0].disabled,true);
  const replacement=fixture(next,async()=>({ok:true}),{drafts:f.drafts});assert.ok(replacement.nodes('input').every(input=>!input.checked),'old choice never applies to changed authority');
 }
 assert.equal(f.query('[data-attention-route-action="background"]').checked,true,'stale view preserves its own unsent draft');
});
test('route pending state locks duplicate submission and does not settle an unconfirmed receipt',async()=>{
 let release;const calls=[],f=fixture(routeDestination(),async(...args)=>{calls.push(args);return await new Promise(resolve=>{release=resolve;});});
 chooseRoute(f,'background');await submit(f);await submit(f);assert.equal(calls.length,1);assert.equal(f.query('[data-attention-conversation]').attributes['aria-busy'],'true');
 release({ok:true,value:{accepted:false}});await settle();assert.equal(f.query('[data-attention-status]').dataset.state,'error');assert.equal(f.query('[data-attention-submit]').disabled,false);assert.equal(f.query('[data-attention-route-action="background"]').checked,true);
});
test('native approve remains explicitly answerable from todo without default or terminal redirection',async()=>{
 const calls=[],f=fixture({kind:'conversation',ownerId:'worker-owner',interactionId:'approval',question:{method:'approve',prompt:{full:'读取指定文件，本次有效'}}},async(...args)=>{calls.push(args);return {ok:true,value:{}};});
 await submit(f);assert.equal(calls.length,0);assert.ok(f.nodes('input').every(input=>!input.checked));
 const deny=f.nodes('input').find(input=>input.value==='拒绝');deny.checked=true;deny.onchange();await submit(f);
 assert.deepEqual(calls,[['managed.attention.respond',{projectId:'project',todoId:'todo',answer:'deny'}]]);
 await submit(f);assert.equal(calls.length,1);
});

const permissionDestination=(patch={},questionPatch={})=>({kind:'effect-permission',requestId:'permission-request',expectedVersion:1,sourceJobId:'source-job',question:{method:'effect-permission',title:'敏感执行授权 · 等待你的决定',originalText:'写入系统标记并在 A 保存摘要',command:'/usr/bin/marker',args:['--write','/etc/marker.conf'],cwd:'/synthetic/project-a',elevation:'user',purpose:'原任务要求创建该标记',effectHash:'a'.repeat(64),...questionPatch},...patch});
const choosePermission=(f,action)=>{const input=f.query('[data-attention-permission-action="'+action+'"]');for(const other of f.nodes('input'))other.checked=false;input.checked=true;input.onchange();return input;};
test('permission denial and cancellation settle once without touching main or native answer drafts',async()=>{
 for(const action of ['deny','cancel']){
  const main={text:'leave unsent',attachments:['image']},native={text:'separate pending native answer'},drafts=new Map([['main',main],['native',native]]),calls=[];
  const f=fixture(permissionDestination(),async(...args)=>{calls.push(args);return {ok:true,value:{accepted:true}};},{drafts,onRefresh:async()=>{throw Error('refresh unavailable');}});
  choosePermission(f,action);await submit(f);await submit(f);f.ui.update(f.todo);await submit(f);
  assert.equal(calls.length,1);assert.equal(calls[0][1].action,action);assert.equal(calls[0][1].text,undefined);assert.equal(calls[0][1].answer,undefined);assert.equal(calls[0][1].cancel,undefined);
  assert.equal(drafts.get('main'),main);assert.equal(drafts.get('native'),native);assert.equal(drafts.size,2);assert.equal(f.query('[data-attention-submit]').disabled,true);
 }
});
test('changed permission version, request, source or scope cannot inherit a draft approval',async()=>{
 const calls=[],destination=permissionDestination(),f=fixture(destination,async(...args)=>{calls.push(args);return {ok:true,value:{accepted:true}};});choosePermission(f,'approve-once');
 const restored=fixture(destination,async()=>({ok:true}),{drafts:f.drafts});assert.equal(restored.query('[data-attention-permission-action="approve-once"]').checked,true);
 const replacements=[permissionDestination({expectedVersion:2}),permissionDestination({requestId:'another-request'}),permissionDestination({sourceJobId:'another-task'}),permissionDestination({}, {command:'/usr/bin/other'}),permissionDestination({}, {cwd:'/synthetic/project-c'}),permissionDestination({}, {args:['--different']}),permissionDestination({}, {elevation:'admin'}),permissionDestination({}, {effectHash:'b'.repeat(64)})];
 for(const destination of replacements){
  f.ui.update({...f.todo,destination});await submit(f);assert.equal(calls.length,0);assert.equal(f.query('[data-attention-submit]').disabled,true);
  const next=fixture(destination,async()=>({ok:true}),{drafts:f.drafts});assert.ok(next.nodes('input').every(input=>!input.checked));
 }
 assert.equal(f.query('[data-attention-permission-action="approve-once"]').checked,true,'the old view retains its own choice without transferring it');
});
test('permission failures preserve choice and deterministic identity, without automatically retrying',async()=>{
 const calls=[],f=fixture(permissionDestination(),async(...args)=>{calls.push(args);return {ok:false,error:{code:'STALE_ATTENTION',message:'Permission changed'}};});
 choosePermission(f,'approve-once');await submit(f);await settle();assert.equal(calls.length,1);assert.equal(f.query('[data-attention-status]').dataset.state,'error');assert.equal(f.query('[data-attention-permission-action="approve-once"]').checked,true);
 await submit(f);assert.deepEqual(calls[1],calls[0],'an explicit retry keeps the same version and idempotency identity');
 f.ui.update({...f.todo,status:'resolved'});await submit(f);assert.equal(calls.length,2);assert.equal(f.nodes('fieldset')[0].disabled,true);
});
test('incomplete permission review evidence never exposes approval controls',async()=>{
 for(const questionPatch of [{command:''},{cwd:''},{effectHash:'invalid'},{args:['ok',null]}]){
  const calls=[],f=fixture(permissionDestination({},questionPatch),async(...args)=>{calls.push(args);return {ok:true};});
  assert.equal(f.query('[data-attention-permission-action="approve-once"]'),null);await submit(f);assert.equal(calls.length,0);
 }
});

test('unlabeled native grant or plan options cannot turn an empty selection into approval',async()=>{
 for(const question of [{method:'approve',prompt:{grants:[{scope:'folder',label:'允许这个目录'}]}},{method:'plan',options:[{id:'execute'}]}]){
  const calls=[],f=fixture({kind:'conversation',ownerId:'owner',interactionId:'native-choice',question},async(...args)=>{calls.push(args);return {ok:true};});
  assert.ok(f.nodes('input').every(input=>!input.checked));await submit(f);assert.equal(calls.length,0);assert.equal(f.query('[data-attention-status]').dataset.state,'error');
 }
});

