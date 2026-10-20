// A message alone is not proof of authentication/model configuration failure.
// Use machine evidence when available; unclassified Provider text stays raw.
export function runtimeFailureMessage(error,{work=false}={}){
  const connection=['EPIPE','ECONNRESET','ECONNABORTED','ETIMEDOUT'].includes(error?.code),exit=Number.isInteger(error?.providerExit?.code)||typeof error?.providerExit?.signal==='string';
  const category=connection?'connection-interrupted':exit?'provider-exited':'unclassified';
  const title=connection?'连接中断，本次处理未完成':exit?'执行进程退出，本次处理未完成':'本次处理未完成';
  return {category,text:title+'：'+String(error?.message||error||'未知原因')+'\n本次输入已记录。请根据上述原因处理后'+(work?'继续原任务。':'重新提交输入。')};
}
