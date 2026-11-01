import {open} from 'node:fs/promises';

// Linux directory durability barrier. A successful rename alone does not
// establish that the namespace update survived a crash.
export async function syncDirectory(directory){
 const handle=await open(directory,'r');
 try{await handle.sync();}finally{await handle.close();}
}
