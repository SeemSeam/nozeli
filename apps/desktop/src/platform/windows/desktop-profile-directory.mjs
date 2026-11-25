// Desktop consumers can be given a fresh profile whose immediate parent
// already exists. Provision through the native parent chain with a private ACL;
// never create arbitrary missing ancestors or repair an existing entry's policy.
import path from 'node:path';
import {experimentalPrivateDirectoryComponents,ensureExperimentalPrivateDirectory} from './experimental-directories.mjs';

export async function ensureWindowsDesktopProfileDirectory(root,directory,options={}){
 experimentalPrivateDirectoryComponents(root,directory);
 try{return await ensureExperimentalPrivateDirectory(root,directory,options);}
 catch(error){
  // Only a missing anchor, before any allocation, permits this one alternate
  // anchor. The complete new chain is validated and retained by native HANDLEs.
  if(error.code!=='WIN32_IO_ERROR'||![2,3].includes(error.win32Code)||error.committed||Object.hasOwn(error,'createdDirectories'))throw error;
  const parent=path.dirname(root);
  if(parent===root)throw error;
  return ensureExperimentalPrivateDirectory(parent,directory,options);
 }
}
