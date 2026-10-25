// Real private OMP startup for layout tests. Any inference is a fixture failure.
import http from 'node:http';
export async function configureNativeConversation(page){
 let inference=0;
 const server=http.createServer((req,res)=>{inference++;req.resume();res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'This UI fixture never admits model inference'}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const invoke=async(op,payload)=>{const result=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);if(!result.ok)throw Error(op+': '+result.error?.message);return result.value;};
 try{
  const configuration=await invoke('config.status',{});if(configuration.choiceRequired)await invoke('config.initialize',{mode:'independent'});
  await invoke('settings.providers.save',{provider:'native-ui-local',model:'no-inference',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',key:'synthetic-local-only',api:'openai-completions'});
  await invoke('settings.models.save',{frontdesk:'native-ui-local/no-inference',orchestrator:'native-ui-local/no-inference',worker:'native-ui-local/no-inference'});
  const scope=await invoke('workspace.bootstrap',{});if(!scope.projectId)throw Error('Native conversation fixture requires a bound project');
  await invoke('managed.enable',{projectId:scope.projectId});
 }catch(error){await new Promise(resolve=>server.close(resolve));throw error;}
 return async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(inference)throw Error('UI-only native fixture unexpectedly issued '+inference+' model request(s)');};
}
