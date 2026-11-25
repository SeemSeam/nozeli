// Reproducible narrow SDK patch. npm ci restores upstream; build accepts only
// exact locked upstream or exact already-patched bytes, never a local variant.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function patchSdk(root){
 const specs=[];
 for(const name of (await fs.readdir(path.join(root,'patches/sdk'))).filter(name=>name.endsWith('.json')).sort()){
  const spec=JSON.parse(await fs.readFile(path.join(root,'patches/sdk',name),'utf8'));
  const directory=path.join(root,'node_modules',...spec.package.split('/'));
  const installed=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));
  if(installed.name!==spec.package||installed.version!==spec.version)throw Error('SDK storage patch requires the exact locked package');
  specs.push({spec,directory});
 }
 const files=[];
 // Stage every JS and declaration output before writing any file. A rejected
 // late input must never leave earlier inputs partially patched.
 for(const {spec,directory} of specs)for(const row of spec.files){
  const file=path.join(directory,row.path),bytes=await fs.readFile(file),current=sha(bytes);
  if(current!==row.sha256){
   if(current!==row.upstreamSha256)throw Error('SDK storage patch input differs: '+row.path);
   let text=bytes.toString('utf8');
   for(const replacement of row.replacements){
    if(!text.includes(replacement.before))throw Error('SDK storage patch source missing: '+row.path);
    text=text.split(replacement.before).join(replacement.after);
   }
   if(sha(text)!==row.sha256)throw Error('SDK storage patch output differs: '+row.path);
   files.push({file,text});
  }
 }
 for(const {file,text} of files)await fs.writeFile(file,text);
 return specs.flatMap(({spec})=>spec.files);
}
