import test from 'node:test';
import assert from 'node:assert/strict';
import {createInflightReads,createIdentityHydration,createDiscussionDrafts,createProjectFiles,restoredComposerDraft,bindComposerDrafts,ownsDiscussionReceipt} from '../src/renderer/surface-identity-state.mjs';
import {makeOriginalReplyReader} from '../src/renderer/tag-original-reader.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
import {mountArchivePages} from '../src/renderer/archive-pages.mjs';
import {createSessionStore,sessionMessages} from '../src/renderer/session-store.mjs';
import {createTagSessionProjection} from '../src/renderer/tag-session-projection.mjs';

test('restored workspace drafts override stale managed drafts including explicit empty projects',()=>{
 assert.equal(restoredComposerDraft({draft:'restored B',local:'old A',durable:'host B'}),'restored B');
 assert.equal(restoredComposerDraft({draft:'',local:'old A'}),'');
 assert.equal(restoredComposerDraft({}),'');
});

test('native composer input persists during deferred Agent initialization and survives late restoration',async()=>{
 const composer=new EventTarget();composer.value='';
 const initialization=deferred(),write=deferred(),local=new Map(),durable=new Map(),calls=[];
 let active=false,identity={projectId:'A',target:'frontdesk'};
 const writer=bindComposerDrafts({composer,current:()=>identity,remember:d=>local.set(d.projectId,d.text),persist:async d=>{calls.push(d);await write.promise;durable.set(d.projectId,d.text);},onInput:()=>{},onError:error=>{throw error;}});
 const loading=initialization.promise.then(()=>{active=true;composer.value=restoredComposerDraft({local:local.get('A'),durable:undefined});});
 composer.value='UNSENT_MAIN_ALPHA';composer.dispatchEvent(new Event('input'));
 await Promise.resolve();await Promise.resolve();
 assert.equal(active,false);assert.deepEqual(calls,[{projectId:'A',target:'frontdesk',text:'UNSENT_MAIN_ALPHA'}]);
 initialization.resolve();await loading;
 assert.equal(composer.value,'UNSENT_MAIN_ALPHA');
 write.resolve();await writer.settled();assert.equal(durable.get('A'),'UNSENT_MAIN_ALPHA');
 // Input queued before a project switch must not be redirected to the new one.
 composer.value='A newer draft';composer.dispatchEvent(new Event('input'));
 identity={projectId:'B',target:'frontdesk'};composer.value='UNSENT_MAIN_BETA';composer.dispatchEvent(new Event('input'));
 await writer.settled();assert.equal(durable.get('A'),'A newer draft');assert.equal(durable.get('B'),'UNSENT_MAIN_BETA');
 composer.value='';composer.dispatchEvent(new Event('input'));await writer.settled();assert.equal(durable.get('B'),'');
});

test('failed native draft writes report once and do not block newer captured input',async()=>{
 const composer=new EventTarget(),errors=[],saved=[];let attempts=0;
 const writer=bindComposerDrafts({composer,current:()=>({projectId:'A',target:'frontdesk'}),remember:()=>{},persist:async d=>{if(++attempts===1)throw Error('disk failed');saved.push(d.text);},onInput:()=>{},onError:error=>errors.push(error.message)});
 composer.value='first';composer.dispatchEvent(new Event('input'));composer.value='second';composer.dispatchEvent(new Event('input'));
 await writer.settled();assert.deepEqual(errors,['disk failed']);assert.deepEqual(saved,['second']);
});

test('identity hydration deduplicates only inflight and rereads after eviction or rejection',async()=>{
 const reads=createInflightReads(),gate=deferred();let count=0;
 const one=reads.run('p:m',()=>{count++;return gate.promise;});
 assert.equal(reads.run('p:m',()=>{throw Error('duplicate');}),one);gate.resolve();await one;
 await reads.run('p:m',()=>{count++;});assert.equal(count,2);
 await assert.rejects(reads.run('p:m',()=>Promise.reject(Error('missing'))));
 await reads.run('p:m',()=>{count++;});assert.equal(count,3);
});

