// Native file effects for a profile and separately selected project roots.
// ProjectStorage continues to own registration, recovery and catalog policy.
import path from 'node:path';
import {createRequire} from 'node:module';
import {createExperimentalProjectStorageIO} from './experimental-project-storage.mjs';
import {experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';
import {openExperimentalPrivateTree} from './experimental-private-tree.mjs';
import {ensureWindowsDesktopProfileDirectory} from './desktop-profile-directory.mjs';
const require=createRequire(import.meta.url);
const fail=(code,message)=>Object.assign(Error(message),{code});
const inside=(root,file)=>file===root||(!path.isAbsolute(path.relative(root,file))&&!path.relative(root,file).split(path.sep).includes('..'));
const same=(a,b)=>a&&b&&a.dev===b.dev&&a.ino===b.ino;
export function createWindowsDesktopProjectStorageIO(profile){
 if(process.platform!=='win32'||process.arch!=='x64')throw fail('FS_PLATFORM_UNSUPPORTED','Native Windows x64 project storage required');
 profile=path.resolve(profile);const projects=new Map(),adapters=new Map();let closed=false;
 const adapter=root=>{let io=adapters.get(root);if(!io){io=createExperimentalProjectStorageIO(root,{initialization:true});adapters.set(root,io);}return io;};
 const scope=file=>{
  if(closed)throw fail('STORAGE_CLOSED','Project storage scope is closed');
  if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file)throw fail('FS_PATH_REJECTED','Canonical absolute project path required');
  if(inside(profile,file))return profile;
  const entries=[...projects.values()].filter(row=>inside(row.root,file)).sort((a,b)=>b.root.length-a.root.length);
  const row=entries[0];if(!row)throw fail('PROJECT_SCOPE_REQUIRED','Path is outside the profile and selected projects');row.pin.verify();return row.anchor;
 };
 const authorizeProject=async(root,expected)=>{
  if(closed)throw fail('STORAGE_CLOSED','Project storage scope is closed');
  if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root||path.dirname(root)===root)throw fail('FS_PATH_REJECTED','Select a canonical project directory, not a volume root');
  if(inside(profile,root)||inside(root,profile))throw fail('PROJECT_ROOT_OVERLAP','Project and private profile must be disjoint');
  let row=projects.get(root);
  if(!row){
   const anchor=path.dirname(root),relative=experimentalPrivateDirectoryComponents(anchor,root).join('/');let pin;
   try{pin=require('../../../native/windows/build/Release/nozeli_windows_read.node').openAnchoredDirectoryIdentity(anchor,relative+'/__project_scope__');pin.verify();const [dev,ino]=pin.identity().split(':'),identity={dev,ino,kind:'windows-file-id-128'};
    if(expected&&!same(expected,identity))throw fail('PROJECT_IDENTITY_CONFLICT','Registered project directory changed');
    row={root,anchor,identity,pin};projects.set(root,row);pin=null;
   }finally{pin?.close();}
  }
  row.pin.verify();if(expected&&!same(expected,row.identity))throw fail('PROJECT_IDENTITY_CONFLICT','Registered project directory changed');return row.identity;
 };
 const route=name=>(file,...args)=>adapter(scope(file))[name](file,...args);
 return Object.freeze({
  rootForPath:scope,authorizeProject,
  close(){for(const row of projects.values())row.pin.close();projects.clear();closed=true;},
  requireInitialization(){if(closed)throw fail('STORAGE_CLOSED','Project storage scope is closed');},
  qualification:Object.freeze({state:'barriers-completed',durability:'namespace-not-qualified',scope:'profile-and-selected-projects'}),
  retainsPartialTrees:true,
  pinDirectory:route('pinDirectory'),directoryIdentity:route('directoryIdentity'),checkedMetadata:route('checkedMetadata'),
  readJson:route('readJson'),writeJson:route('writeJson'),syncTree:route('syncTree'),assertTree:route('assertTree'),
  privateDirectory(directory,options){const root=scope(directory);return root===profile?ensureWindowsDesktopProfileDirectory(profile,directory,options):adapter(root).privateDirectory(directory,options);},
  syncDirectory:route('syncDirectory'),requireSourceStopped:route('requireSourceStopped'),
  rejectLinks:route('rejectLinks'),retireStage:route('retireStage'),writeExclusive:route('writeExclusive'),removeTree:route('removeTree'),
  async createStage(directory,options){
   if(options.source&&scope(options.source)!==scope(directory))throw fail('PROJECT_SCOPE_REQUIRED','Stage source must belong to the same selected project');
   return adapter(scope(directory)).createStage(directory,options);
  },
  async copyTree(source,destination){
   const from=scope(source),to=scope(destination),tree=await openExperimentalPrivateTree(from,source);
   try{return {sourceTree:{identity:tree.manifest.rootIdentity,manifestSha256:tree.manifest.sha256},copy:await tree.copyTo(destination,{destinationRoot:to})};}finally{tree.close();}
  },
  async moveTree(source,destination,expected){
   const from=scope(source),to=scope(destination);if(from!==to)throw fail('PROJECT_SCOPE_REQUIRED','Project publication must stay within its selected root');
   return adapter(from).moveTree(source,destination,expected);
  },
 });
}
