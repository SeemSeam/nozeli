// Resolve each entity through the registered storage authority. A shared
// ancestor of a profile and project is never an authorization boundary.
import {experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';

export function managedStorageLocation(storage,file,{code='HOST_SOURCE_UNSUPPORTED'}={}){
  const root=storage?.nativeRootForPath?.(file);
  if(process.platform!=='win32'||process.arch!=='x64'||typeof root!=='string')
    throw Object.assign(Error('Registered native Windows x64 storage scope required'),{code,automaticReplay:false});
  return {root,relative:experimentalPrivateDirectoryComponents(root,file).join('/')};
}
