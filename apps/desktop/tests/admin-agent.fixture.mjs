import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';

// Deterministic native-history boundary fixture: no inference or network calls.
export class ControlledAdminSession extends EventEmitter {
 constructor(spec,control={}){super();this.spec=spec;this.control=control;this.model=spec.model;this.busy=false;control.sessions??=[];control.sessions.push(this);}
 async preflightToolsDigest(){}
 async start(resumeId){
  this.threadId=resumeId??randomUUID();this.sessionFile=path.join(this.spec.sessionDir??path.join(this.spec.home,'sessions'),this.threadId+'.jsonl');
  await fs.mkdir(path.dirname(this.sessionFile),{recursive:true});
  let rows=[];try{rows=(await fs.readFile(this.sessionFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
  this.lastId=rows.at(-1)?.id??null;
  await this.spec.onSpawn?.();return {threadId:this.threadId,sessionFile:this.sessionFile};
 }
 async applyDefaultModel(value){this.model=value.selector;this.effort=value.effort;return {state:'applied'};}
 async entry(role,text){const entry={type:'message',id:randomUUID(),parentId:this.lastId,message:{role,content:[{type:'text',text}]}};await fs.appendFile(this.sessionFile,JSON.stringify(entry)+'\n');this.lastId=entry.id;await this.spec.onNativeEntry({entry});}
 async prompt(text,options){
  this.busy=true;this.control.prompts??=[];this.control.prompts.push({text,options,spec:this.spec});
  try{
   await this.entry('user',text);await this.control.onPrompt?.(this,text,options);
   if(this.control.fail)throw Object.assign(Error('sensitive-provider-detail'),{code:'PI_REQUEST_TIMEOUT'});
   if(!this.cancelled)await this.entry('assistant','deterministic native result');
   return {providerStatus:this.cancelled?'cancelled':'completed'};
  }finally{this.busy=false;}
 }
 async interrupt(){this.cancelled=true;this.control.release?.();return {stopped:true};}
 async stop(){await this.interrupt();if(this.control.stopError)throw this.control.stopError;this.closed=true;return {confirmationComplete:true};}
}