test('colliding project/tag identifiers isolate pending versions and late receipts',()=>{
 const drafts=createDiscussionDrafts(),tag={},token=Symbol();
 drafts.set('a:b','c',{version:9,pendingToken:token});drafts.set('a','b:c',{version:1});
 assert.equal(drafts.get('a','b:c').version,1);assert.equal(drafts.get('a:b','c').version,9);
 const receipt={projectId:'a:b',currentProjectId:'a',tag,currentTag:tag,state:drafts.get('a:b','c'),token};
 assert.equal(ownsDiscussionReceipt(receipt),false);receipt.currentProjectId='a:b';assert.equal(ownsDiscussionReceipt(receipt),true);
 receipt.currentTag={};assert.equal(ownsDiscussionReceipt(receipt),false);
 drafts.delete('a:b','c');assert.equal(drafts.get('a','b:c').version,1);
});

test('file reference listings fence project switches, same-project reloads and refresh races',async()=>{
 let identity={projectId:'a',generation:1};const gates=[],applied=[];
 const refresh=createProjectFiles({current:()=>identity,list:()=>{const gate=deferred();gates.push(gate);return gate.promise;},apply:set=>applied.push([...set])});
 const result=path=>({ok:true,value:{entries:[{kind:'file',relPath:path},{kind:'dir',relPath:'dir'}]}});
 const a=refresh();identity={projectId:'b',generation:2};const b=refresh();gates[0].resolve(result('a'));gates[1].resolve(result('b'));await Promise.all([a,b]);assert.deepEqual(applied,[['b']]);
 const old=refresh();identity={projectId:'b',generation:3};gates[2].resolve(result('old-b'));await old;assert.equal(applied.length,1);
 const first=refresh(),second=refresh();gates[4].resolve(result('new'));await second;gates[3].resolve(result('stale'));await first;assert.deepEqual(applied,[['b'],['new']]);
});

class Element {constructor(tag){this.tag=tag;this.children=[];this.style={};this.value='';this.textContent='';}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}}
const document={createElement:tag=>new Element(tag)};
test('tag original reader fetches explicit bounded versioned pages and retains only visible page',async()=>{
 const calls=[];const root=makeOriginalReplyReader(async options=>{calls.push(options);if(!options)return {read:{version:'digest',fields:[{field:'text',totalBytes:8}]}};return {field:'text',offset:options.offset,nextOffset:options.offset===0?4:null,totalBytes:8,content:options.offset===0?'one!':'two!'};},document);
 const [status,open,fields,previous,next,close,content]=root.children;
 assert.equal(calls.length,0);await open.onclick();assert.deepEqual(calls[1],{version:'digest',field:'text',offset:0,limit:16384});assert.equal(content.textContent,'one!');
 await next.onclick();assert.equal(content.textContent,'two!');assert.equal(next.disabled,true);await previous.onclick();assert.equal(content.textContent,'one!');close.onclick();assert.equal(content.textContent,'');assert.equal(content.hidden,true);
});
test('tag original read errors stop until explicit user retry',async()=>{
 let count=0;const root=makeOriginalReplyReader(async()=>{count++;throw Error('offline');},document);
 await root.children[1].onclick();assert.equal(count,1);assert.match(root.children[0].textContent,/offline/);await Promise.resolve();assert.equal(count,1);
});

test('resident and worker archive pager replaces bounded pages and sends version on previous/next',async()=>{
 const body=new Element('section'),calls=[],errors=[];let current=true;
 mountArchivePages(body,{text:'first',offset:0,nextOffset:5,version:'v',totalChars:11},async options=>{calls.push(options);return {text:options.offset?'second':'first',offset:options.offset,nextOffset:options.offset?null:5,version:'v',totalChars:11};},()=>current,{document,onError:error=>errors.push(error)});
 const [,pre,previous,next]=body.children;assert.equal(previous.disabled,true);await next.onclick();assert.equal(pre.textContent,'second');assert.equal(next.disabled,true);await previous.onclick();assert.equal(pre.textContent,'first');assert.deepEqual(calls,[{offset:5,version:'v'},{offset:0,version:'v'}]);current=false;await next.onclick();assert.equal(calls.length,2);assert.equal(errors.length,0);
});

