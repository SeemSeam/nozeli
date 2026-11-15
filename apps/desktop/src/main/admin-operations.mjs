const fail=(code,message)=>Object.assign(Error(message),{code});
const operations=new Set(['status','draft','configure','send','cancel','confirm','dismiss','openProject','openSettings','view.read','view.write','prepareForceRecovery']);
const settingSections=new Set(['settings-provider','settings-models','settings-appearance','settings-agents']);

// Invoked only after WorkspaceNative has verified the sender/frame identity.
// Application context deliberately bypasses project payload rebinding, never
// the verified-shell check. Model tools cannot call this UI-only dispatcher.
export async function adminOperation({scope,op,payload={},admin,prepareSend=async()=>{},frozen=false}){
 if(scope?.role!=='shell'||scope.dead)throw fail('IPC_DENIED','管理员只允许从可信主窗口访问。');
 const action=op.slice('admin.'.length);
 if(!operations.has(action)||!payload||typeof payload!=='object'||Array.isArray(payload))throw fail('INVALID_PAYLOAD','未知管理员操作或参数。');
 if(!['openProject','prepareForceRecovery'].includes(action)&&Object.hasOwn(payload,'projectId'))throw fail('ADMIN_SCOPE_DENIED','管理上下文不属于项目。');
 if(frozen&&!['status','cancel','draft','view.read','view.write'].includes(action))throw fail('APPLICATION_CLOSING','应用正在更新或关闭，未开始管理操作。');
 if(action==='openSettings'){
  if(Object.keys(payload).some(key=>key!=='section')||!settingSections.has(payload.section))throw fail('INVALID_SETTINGS','未知设置页面。');
  return {section:payload.section};
 }
 if(action==='send')await prepareSend();
 return admin.invoke(action,payload);
}
