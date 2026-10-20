import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export async function residentHistoryPage({file,messages,offset=0,version}){
 if(!Number.isSafeInteger(offset)||offset<0)fail('HISTORY_OFFSET','Invalid history offset');
 const hash=createHash('sha256');let before;
 if(file){before=await fs.stat(file);for await(const bytes of createReadStream(file))hash.update(bytes);}
 else hash.update(JSON.stringify(messages??[]));
 const current=hash.digest('hex');if(version&&version!==current)fail('HISTORY_CHANGED','History changed; reload the original page');
 let total=0,text='',end=offset;const max=16000;
 const append=value=>{const start=total;total+=value.length;if(total<=offset||text.length>=max)return;const from=Math.max(0,offset-start);let take=value.slice(from,from+max-text.length);if(take&&/[\uD800-\uDBFF]/.test(take.at(-1)))take=take.slice(0,-1);text+=take;end=start+from+take.length;};
 if(file){
  const lines=readline.createInterface({input:createReadStream(file),crlfDelay:Infinity});
  for await(const line of lines){let entry;try{entry=JSON.parse(line);}catch{continue;}const message=entry.type==='message'?entry.message:entry.type==='custom_message'?{role:'user',content:entry.content}:null;if(!message||!['user','assistant'].includes(message.role))continue;const body=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(b=>b.type==='text').map(b=>b.text??'').join('\n'):'';if(body)append(message.role+': '+body+'\n\n');}
  const after=await fs.stat(file);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ino!==before.ino)fail('HISTORY_CHANGED','Native journal changed during read');
 }else for(const message of messages??[])append((message.speaker??'unknown')+': '+(message.text??'')+'\n\n');
 if(offset>total)fail('HISTORY_OFFSET','History offset exceeds original text');
 return {version:current,text,offset,endOffset:end,totalChars:total,nextOffset:end<total?end:null,truncated:end<total,readOnly:true};
}
