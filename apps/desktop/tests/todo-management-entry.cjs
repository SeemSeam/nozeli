// Isolated GUI fixture: real Controller/Workspace/IPC; only provider sessions are synthetic.
// The asynchronous module imports below may span app.ready; set CDP first.
if(process.env.NOZELI_DEBUG_PORT)require('electron').app.commandLine.appendSwitch('remote-debugging-port',process.env.NOZELI_DEBUG_PORT);
(async()=>{
 const path=require('node:path'),fs=await import('node:fs/promises'),{pathToFileURL}=await import('node:url'),{randomUUID}=await import('node:crypto');
 const root=path.resolve(__dirname,'..');
 const {Controller}=await import(pathToFileURL(path.join(root,'src/agents/managed/controller.mjs')));
 const open=Controller.open.bind(Controller);
 class Session{
  constructor(spec,target){Object.assign(this,spec,{target,busy:false,closed:false});}
  async start(id){this.threadId=id||randomUUID();return this;}
  async stop(){this.closed=true;}
  async prompt(text){
   if(this.target==='frontdesk')throw Error('隔离测试：真实持久系统异常，没有发起模型请求');
   if(this.target==='orchestrator'&&text.includes('用户已明确')){
    for(const [tool,args] of [['nozeli_curate',{summary:'隔离测试成果已核对；用户主动结束。'}],['nozeli_maintenance_complete',{reason:'隔离测试不需要修改项目文档'}]])await this.onTool({tool,arguments:args,threadId:this.threadId,callId:randomUUID()});
   }
   return {text:'fixture response',threadId:this.threadId,turnId:randomUUID()};
  }
 }
 const wait=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('fixture lifecycle timeout');};
 Controller.open=async options=>{
  const c=await open({...options,isolateProcesses:false,gitEnabled:false,projectHome:async()=>{},sessionFactory:(spec,target)=>new Session(spec,target)});
  const marker=path.join(options.runtimeRoot,'todo-fixture-seeded');
  try{await fs.access(marker);}catch{
   await c.start();
   await c.send('frontdesk','产生隔离系统异常');await wait(()=>c.store.state.jobs.some(j=>j.status==='failed')&&!c.running.size);
   const system=c.store.state.todos.find(t=>t.kind==='system');if(!system)throw Error('failure did not create system todo');
   const kick=c.kick.bind(c);c.kick=()=>{};
   // Legacy-format anomaly is fixture input, not a claimed successful recovery.
   await c.store.mutate(()=>c.store.state.todos.push({id:'legacy-no-source',kind:'recovery',status:'open',text:'旧无来源提醒：无关联工作；关闭不表示修复。'}));
   const done=await c.store.submit('隔离已完成工作','只读合成报告',{name:'已完成历史任务'});
   await c.store.activate(done.id);await c.store.publish(done.id,1,'result','合成成果原报告：保留此源记录。','fixture-result-receipt');await c.store.settle(done.id);
   c.kick=kick;await c.endWork(done.id,{revision:1});await wait(()=>c.store.find(done.id).status==='ended'&&!c.running.size);c.kick=()=>{};
   const live=await c.store.submit('进行中保护场景','不得通过待办管理结束此任务',{name:'仍在进行的任务'});
   await c.store.activate(live.id);await c.store.publish(live.id,1,'problem','此问题需要正式回答，不允许关闭或删除绕过。','fixture-problem-receipt');await c.store.settle(live.id);
   await c.store.mutate(()=>{for(let i=0;i<55;i++)c.store.state.todos.push({id:'old-completed-'+i,kind:'system',status:'resolved',createdAt:'2026-10-01T00:00:00.000Z',settledAt:'2026-10-02T00:00:00.000Z',text:'旧格式已处理历史 '+i,resolution:{status:'legacy-completed'}});});
   await fs.writeFile(marker,'seeded\n');
   c.kick=kick;
  }
  // Avoid terminal adapters: this suite exercises todo GUI, not provider TUI.
  c.nativeDraftTargets.add('frontdesk');c.nativeDraftTargets.add('orchestrator');
  return c;
 };
 require(path.join(root,'src/main/main.cjs'));
})().catch(error=>{console.error(error);process.exitCode=1;});