test('late archive pages and changed versions never overwrite current content',async()=>{
 const body=new Element('section'),gate=deferred(),errors=[];let current=true;
 mountArchivePages(body,{text:'first',nextOffset:5,version:'v'},()=>gate.promise,()=>current,{document,onError:error=>errors.push(error)});
 const read=body.children[3].onclick();current=false;gate.resolve({text:'late',version:'v'});await read;assert.equal(body.children[1].textContent,'first');
 const other=new Element('section');mountArchivePages(other,{text:'original',nextOffset:5,version:'v'},async()=>({text:'wrong',version:'changed'}),()=>true,{document,onError:error=>errors.push(error)});await other.children[3].onclick();assert.equal(other.children[1].textContent,'original');assert.equal(errors.length,1);
});

test('more than 64 historical tags hydrate once, evictions expose explicit reads without pin churn',async()=>{
 const store=createSessionStore(),hydration=createIdentityHydration();store.reset('p');
 const tags=Array.from({length:80},(_,n)=>({id:'tag'+n,projectId:'p',messageId:'m'+n,requestId:'r'+n,status:'completed'}));
 let reads=0;const pending=[];
 const read=async id=>{reads++;return {id,target:'frontdesk',speaker:'agent',jobId:'r'+id.slice(1),text:'body '+id,durable:true,read:{version:'v'+id,fields:[{field:'text',totalBytes:12}]}};};
 const source={projectId:'p',getMessages:()=>sessionMessages({entries:[...new Map([...hydration.entries(),...store.getLookupSnapshot().entries].map(entry=>[entry.id,entry])).values()]}),ensureMessage:id=>{const request=hydration.ensure(id,{has:key=>store.has(key),read,pin:entry=>store.pin(entry)});pending.push(request);return request;},readMessage:(id)=>read(id)};
 const projection=createTagSessionProjection({currentProjectId:()=> 'p',tags:()=>tags,persistTag:()=>{},renderTags:()=>{}});
 store.subscribe(()=>projection.apply([],source));projection.apply([],source);
 await Promise.all(pending);await Promise.resolve();
 assert.equal(reads,80);assert.equal(hydration.entries().length,80);assert.equal(store.getLookupSnapshot().entries.length,64);
 assert.equal(tags[0].replyAvailability,'read-required');assert.equal(tags[0].status,'completed');assert.equal(tags[0].replyText,'');
 projection.apply([],source);await Promise.all(pending);assert.equal(reads,80);
 const original=await tags[0].readReply();assert.equal(original.text,'body m0');assert.equal(reads,81);
 assert.equal(store.getLookupSnapshot().entries.length,64);assert.equal(tags[0].replyText,'');
});

test('automatic descriptor budget saturates without retry loops; explicit identities remain readable',async()=>{
 const hydration=createIdentityHydration({limit:2});let reads=0;
 const options={has:()=>false,read:async id=>{reads++;return {id,text:'not retained'};},pin:()=>{}};
 for(let turn=0;turn<3;turn++)for(const id of ['a','b','c'])await hydration.ensure(id,options);
 assert.equal(reads,2);assert.equal(hydration.entries().length,2);assert(hydration.entries().every(entry=>entry.text===''));
 hydration.clear();await hydration.ensure('c',options);assert.equal(reads,3);
});

test('automatic hydration failure waits for user action and late prior-generation reads cannot pin',async()=>{
 const hydration=createIdentityHydration(),gate=deferred();let reads=0,pins=0,errors=0;
 const failure={has:()=>false,read:async()=>{reads++;throw Error('offline');},pin:()=>pins++,onError:()=>errors++};
 await hydration.ensure('failed',failure);await hydration.ensure('failed',failure);assert.equal(reads,1);assert.equal(errors,1);
 const old=hydration.ensure('late',{has:()=>false,read:()=>gate.promise,pin:()=>pins++});
 await Promise.resolve();hydration.clear();gate.resolve({id:'late',text:'old project'});await old;
 assert.equal(pins,0);assert.deepEqual(hydration.entries(),[]);
 const tag={id:'t',projectId:'p',messageId:'beyond-budget',requestId:'r',status:'completed'};let explicit=0;
 const projection=createTagSessionProjection({currentProjectId:()=> 'p',tags:()=>[tag],persistTag:()=>{},renderTags:()=>{}});
 projection.apply([],{projectId:'p',getMessages:()=>[],ensureMessage:()=>Promise.resolve(),readMessage:async id=>{explicit++;return {id};}});
 assert.equal(tag.replyAvailability,'read-required');assert.equal(tag.status,'completed');assert.equal((await tag.readReply()).id,'beyond-budget');assert.equal(explicit,1);
});
