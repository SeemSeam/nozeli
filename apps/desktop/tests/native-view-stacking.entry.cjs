'use strict';
const assert=require('node:assert/strict');
const {app,View}=require('electron');
const {WorkspaceWindow}=require('../src/main/workspace-window.cjs');
app.whenReady().then(()=>{
 const win=new WorkspaceWindow({show:false,webPreferences:{sandbox:true}});
 const wrapper=new View(),guest=new View(),other=new View();
 win.contentView.addChildView(wrapper);
 win.contentView.addChildView(guest);
 assert.deepEqual(win.contentView.children,[win.chromeView,wrapper,guest],'guest must remain above its opaque document wrapper');
 win.contentView.addChildView(other);
 assert.deepEqual(win.contentView.children,[win.chromeView,wrapper,guest,other],'new content must not invert existing wrapper/guest order');
 win.contentView.removeChildView(guest);win.contentView.addChildView(guest);
 assert.deepEqual(win.contentView.children,[win.chromeView,wrapper,other,guest],'reattached guest must be above its wrapper');
 win.contentView.addChildView(new View(),1);
 assert.equal(win.contentView.children[0],win.chromeView,'explicit insertion preserves chrome at bottom');
 win.destroy();console.log('PASS real Electron native wrapper/guest stacking');app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
