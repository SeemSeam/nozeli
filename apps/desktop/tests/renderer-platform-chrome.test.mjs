import test from 'node:test';
import assert from 'node:assert/strict';
import {windowControls,usesNativeWindowChrome} from '../src/renderer/window-chrome.mjs';
import {menuShortcut} from '../src/renderer/context-menu.mjs';

// Platform simulation verifies renderer branching only, not OS caption behavior.
test('platform chrome uses OS controls on macOS and Windows and retains HTML actions on Linux',async()=>{
  const previous={document:globalThis.document,nozeli:globalThis.nozeli};
  const created=[];
  // Match the action-button DOM fixture used by surface-identity-state tests:
  // render the production SVG and tooltip metadata rather than stubbing actions.
  const node=(tag,namespaceURI)=>{
    const classes=new Set();
    return {tag,namespaceURI,ownerDocument:globalThis.document,children:[],dataset:{},attributes:{},
      classList:{add:(...names)=>names.forEach(name=>classes.add(name)),toggle(name,force){if(force)classes.add(name);else classes.delete(name);return Boolean(force);},contains:name=>classes.has(name)},
      append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[...children];},
      setAttribute(key,value){this.attributes[key]=String(value);},getAttribute(key){return this.attributes[key]??null;},removeAttribute(key){delete this.attributes[key];},
      querySelector(selector){const match=/^:scope > \.([\w-]+)$/.exec(selector);assert(match,'Unsupported fixture selector: '+selector);return this.children.find(child=>child.classList.contains(match[1])||String(child.className||'').split(' ').includes(match[1]))??null;}};
  };
  globalThis.document={createElement(tag){created.push(tag);return node(tag);},createElementNS(namespaceURI,tag){return node(tag,namespaceURI);},createDocumentFragment(){return node('#fragment');},addEventListener(){}};
  try{
    for(const platform of ['darwin','win32','linux']){
      globalThis.nozeli={platform};created.length=0;const requests=[];
      const controls=windowControls(async(op,payload)=>{requests.push({op,payload});return {ok:true};});
      assert.equal(usesNativeWindowChrome(),platform!=='linux');
      if(platform!=='linux'){assert.deepEqual(created,[]);assert.equal(controls.children.length,0);}
      else{
        assert.deepEqual(controls.children.map(button=>button.dataset.windowAction),['minimize','maximize','close']);
        for(const button of controls.children){
          assert(button.getAttribute('aria-label'));
          assert(button.querySelector(':scope > .ui-icon'));
          assert(button.dataset.action);
          await button.onclick();
        }
        assert.deepEqual(requests.map(request=>request.payload.action),['minimize','maximize','close']);
      }
      assert.equal(menuShortcut('Ctrl/Cmd+Enter'),platform==='darwin'?'⌘+Enter':'Ctrl+Enter');
      assert.equal(menuShortcut('Ctrl / Cmd + Shift + F11'),platform==='darwin'?'⌘ + Shift + F11':'Ctrl + Shift + F11');
      assert.equal(menuShortcut('Ctrl+K'),'Ctrl+K','do not relabel Control-only bindings');
    }
  }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
