// Synthetic GUI fault entry only. Loads the real production main/IPC/workspace.
// The production entry never imports this fixture and has no test fault IPC.
const path=require('node:path');
const fs=require('node:fs');
if(process.env.NOZELI_TEST_INSTANCE!=='1'||!process.env.NOZELI_USER_DATA)throw Error('isolated synthetic instance required');
const profile=path.resolve(process.env.NOZELI_USER_DATA),base=path.dirname(path.dirname(profile));
void (async()=>{
  const {FileTreeOps}=await import('../../src/main/file-tree-ops.mjs');
  const {createWindowsDesktopFileTreeIO}=await import('../../src/platform/windows/desktop-file-tree.mjs');
  const original=FileTreeOps.prototype.transferCrossEntry;
  FileTreeOps.prototype.transferCrossEntry=async function(input,surfaceContext){
    const faultPath=path.join(base,'live-fault.json'),fault=JSON.parse(fs.readFileSync(faultPath,'utf8'));
    const roots=[input.project.root,input.sourceProject.root].map(root=>path.resolve(root));
    if(roots.some(root=>path.dirname(root)!==base))throw Error('fault fixture cannot access a non-synthetic root');
    if(fault.source!==input.source||fault.action!==input.action||!['published','aborted','none'].includes(fault.mode))return original.call(this,input,surfaceContext);
    // Each explicit command faults at most once. No recovery/owner facts are
    // fabricated: native effects and paired receipt writes run normally.
    fs.writeFileSync(faultPath,JSON.stringify({...fault,mode:'none'}));
    const old=this.io;
    this.io={...old,...createWindowsDesktopFileTreeIO(this.host,{
      beforePublish:async()=>{if(fault.mode==='aborted')throw Object.assign(Error('synthetic pre-publication uncertainty'),{commitUnknown:true});},
      directorySync:parent=>{if(fault.mode==='published'&&fs.existsSync(path.join(input.project.root,input.destination)))parent.close();parent.syncDirectory();},
    })};
    try{return await original.call(this,input,surfaceContext);}finally{this.io=old;}
  };
  // The fixture is an executable entry, not a user-requested document.
  process.argv=process.argv.filter(arg=>path.resolve(arg)!==__filename);
  require('../../src/main/main.cjs');
})().catch(error=>{console.error(error);require('electron').app.exit(1);});
