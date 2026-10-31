import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
export const serve=async(handler)=>{
 const errors=[],requests=[];
 const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',async()=>{
  try{
   if(req.method==='GET'&&req.url.replace(/\?.*$/,'').endsWith('/models')){
    requests.push({listing:true,authorization:req.headers.authorization||null,'x-api-key':req.headers['x-api-key']||null,url:req.url});
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({object:'list',data:[{id:'scripted',name:'Scripted local fixture'},{id:'scripted-reasoner',name:'Scripted Reasoner'}]}));
    return;
   }
   const request=JSON.parse(body);Object.defineProperty(request,'authorization',{value:req.headers.authorization||null,enumerable:false});requests.push(request);const response=await handler(request,requests.filter(row=>!row.listing).length);
   if(res.destroyed)return;
   const calls=response.tools??(response.tool?[response]:[]),delta=calls.length?{role:'assistant',tool_calls:calls.map((call,index)=>({index,id:call.id,type:'function',function:{name:call.tool,arguments:JSON.stringify(call.args)}}))}:{role:'assistant',content:response.text??''};
   res.writeHead(200,{'content-type':'text/event-stream'});
   const id='fixture-'+requests.length;
   for(const [part,finish]of [[delta,null],[{},calls.length?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',choices:[{index:0,delta:part,finish_reason:finish}]})+'\n\n');
   res.end('data: [DONE]\n\n');
  }catch(error){errors.push(error);res.writeHead(500);res.end('local provider scenario failed');}
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let closed=false;
 return {url:`http://127.0.0.1:${server.address().port}/v1`,requests,errors,close:async()=>{if(closed)return;closed=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
};
export const prepare=async(url)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pi-real-')),cwd=path.join(root,'project'),home=path.join(root,'agents','worker'),agentDir=path.join(root,'pi-config');
 await Promise.all([fs.mkdir(cwd,{recursive:true}),fs.mkdir(home,{recursive:true}),fs.mkdir(agentDir,{recursive:true})]);
 await fs.writeFile(path.join(agentDir,'models.json'),JSON.stringify({providers:{'local-fixture':{baseUrl:url,api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Scripted local fixture',reasoning:false,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}}),{mode:0o600});
 return {root,cwd,home,agentDir};
};
