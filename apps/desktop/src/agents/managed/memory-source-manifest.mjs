import {createHash} from 'node:crypto';

// Directory identity changes with selection/bindings; offsets never cross snapshots.
export function memorySourceManifest(work){
 const text=JSON.stringify({current:work.memorySources||[],bindings:work.memorySourceBindings||[]});
 const version=createHash('sha256').update(text).digest('hex');
 const key=`work/${work.id}/memory-sources/${version.slice(0,32)}`;
 return {text,version,key,readRef:`读取 稳定/${key}`};
}
