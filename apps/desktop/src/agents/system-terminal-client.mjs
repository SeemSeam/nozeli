import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const {WebSocket}=createRequire(import.meta.url)('ws');
export async function run(){
 const ticket=process.argv[process.argv.indexOf('--ticket')+1];if(!ticket||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('请通过 Nozeli 在系统终端中打开此客户端。');
 const stat=await fs.lstat(ticket);if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid())))throw Error('无效终端票据权限');
 const {url,token}=JSON.parse(await fs.readFile(ticket,'utf8'));if(!/^ws:\/\/127\.0\.0\.1:\d+$/.test(url)||typeof token!=='string')throw Error('无效附着票据');
 const socket=new WebSocket(url,{headers:{Authorization:`Bearer ${token}`},maxPayload:2*1024*1024});
 const send=value=>{if(socket.readyState===1)socket.send(JSON.stringify(value));};
 const input=data=>{const text=String(data);for(let i=0;i<text.length;){let end=Math.min(i+8000,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;send({type:'input',data:text.slice(i,end)});i=end;}};
 const resize=()=>send({type:'resize',cols:Math.max(2,Math.min(500,process.stdout.columns||120)),rows:Math.max(2,Math.min(200,process.stdout.rows||32))});
 let ready=false;const timer=setTimeout(()=>socket.terminate(),15000);
 try{await new Promise((resolve,reject)=>{
  socket.on('open',()=>send({type:'hello'}));socket.on('error',reject);socket.on('close',resolve);
  socket.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='ready'){ready=true;clearTimeout(timer);process.stdin.setEncoding('utf8');process.stdin.setRawMode(true);process.stdin.on('data',input);process.stdout.on('resize',resize);process.stdout.write('\x1b[2J\x1b[H'+m.replay);resize();process.stdin.resume();}else if(m.type==='output')process.stdout.write(m.data);else if(m.type==='error')process.stderr.write('\r\n'+m.message+'\r\n');});
 });if(!ready)throw Error('系统终端未能接入原 Agent 会话。');}
 finally{clearTimeout(timer);process.stdin.off('data',input);process.stdout.off('resize',resize);process.stdin.setRawMode(false);process.stdin.pause();socket.terminate();process.stdout.write('\x1b[0m\r\nNozeli 终端已断开，Agent 仍由 Nozeli 管理。\r\n');}
}
