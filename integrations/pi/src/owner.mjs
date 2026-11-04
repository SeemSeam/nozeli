import {createInterface} from 'node:readline';
import {OwnerRuntime} from './bridge.mjs';

const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
console.log=(...args)=>console.error(...args);
const runtime=new OwnerRuntime({send});
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
  const result=await runtime.stop();send({id:frame.id,result});await stop();return;
 }
 const method=methods[frame.method];
 if(!method||stopping)throw Object.assign(Error('Pi method unavailable: '+frame.method),{code:'PI_METHOD_UNAVAILABLE'});
 const params={...frame.params};
 if(!params.agentDir&&process.env.NOZELI_PI_HOME)params.agentDir=process.env.NOZELI_PI_HOME;
 const result=await runtime[method](params);send({id:frame.id,result});
}
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 let frame;try{frame=JSON.parse(line);}catch(error){console.error('Invalid owner JSONL');void stop();return;}
 // Error frames keep the bounded structured provider-failure evidence
 // (sanitized picklist) beside code/message; never stacks or raw bodies.
 void dispatch(frame).catch(error=>send({id:frame?.id,error:{code:error.code??'PI_RUNTIME_ERROR',message:error.message,...(['host','provider','runtime'].includes(error.failureOrigin)?{failureOrigin:error.failureOrigin}:{}),...(typeof error.hostToolCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.hostToolCode)?{hostToolCode:error.hostToolCode}:{}),...(error.deliveryPhase?{deliveryPhase:error.deliveryPhase}:{}),...(error.providerFailure&&typeof error.providerFailure==='object'?{providerFailure:error.providerFailure}:{})}}));
}).on('close',()=>void stop());
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
