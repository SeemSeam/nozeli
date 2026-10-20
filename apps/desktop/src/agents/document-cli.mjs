import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const arg=(args,key)=>{const i=args.indexOf(key);return i<0?'':args[i+1]||'';};
export async function run(args=process.argv) {
  const runtimeFile=arg(args,'--runtime');
  if (!runtimeFile || !path.isAbsolute(runtimeFile)) throw new Error('use --runtime <absolute capability file> --read <project-relative file> [--out <snapshot.json>] OR --apply <snapshot.json> --edits <edits.json>');
  const runtime=JSON.parse(await fs.readFile(runtimeFile,'utf8'));
  const url=new URL(runtime.url);
  if (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.pathname!=='/document' || typeof runtime.token!=='string') throw new Error('invalid local document capability');
  const rel=arg(args,'--read'),snapshotFile=arg(args,'--apply'),editsFile=arg(args,'--edits');
  let body;
  if (rel && !snapshotFile) body={op:'read',relPath:rel};
  else if (snapshotFile && editsFile && !rel) {
    const snapshot=JSON.parse(await fs.readFile(path.resolve(snapshotFile),'utf8')),edits=JSON.parse(await fs.readFile(path.resolve(editsFile),'utf8'));
    if (typeof snapshot.readHandle!=='string' || !Array.isArray(edits)) throw new Error('a tool-generated snapshot and JSON edit array are required');
    const operationId=createHash('sha256').update(JSON.stringify({readHandle:snapshot.readHandle,edits})).digest('hex');
    body={op:'apply',readHandle:snapshot.readHandle,edits,operationId};
  } else throw new Error('choose --read OR --apply with --edits');
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+runtime.token},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const result=await response.json();
  if (!result.ok) { console.log(JSON.stringify(result));throw new Error(result.error?.message||'document tool failed'); }
  const output=arg(args,'--out');
  if (output) {
    // Never overwrite a previous read handle: an old candidate must remain bound
    // to the exact snapshot from which it was generated.
    await fs.writeFile(path.resolve(output),JSON.stringify(result.value,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({ok:true,snapshot:path.resolve(output),version:result.value.version}));
  } else console.log(JSON.stringify(result.value));
  return result.value;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) run().catch(error=>{console.error(error.message);process.exitCode=1;});
