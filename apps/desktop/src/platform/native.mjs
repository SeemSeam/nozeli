import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let bridge;
export function platformNative(){
  if(process.platform!=='darwin')throw Object.assign(Error('No native bridge for '+process.platform),{code:'PLATFORM_UNSUPPORTED'});
  try{return bridge??=require('../../runtime/platform/'+process.platform+'-'+process.arch+'/nozeli_platform.node');}
  catch(cause){throw Object.assign(Error('Nozeli macOS platform runtime is missing or incompatible; rebuild or repair the application',{cause}),{code:'PLATFORM_RUNTIME_MISSING'});}
}
