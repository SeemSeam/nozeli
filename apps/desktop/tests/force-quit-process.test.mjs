import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const helper = require.resolve('../src/main/force-quit.cjs');

test('real process exits within three seconds despite permanently hanging shutdown cleanup', {timeout:6000}, async t => {
  const worker = spawn(process.execPath, ['-e', `
    const {createForceQuit} = require(${JSON.stringify(helper)});
    const quit = createForceQuit({app:{exit:code=>process.exit(code)},cleanup:()=>new Promise(()=>{})});
    process.on('message',()=>{quit();quit();});
    setInterval(()=>{},1000);
    process.send({ready:true});
  `], {stdio:['ignore','ignore','pipe','ipc']});
  const exited = once(worker,'exit');
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await exited;
  });
  await once(worker,'message');
  const start = Date.now();
  worker.send({choice:'force'});
  const [code,signal] = await exited;
  assert.equal(code,0);
  assert.equal(signal,null);
  assert(Date.now()-start < 3000, 'real hung process must exit within three seconds');
});
