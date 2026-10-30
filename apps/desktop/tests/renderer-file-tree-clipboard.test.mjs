import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source=(await readFile(new URL('../src/renderer/file-tree-actions.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export function mountFileTreeActions','function mountFileTreeActions');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  class Node {
    constructor(){this.dataset={};this.listeners={};this.children=[];this.attrs={};this.classList={contains:name=>name==='dir'&&this.directory,toggle(){},remove(){},add(){}};}
    setAttribute(name,value){this.attrs[name]=value;}
    append(...nodes){this.children.push(...nodes);}
    before(){} focus(){} select(){} close(){this.open=false;} showModal(){this.open=true;}
    addEventListener(name,fn){this.listeners[name]=fn;}
    querySelectorAll(){return [];}
    getBoundingClientRect(){return {left:0,bottom:20};}
    closest(selector){return selector==='button[data-path]'&&this.dataset.path!==undefined?this:null;}
  }
  const tree=new Node(),filter=new Node(),body=new Node(),more=new Node(),paste=new Node();
  let popup,project='p',clipboard={kind:'empty',generation:'0'},reads=0,refreshes=0;
  const requests=[],notices=[],calls=[];
  const document={getElementById:id=>id==='file-tree'?tree:filter,createElement:()=>new Node(),body};
  const context=vm.createContext({document,CSS:{escape:v=>v},panelButton:()=>more,panelMenuPosition:()=>({}),menuNotice:{notice:'help'},treeMenuItems:({canPaste})=>[{id:'paste',enabled:canPaste}],mountContextMenu:()=>popup={visible:false,menu:{querySelector:()=>paste},isOpen(){return this.visible;},open(items,options){this.visible=true;this.options=options;paste.disabled=items.find(item=>item.id==='paste').enabled===false;}}});
  vm.runInContext(source+';globalThis.mount=mountFileTreeActions;',context);
  context.mount({projectId:()=>project,invoke:async(name,args)=>{calls.push({name,args});if(name==='tree.clipboard.mark'){clipboard={kind:'internal',generation:'mark'};return {ok:true,value:{generation:'mark'}};}reads++;return {ok:true,value:clipboard};},perform:async request=>{requests.push(request);return fixtureState.result;},refresh:async()=>{refreshes++;},toast:value=>notices.push(value),selection:()=>[],visibility:()=>({showHidden:false})});
  const dialog=body.children[0],form=dialog.children[0],description=form.children[1];
  const fixtureState={tree,paste,popup,requests,notices,calls,dialog,description,result:{ok:true,value:{items:[{name:'file.txt',ok:true}],files:['file.txt']}},set clipboard(value){clipboard=value;},set project(value){project=value;},get reads(){return reads;},get refreshes(){return refreshes;},node(path,directory=true){const n=new Node();n.dataset.path=path;n.directory=directory;return n;},key(node,key,meta=false){tree.listeners.keydown({target:node,key,ctrlKey:!meta,metaKey:meta,preventDefault(){},stopPropagation(){}});},menu(node){tree.listeners.contextmenu({target:node,preventDefault(){},clientX:1,clientY:2});},confirm(){form.onsubmit({preventDefault(){}});}};
  return fixtureState;
}
const external=(ticket='one',names=['file.txt'])=>({kind:'external',ticket,generation:ticket,items:names.map(name=>({name}))});

test('menu reads clipboard asynchronously; paste rereads and confirms the actual ticket names',async()=>{
  const f=fixture(),folder=f.node('dest');f.clipboard=external();f.menu(folder);
  assert.equal(f.paste.disabled,true);await tick();assert.equal(f.paste.disabled,false);
  f.clipboard=external('two',['new folder','文档.txt']);f.popup.options.run('paste');await tick();
  assert.equal(f.reads,2);assert.match(f.description.textContent,/new folder、文档.txt → dest/);
  f.confirm();await tick();assert.deepEqual(JSON.parse(JSON.stringify(f.requests)),[{projectId:'p',action:'import',ticket:'two',target:'dest'}]);assert.equal(f.refreshes,1);
});

test('new external clipboard replaces a stale internal cut without deleting external sources',async()=>{
  const f=fixture(),file=f.node('source.txt',false);f.key(file,'x');await tick();
  assert.equal(f.calls[0].name,'tree.clipboard.mark');assert.equal(f.calls[0].args.projectId,'p');
  f.clipboard=external();f.key(f.tree,'v',true);await tick();f.confirm();await tick();
  assert.equal(f.requests[0].action,'import');assert.equal(f.requests[0].target,'');assert.equal(Object.hasOwn(f.requests[0],'source'),false);
});

test('internal cross-project cut remains a move when generation matches',async()=>{
  const f=fixture();f.result={ok:true,value:{}};f.key(f.node('source.txt',false),'x');await tick();f.project='other';f.key(f.node('dest'),'v');await tick();f.confirm();await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)),[{projectId:'other',sourceProjectId:'p',action:'cut',source:'source.txt',target:'dest'}]);
});

test('external partial completion reports failures and refreshes completed items',async()=>{
  const f=fixture();f.clipboard=external('partial',['good','bad']);f.result={ok:true,value:{items:[{name:'good',ok:true},{name:'bad',ok:false,error:{message:'already exists'}}],files:['good']}};
  f.key(f.tree,'v');await tick();f.confirm();await tick();assert.equal(f.refreshes,1);assert.match(f.notices.at(-1),/1\/2.*bad.*already exists/);assert.match(f.notices.at(-1),/源文件未删除/);
});

test('project switch during confirmation cancels paste; busy ignores duplicate shortcuts',async()=>{
  const f=fixture();f.clipboard=external();f.key(f.tree,'v');await tick();f.key(f.tree,'v');assert.equal(f.reads,1);f.project='other';f.confirm();await tick();assert.equal(f.requests.length,0);assert.match(f.notices.at(-1),/项目已切换/);
});

test('failed import refreshes without claiming success and releases busy',async()=>{
  const f=fixture();f.clipboard=external();f.result={ok:false,error:{message:'clipboard changed'}};f.key(f.tree,'v');await tick();f.confirm();await tick();assert.equal(f.refreshes,1);assert.equal(f.notices.at(-1),'clipboard changed');f.key(f.tree,'v');await tick();assert.equal(f.reads,2);
});

test('editable controls keep their native paste behavior',async()=>{
  const f=fixture();let prevented=false;
  f.tree.listeners.keydown({target:{closest:selector=>selector.startsWith('input')?{}:null},key:'v',ctrlKey:true,preventDefault(){prevented=true;},stopPropagation(){}});
  await tick();assert.equal(prevented,false);assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);
});
