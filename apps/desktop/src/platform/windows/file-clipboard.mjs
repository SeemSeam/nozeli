import {createRequire} from 'node:module';
import {setTimeout} from 'node:timers/promises';
const require=createRequire(import.meta.url);
export function createWindowsFileClipboard({bridge=require('../../../native/windows/build/Release/nozeli_windows_read.node')}={}){
 const retry=async run=>{const end=Date.now()+1000;for(;;)try{return run();}catch(error){if(error.code!=='CLIPBOARD_BUSY'||Date.now()>=end)throw error;await setTimeout(20);}};
 return Object.freeze({async snapshot(){const value=await retry(()=>bridge.readNativeFileClipboard());return {entries:new Map(value.entries.map(row=>[row.format,row.bytes])),generation:String(value.sequence)};},write(entries,generation){return retry(()=>bridge.writeNativeFileClipboard(Number(generation),[...entries].map(([format,bytes])=>({format,bytes}))));}});
}
