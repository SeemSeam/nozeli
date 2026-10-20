import test from 'node:test';import assert from 'node:assert/strict';
import {runtimeFailureMessage} from '../src/domain/runtime-failure-message.mjs';
test('known connection code gives a connection hint while retaining exact raw reason',()=>{
 const result=runtimeFailureMessage(Object.assign(Error('write closed'),{code:'EPIPE'}),{work:true});assert.equal(result.category,'connection-interrupted');assert.match(result.text,/write closed/);assert.match(result.text,/继续原任务/);assert(!/模型配置|候选.*保留|自动重试/.test(result.text));
});
test('unstructured disconnect, timeout, exit and auth wording do not fabricate a configuration diagnosis',()=>{
 for(const raw of ['turn failed: local fixture transport disconnected','turn completion timeout','provider exited 23','invalid model or auth unknown']){
  const result=runtimeFailureMessage(Error(raw));assert.equal(result.category,'unclassified');assert(result.text.includes(raw));assert.match(result.text,/输入已记录/);assert(!/核对.*配置|候选.*保留/.test(result.text));
 }
});
test('explicit exit evidence distinguishes execution termination without assuming success or recovery',()=>{
 const result=runtimeFailureMessage(Object.assign(Error('ended'),{providerExit:{code:null,signal:'SIGTERM'}}),{work:true});assert.equal(result.category,'provider-exited');assert.match(result.text,/进程退出/);assert(!/成功|已恢复/.test(result.text));
});
