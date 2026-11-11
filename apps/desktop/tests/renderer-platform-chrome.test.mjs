import test from 'node:test';
import assert from 'node:assert/strict';
import {windowControls,usesNativeWindowChrome} from '../src/renderer/window-chrome.mjs';
import {menuShortcut} from '../src/renderer/context-menu.mjs';

// Platform simulation verifies renderer branching only, never native macOS chrome.
test('platform chrome creates no HTML window buttons on macOS; other platforms retain actions',async()=>{
  const previous={document:globalThis.document,nozeli:globalThis.nozeli};
  const created=[];
  const node=tag=>({tag,children:[],dataset:{},attributes:{},append(child){this.children.push(child);},setAttribute(key,value){this.attributes[key]=value;}});
  globalThis.document={createElement(tag){created.push(tag);return node(tag);},createDocumentFragment(){return node('#fragment');}};
  try{
    for(const platform of ['darwin','win32','linux']){
      globalThis.nozeli={platform};created.length=0;const requests=[];
      const controls=windowControls(async(op,payload)=>{requests.push({op,payload});return {ok:true};});
      assert.equal(usesNativeWindowChrome(),platform==='darwin');
      if(platform==='darwin'){assert.deepEqual(created,[]);assert.equal(controls.children.length,0);}
      else{
        assert.deepEqual(controls.children.map(button=>button.dataset.windowAction),['minimize','maximize','close']);
        for(const button of controls.children){assert(button.attributes['aria-label']);await button.onclick();}
        assert.deepEqual(requests.map(request=>request.payload.action),['minimize','maximize','close']);
      }
      assert.equal(menuShortcut('Ctrl/Cmd+Enter'),platform==='darwin'?'⌘+Enter':'Ctrl+Enter');
      assert.equal(menuShortcut('Ctrl / Cmd + Shift + F11'),platform==='darwin'?'⌘ + Shift + F11':'Ctrl + Shift + F11');
      assert.equal(menuShortcut('Ctrl+K'),'Ctrl+K','do not relabel Control-only bindings');
    }
  }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
