import {createInterface} from 'node:readline';
import {OwnerRuntime} from './bridge.mjs';
import path from 'node:path';

const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
console.log=(...args)=>console.error(...args);
const runtime=new OwnerRuntime({send});
// Explicit Windows launches carry the shared host token into the original
// process. Responses in retained output can then be bound without trusting a
// mutable cold database declaration. This is identity evidence, not replay.
const launchIdentity=(()=>{
 const values=[process.env.NOZELI_PI_OWNER_ID,process.env.NOZELI_PI_OWNER_GENERATION,process.env.NOZELI_PI_LAUNCH_ID];
 if(!process.env.NOZELI_PI_LAUNCH_ID&&!process.env.NOZELI_PI_OWNER_GENERATION)return null;
 const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
 const home=process.env.NOZELI_PI_OWNER_HOME,agentDir=process.env.PI_CODING_AGENT_DIR;
 if(!values.every(uuid)||!path.isAbsolute(home??'')||!path.isAbsolute(agentDir??''))throw Object.assign(Error('Invalid prepared owner launch identity'),{code:'PI_LAUNCH_CONTRACT_INVALID'});
 return Object.freeze({schema:1,ownerId:values[0],generation:values[1],launchId:values[2],home,agentDir,cwd:process.cwd()});
})();
const respond=(frame,result)=>send({id:frame.id,result,...(launchIdentity?{method:frame.method,ownerLaunch:launchIdentity}:{})});
const methods={inspectRecovery:'inspectRecovery',recover:'recover',start:'start',prompt:'prompt',cancel:'cancel',respond:'respond',model:'model',reload:'reload',compact:'compact',flush:'flush',status:'status',activity:'activity',models:'modelsList',providerList:'providerList',providerUpsert:'providerUpsert',providerRemove:'providerRemove',providerDiscover:'providerDiscoverModels',authSetKey:'authSetKey',authDisable:'authDisable',authList:'authList',authLogin:'authLogin'};
let stopping=false;
async function stop(){
 if(stopping)return;stopping=true;
 const force=setTimeout(()=>process.exit(1),10000);force.unref();
 try{await runtime.stop();}finally{clearTimeout(force);process.exit(0);}
}
process.stdout.on('error',()=>void stop());
async function dispatch(frame){
 if(frame&&typeof frame.id==='string'&&!frame.method){
  await runtime.respond({id:frame.id,...('result'in frame?{result:frame.result}:{error:frame.error})});return;
 }
 if(!frame||typeof frame.id!=='string'||typeof frame.method!=='string')throw Object.assign(Error('Invalid Pi request'),{code:'PI_PROTOCOL_INVALID'});
 if(frame.method==='stop'){
  const result=await runtime.stop();respond(frame,result);await stop();return;
 }
 const method=methods[frame.method];
 if(!method||stopping)throw Object.assign(Error('Pi method unavailable: '+frame.method),{code:'PI_METHOD_UNAVAILABLE'});
 const params={...frame.params};
 if(!params.agentDir&&process.env.NOZELI_PI_HOME)params.agentDir=process.env.NOZELI_PI_HOME;
 const result=await runtime[method](params);respond(frame,result);
}
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 let frame;try{frame=JSON.parse(line);}catch(error){console.error('Invalid owner JSONL');void stop();return;}
 // Error frames keep the bounded structured provider-failure evidence
 // (sanitized picklist) beside code/message; never stacks or raw bodies.
 void dispatch(frame).catch(error=>send({id:frame?.id,error:{code:error.code??'PI_RUNTIME_ERROR',message:error.message,...(['host','provider','runtime'].includes(error.failureOrigin)?{failureOrigin:error.failureOrigin}:{}),...(typeof error.hostToolCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.hostToolCode)?{hostToolCode:error.hostToolCode}:{}),...(error.deliveryPhase?{deliveryPhase:error.deliveryPhase}:{}),...(error.definitiveNonDispatch===true&&error.deliveryPhase==='not-submitted'?{definitiveNonDispatch:true}:{}),...(error.providerFailure&&typeof error.providerFailure==='object'?{providerFailure:error.providerFailure}:{})}}));
}).on('close',()=>void stop());
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
