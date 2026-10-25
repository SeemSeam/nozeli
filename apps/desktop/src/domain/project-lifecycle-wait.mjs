export async function boundedProjectWait(promise, {timeoutMs = 15000, code = 'PROJECT_STOP_TIMEOUT'} = {}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('项目停稳超时；状态待核查，未执行清理或重投。'), {code})), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
