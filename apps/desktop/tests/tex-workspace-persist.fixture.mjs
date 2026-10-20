// DOM/IPC fixture only; persistence logic is imported from the production module unchanged.
import {register} from 'node:module';
register('./tex-workspace-css.fixture.mjs',import.meta.url);
const {mountTexWorkspace}=await import('../src/renderer/tex-workspace.mjs');
export const deferred=()=>{let resolve,reject;return {promise:new Promise((a,b)=>{resolve=a;reject=b;}),resolve,reject};};
export async function createTexPersistFixture({context={project:{id:'project-a'},file:{kind:'text',relPath:'main.tex'}},root='main.tex'}={}){
 const nodes=new Map();
 class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.style={};this.hidden=false;this.disabled=false;this.value='';this.checked=false;this.textContent='';this.scrollTop=0;this.handlers=new Map();this.attrs={};const classes=new Set();this.classList={add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n)),toggle:(name,value)=>value===undefined?(classes.has(name)?(classes.delete(name),false):(classes.add(name),true)):value?(classes.add(name),true):(classes.delete(name),false),contains:name=>classes.has(name)};}
  set id(value){this._id=value;nodes.set(value,this);}get id(){return this._id;}
  set innerHTML(value){this._html=value;for(const match of value.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)){const el=new Element(match[1]);el.id=match[2];this.append(el);}}
  get innerHTML(){return this._html||'';}
  append(...values){this.children.push(...values);for(const value of values)if(value&&typeof value==='object')value.parentElement=this;}
  before(...values){this.beforeNodes=values;}
  replaceChildren(...values){this.children=[];this.append(...values);}
  setAttribute(k,v){this.attrs[k]=String(v);}
  addEventListener(type,fn){const list=this.handlers.get(type)||[];list.push(fn);this.handlers.set(type,list);}
  removeEventListener(type,fn){this.handlers.set(type,(this.handlers.get(type)||[]).filter(x=>x!==fn));}
  querySelector(selector){if(selector==='.compare-switch')return this.compareSwitch??=new Element();return null;}
  querySelectorAll(){return [];}
  emit(type){return Promise.all((this.handlers.get(type)||[]).map(fn=>fn({target:this})));}
 }
 const document={createElement:tag=>new Element(tag),getElementById:id=>{if(!nodes.has(id)){const el=new Element();el.id=id;}return nodes.get(id);}};
 const calls=[],handlers=new Map(),events=new Map();let current=context,contextError=null;
 const config={root,engine:'xelatex',automatic:false};
 const invoke=async(op,args)=>{
  calls.push({op,args:structuredClone(args)});if(handlers.has(op))return handlers.get(op)(args);
  if(op==='tex.inspect')return {ok:true,value:{config:structuredClone(config),configuredRoot:config.root,texFiles:['main.tex','other.tex'],tools:{xelatex:true,pdflatex:true},state:{projectId:args.projectId,phase:'idle',message:'CURRENT_READY'},view:{page:2,zoom:1.25,scrollTop:40,preview:false,linked:true},syncTool:false}};
  if(op==='tex.configure')return {ok:true,value:{root:args.root,engine:args.engine,automatic:args.automatic}};
  if(op==='tex.view')return {ok:true,value:{persistedView:structuredClone(args.view)}};
  throw Error('unexpected IPC in persist fixture: '+op);
 };
 globalThis.document=document;globalThis.window={nozeli:{invoke,subscribe:(name,fn)=>{events.set(name,fn);return ()=>events.delete(name);}}};globalThis.Option=class extends Element{constructor(text,value){super('option');this.textContent=text;this.value=value;}};
 const beside={tex:false,pdf:null};let closed=0;
 const workspace=mountTexWorkspace({getContext:()=>{if(contextError)throw contextError;return current;},beside,closeBeside:()=>{closed++;beside.tex=false;beside.pdf=null;},openFile:async()=>{throw Error('persist must not navigate source');}});
 return {workspace,beside,calls,handlers,config,node:id=>document.getElementById(id),get context(){return current;},set context(value){current=value;},set contextError(value){contextError=value;},get closed(){return closed;},message:()=>document.getElementById('tex-status').textContent,
  async enter(){await workspace.enter();},
  async changeRoot(next){document.getElementById('tex-root').value=next;await document.getElementById('tex-root').emit('change');},
  preview({page=4,zoom=1.5,scrollTop=123}={}){beside.tex=true;beside.pdf={current:()=>page,zoomLevel:()=>zoom};document.getElementById('secondary-scroll').scrollTop=scrollTop;},
  async cleanup(){handlers.clear();contextError=null;workspace.leave();await Promise.resolve();await Promise.resolve();}
 };
}
