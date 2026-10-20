import { OmpTuiSession } from './omp-tui-session.mjs';
import {randomUUID} from 'node:crypto';
// 关闭视图不终止会话（owner 是 session）；系统终端接管经同一 input 通道（managed-projects 既有合同）。
function attachOmpTerminalView(controller,target,session,{onData=()=>{},onScreen=()=>{},onExit=()=>{},terminalId}={}){
  if(session.closed||session.protocolEnded)throw new Error('会话已停止，终端不可附着；原始输入与身份保持不变。');   // attach 前已 stop：不建视图不覆盖身份
  const attachment=session.terminalAttachment(controller,target);
  attachment.terminalId=terminalId;   // 与 managed attach 回调闭包同 lease；否则重绘被 renderer 当旧终端丢弃
  const originalInput=attachment.input.bind(attachment),originalResize=attachment.resize.bind(attachment);
  attachment.input=data=>{if(detached||controller.terminals.get(target)!==attachment)throw new Error('terminal view detached');return originalInput(data);};
  attachment.resize=(cols,rows)=>{if(detached||controller.terminals.get(target)!==attachment)throw new Error('terminal view detached');return originalResize(cols,rows);};
  let detached=false;
  const dataHandler=(data,seq)=>{if(!detached&&controller.terminals.get(target)===attachment)onData(data,seq);};
  const noteHandler=()=>{};
  session.on('pty-data',dataHandler);
  session.on('notification',noteHandler);   // 会话事件不走 WS facade；保留通知订阅面一致性
  const detach=()=>{detached=true;try{session.off('pty-data',dataHandler);session.off('notification',noteHandler);}catch{}};
  void session.exitPromise.then(exit=>{if(detached||controller.terminals.get(target)!==attachment)return;detach();controller.terminals.delete(target);controller.changed();onExit({exitCode:exit?.exitCode??exit?.code,signal:exit?.signal});}).catch(()=>{});
  const originalSnapshot=attachment.snapshot.bind(attachment);
  attachment.snapshot=async()=>{if(detached||controller.terminals.get(target)!==attachment)throw new Error('terminal view detached');const screen=await originalSnapshot();if(!detached&&controller.terminals.get(target)===attachment)onScreen(screen);return screen;};
  controller.terminals.set(target,attachment);
  attachment.close=async()=>{detach();if(controller.terminals.get(target)===attachment){controller.terminals.delete(target);controller.changed();}return {closed:true,viewDetached:true};};
  controller.changed();
  return attachment;
}
export async function attachNativeTerminal(controller,target,options={}){
  if(controller.stopping)throw new Error('application closing');   // 控制器停止后不建终端（session() 自愈会误开新 TUI）
  const execution=options.executionJobId&&controller.current.get(target)?.id===options.executionJobId&&controller.store.state.jobs.some(j=>j.id===options.executionJobId&&j.target===target&&j.status==='running')&&controller.store.state.works.some(w=>w.id===target&&!['queued','closing','ended'].includes(w.status))&&!controller.sessions.get(target)?.busy;
  if(controller.configuring.has(target)||controller.running.has(target)&&!execution)throw new Error('Agent 正在处理，请在当前回合结束后连接终端');
  controller.configuring.add(target);
  try{return await startNativeTerminal(controller,target,options);}finally{controller.configuring.delete(target);controller.kick();}
}
async function startNativeTerminal(controller,target,{onData=()=>{},onScreen=()=>{},onMethod=()=>{},onExit=()=>{},terminalId=randomUUID()}={}){
  const previous=controller.terminals.get(target);if(previous?.closed)await previous.close();else if(previous)throw new Error('native terminal already attached');
  controller.validateTarget(target);
  const work=controller.store.state.works.find(w=>w.id===target);
  if(work&&['queued','closing','ended'].includes(work.status))throw new Error('work has no attachable session');
  const session=await controller.session(target);
  if(!(session instanceof OmpTuiSession))throw Object.assign(new Error('Only the bundled OMP native session can attach a terminal'),{code:'HISTORICAL_SESSION_READ_ONLY'});
  return attachOmpTerminalView(controller,target,session,{onData,onScreen,onExit,terminalId});
}
