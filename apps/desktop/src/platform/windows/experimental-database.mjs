// Explicit qualification only. Production StorageDatabase does not select this.
import path from 'node:path';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';

export function openExperimentalDatabaseLease(root,file,{mustExist=false}={}) {
  if (typeof root!=='string'||typeof file!=='string'||!path.isAbsolute(root)||!path.isAbsolute(file))
    throw Object.assign(Error('Absolute private root and database path required'),{code:'FS_PATH_REJECTED'});
  const relative=path.relative(root,file);
  if (!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))
    throw Object.assign(Error('Database must be inside its explicit private root'),{code:'FS_PATH_REJECTED'});
  const parent=openExperimentalPersistenceParent(root,relative.split(path.sep).join('/'));
  try {return parent.openPrivateDatabase(path.basename(file),mustExist);}
  finally {parent.close();}
}
