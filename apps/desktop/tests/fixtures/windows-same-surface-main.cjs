// Synthetic GUI fault entry only. Loads the real production main/IPC/workspace.
// The production entry never imports this fixture and has no test fault IPC.
const path=require('node:path');
const fs=require('node:fs');
if(process.env.NOZELI_TEST_INSTANCE!=='1'||!process.env.NOZELI_USER_DATA)throw Error('isolated synthetic instance required');
const profile=path.resolve(process.env.NOZELI_USER_DATA),base=path.dirname(path.dirname(profile));
void (async()=>{
  const {FileTreeOps}=await import('../../src/main/file-tree-ops.mjs');
  const {createWindowsDesktopFileTreeIO}=await import('../../src/platform/windows/desktop-file-tree.mjs');
  const {CrossTreeSurfaceJournal}=await import('../../src/main/cross-tree-surface-journal.mjs');
  const originalRelease=CrossTreeSurfaceJournal.prototype.release,releaseCounts=new Map();
  CrossTreeSurfaceJournal.prototype.release=async function(hold,options){
    const faultPath=path.join(base,'live-fault.json'),fault=JSON.parse(fs.readFileSync(faultPath,'utf8'));
    if(fault.mode==='release-second'&&hold.source===fault.source&&options?.relocatedTo){
      const project=await this.workspace.host.requireProject(hold.sourceProjectId);
      if(path.dirname(path.resolve(project.root))!==base)throw Error('release fault cannot access non-synthetic root');
      const count=(releaseCounts.get(hold.operationId)??0)+1;releaseCounts.set(hold.operationId,count);
      if(count===2){fs.writeFileSync(faultPath,JSON.stringify({...fault,mode:'none'}));throw Error('synthetic second original surface release failed');}
    }
    return originalRelease.call(this,hold,options);
  };
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
  const originalSame=FileTreeOps.prototype.transferEntry;
  FileTreeOps.prototype.transferEntry=async function(project,input,surfaceContext){
    const faultPath=path.join(base,'live-fault.json'),fault=JSON.parse(fs.readFileSync(faultPath,'utf8'));
    if(path.dirname(path.resolve(project.root))!==base)throw Error('fault fixture cannot access a non-synthetic root');
    if(fault.source!==input.source||fault.action!==input.action||!['published','aborted','none'].includes(fault.mode))return originalSame.call(this,project,input,surfaceContext);
    fs.writeFileSync(faultPath,JSON.stringify({...fault,mode:'none'}));const old=this.io;
    this.io={...old,...createWindowsDesktopFileTreeIO(this.host,{
      beforePublish:async()=>{if(fault.mode==='aborted')throw Object.assign(Error('synthetic same-project pre-publication uncertainty'),{commitUnknown:true});},
      directorySync:parent=>{if(fault.mode==='published'&&fs.existsSync(path.join(project.root,input.destination)))parent.close();parent.syncDirectory();},
    })};
    try{return await originalSame.call(this,project,input,surfaceContext);}finally{this.io=old;}
  };
  // The fixture is an executable entry, not a user-requested document.
  process.argv=process.argv.filter(arg=>path.resolve(arg)!==__filename);
  require('../../src/main/main.cjs');
})().catch(error=>{console.error(error);require('electron').app.exit(1);});
