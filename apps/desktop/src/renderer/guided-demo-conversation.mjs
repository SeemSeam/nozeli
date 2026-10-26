import {demoIdentity,unwrapDemo} from '../domain/guided-demo.mjs';
import {createSessionStore,sessionMessages} from './session-store.mjs';
import {mountSessionTimeline} from './session-timeline.mjs';

// A distinct fixture source, never a native managed session or Work.
export function mountDemoConversation({invoke,getProjectId,onMessages,onConversation,subscribe}){
  let session=null,generation=0,historyPage=false,state={works:[],receipts:[],jobs:[]};
  const store=createSessionStore();
  const container=document.createElement('section');container.id='demo-session-timeline';container.hidden=true;
  document.getElementById('conversation').append(container);
  const navigationContainer=document.createElement('div');navigationContainer.className='session-navigation-slot';navigationContainer.hidden=true;
  document.getElementById('compose-form').before(navigationContainer);
  const timeline=mountSessionTimeline(container,{navigationContainer});
  const messages=()=>sessionMessages(store.getLookupSnapshot(),state);
  const call=async(action,payload={},id=session?.projectId)=>{
    if(!id)throw Error('没有活动演示会话');
    return unwrapDemo(await invoke('managed.'+action,{...payload,projectId:id}));
  };
  async function readMessage(id){const result=await call('timeline.read',{id});return result.entry;}
  async function ensureMessage(id){
    if(store.has(id))return;
    const projectId=session?.projectId,seq=generation,entry=await readMessage(id);
    if(seq===generation&&projectId===session?.projectId){store.pin(entry);onMessages(messages(),source);}
  }
  async function ensureRequest(requestId){
    const projectId=session?.projectId,seq=generation;let offset=0;
    do{const page=await call('timeline.request',{requestId,offset},projectId);if(seq!==generation)return;await Promise.all(page.ids.map(ensureMessage));offset=page.nextOffset;}while(offset!=null);
  }
  const source={get projectId(){return session?.projectId;},getMessages:messages,readMessage,ensureMessage,ensureRequest};
  function paint(){
    if(!session)return;
    container.hidden=false;navigationContainer.hidden=false;
    timeline.render({store,state,projectId:session.projectId,call,historyPage,onPage:loadPage,onLatest:()=>loadPage()});
    onMessages(messages(),source);onConversation({state:'demo',label:'离线演示 · 非原生 Agent'});
  }
  async function loadPage(cursor){
    const projectId=session?.projectId,seq=generation,page=await call('timeline.page',{...(cursor?{cursor}:{}),limit:100},projectId);
    if(seq!==generation||getProjectId()!==projectId)return;
    historyPage=Boolean(cursor);store.apply(projectId,page,{replace:true});paint();
  }
  function clear(){generation++;session=null;store.reset(null);container.hidden=true;navigationContainer.hidden=true;historyPage=false;}
  async function bind(projectId){
    clear();const seq=generation,context=unwrapDemo(await invoke('demo.state',{projectId}));
    if(seq!==generation||getProjectId()!==projectId||!context.demo)return false;
    const status=await call('status',{},projectId);
    if(seq!==generation||getProjectId()!==projectId)return false;
    session=context.session;state=status.state;store.reset(projectId);await loadPage();return true;
  }
  async function send(text,context={}){
    if(!session||getProjectId()!==session.projectId)throw Error('演示项目归属已变化');
    const original=session,seq=generation;
    const result=unwrapDemo(await invoke('demo.send',{...demoIdentity(original),text,tags:context.tags,context,requestKey:crypto.randomUUID()}));
    if(seq===generation&&getProjectId()===original.projectId)await loadPage();
    return {...result,accepted:result.accepted===true,provenance:'demo-fixture'};
  }
  subscribe('demo.changed',event=>{if(session&&event.session?.projectId===session.projectId)session=event.session;});
  subscribe('agent',event=>{
    if(!session||event.projectId!==session.projectId||event.source!=='demo-fixture'||getProjectId()!==session.projectId)return;
    state=event.state;
    if(!historyPage&&state?.timeline)store.apply(session.projectId,state.timeline,{replace:true});
    paint();
  });
  return {bind,send,clear,get state(){return state;},get active(){return !!session;}};
}
