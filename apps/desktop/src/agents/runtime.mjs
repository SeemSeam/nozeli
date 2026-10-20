import {readFile} from 'node:fs/promises';
import path from 'node:path';

export class AgentError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
const validId=id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id);
const readOnly=()=>{throw new AgentError('LEGACY_RUNTIME_READ_ONLY','Historical Agent records are read-only. Start new work in the managed OMP workspace; original provider identities cannot be resumed.');};

// The former two-role runtime is an archive reader, never an execution adapter.
// In particular reading queued/running records does not rewrite or replay them.
export class AgentRuntime {
  constructor({userDataDir}={}){
    if(typeof userDataDir!=='string'||!path.isAbsolute(userDataDir))throw new AgentError('INVALID_DIRECTORY','Application metadata directory must be absolute.');
    this.metaRoot=path.join(userDataDir,'nozeli','v1');this.projects=new Map();this.connectFlight=new Map();
  }
  onEvent(listener){this.listener=listener;}
  assertProject(id){if(!validId(id))throw new AgentError('INVALID_PROJECT','Invalid project identity.');}
  async readRecord(id,name){this.assertProject(id);try{return JSON.parse(await readFile(path.join(this.metaRoot,'projects',id,name),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new AgentError('HISTORY_UNREADABLE','Historical Agent records could not be read and were left unchanged.');}}
  async loadHistory(id){
    const log=await this.readRecord(id,'agent-log.json');
    if(log&&log.schemaVersion!==1)throw new AgentError('SCHEMA_UNSUPPORTED','Unknown historical Agent log version; refusing to overwrite.');
    if(log)this.projects.set(id,{id,log});return log;
  }
  async detect(){return {providers:[],readOnly:true};}
  async settings(id){return id?this.readRecord(id,'agent-binding.json'):null;}
  async bootstrap(id=null){if(id)await this.loadHistory(id);return {projectId:id,show:false,confirmed:false,readOnly:true,settings:id?await this.settings(id):null,providers:[]};}
  status(id){return {connected:false,pending:false,readOnly:true,roles:{},historical:this.projects.has(id)};}
  async console(id){await this.loadHistory(id);return {...this.status(id),messages:this.messages(id),reports:this.reports(id)};}
  messages(id){return structuredClone(this.projects.get(id)?.log.messages||[]);}
  work(id){return (this.projects.get(id)?.log.requests||[]).filter(r=>r.role==='task').map(r=>({id:r.id,projectId:id,title:String(r.text||'后台工作').replace(/\s+/g,' ').slice(0,120),status:r.status,createdAt:r.createdAt,oneWay:r.oneWay===true,readOnly:true}));}
  reports(id){return (this.projects.get(id)?.log.reports||[]).map(r=>publicReport(r));}
  async readReport(id,reportId){await this.loadHistory(id);const report=this.projects.get(id)?.log.reports?.find(r=>r.id===reportId);if(!report)throw new AgentError('UNKNOWN_REPORT','No such report in this project.');return publicReport(report,true);}
  saveSettings(){return readOnly();}
  connect(){return readOnly();}
  retry(){return readOnly();}
  send(){return readOnly();}
  cancel(){return readOnly();}
  terminalAdapter(){return readOnly();}
  dismiss(){return readOnly();}
  busy(){return false;}
  roleBusy(){return false;}
  // No process can be created by this archive reader, so there is nothing to stop.
  async stopSlots(){}
  async cancelAllAndStop(){}
  async stopIdle(){}
}
function publicReport(report,withText=false){return {id:report.id,requestId:report.requestId,projectId:report.projectId,title:report.title,status:report.status,success:report.success===true,writtenBack:report.writtenBack===true?true:report.writtenBack===false?false:null,materialDigest:report.materialDigest||null,createdAt:report.createdAt,text:withText?report.text:undefined,readOnly:true};}
