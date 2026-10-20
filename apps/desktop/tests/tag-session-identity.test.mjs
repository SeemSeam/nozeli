import test from 'node:test';
import assert from 'node:assert/strict';
import { createTagSessionProjection } from '../src/renderer/tag-session-projection.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {SessionIndex} from '../src/agents/managed/session-index.mjs';
import {createSessionStore,sessionMessages} from '../src/renderer/session-store.mjs';

function fixture(tags, entries = []) {
  let messages = entries, renders = 0;
  const persisted = [], requested = [];
  const ui = { project: { id: 'p' }, threads: new Map(tags.map(tag => [tag.id, tag])) };
  const { apply: applyAgentMessages } = createTagSessionProjection({
    currentProjectId: () => ui.project?.id, tags: () => ui.threads.values(),
    persistTag: tag => persisted.push(tag), renderTags: () => renders++,
  });
  const api = { applyAgentMessages };
  const source = { projectId: 'p', getMessages: () => messages, ensureMessage: async id => { requested.push(id); } };
  return { api, ui, persisted, requested, source, setMessages: next => { messages = next; }, renders: () => renders };
}
const message = (id, requestId, text, streaming = false) => ({ id, requestId, text, streaming, role: 'qa' });
const tag = () => ({ id: 'tag', projectId: 'p', requestId: 'request', status: 'accepted-awaiting-reply', history: [{ requestId: 'request', question: 'question' }] });

test('tag text is a live getter over the canonical session authority, not a retained transcript copy', () => {
  const value = tag(), f = fixture([value], [message('m', 'request', 'first')]);
  f.api.applyAgentMessages([], f.source);
  assert.equal(value.messageId, 'm'); assert.equal(value.history[0].messageId, 'm');
  assert.equal(value.replyText, 'first'); assert.equal(value.history[0].reply, 'first');
  assert.equal(Object.getOwnPropertyDescriptor(value, 'replyText').set, undefined);
  f.setMessages([message('m', 'request', 'canonical revision')]);
  assert.equal(value.replyText, 'canonical revision'); assert.equal(value.history[0].reply, 'canonical revision');
  f.setMessages([]);
  assert.equal(value.replyText, ''); assert.equal(value.history[0].reply, '');
  f.api.applyAgentMessages(); assert(f.requested.includes('m'));
});

test('all same-request assistant segments remain ordered without admitting another request', () => {
  const value = { ...tag(), messageId:'first',status:'completed' };
  const f=fixture([value],[{...message('second','request','Second segment'),sequence:2},{...message('first','request','First segment'),sequence:1},message('unrelated','other','Not this discussion')]);
  f.api.applyAgentMessages([],f.source);
  assert.equal(value.replyText,'First segment\n\nSecond segment');
  assert.deepEqual(value.messageIds,['first','second']);
});

test('stream replacement follows host request identity and never marks partial output completed', () => {
  const value = tag(), f = fixture([value], [message('stream', 'request', 'partial', true)]);
  f.api.applyAgentMessages([], f.source);
  assert.equal(value.status, 'accepted-awaiting-reply'); assert.equal(value.messageId, 'stream');
  f.setMessages([message('durable', 'request', 'complete')]); f.api.applyAgentMessages();
  assert.equal(value.messageId, 'durable'); assert.equal(value.history[0].messageId, 'durable');
  assert.equal(value.status, 'completed'); assert.equal(value.replyText, 'complete');
});

test('different projects and unrelated requests cannot attach or hydrate tag replies', () => {
  const value = { ...tag(), messageId: 'missing' }, f = fixture([value], [message('other', 'unrelated', 'wrong')]);
  f.api.applyAgentMessages([], { ...f.source, projectId: 'other' });
  assert.equal(value.replyText, ''); assert.equal(f.requested.length, 0);
  f.api.applyAgentMessages([], f.source);
  assert.equal(value.replyText, ''); assert.equal(value.messageId, 'missing');
  assert(f.requested.includes('missing'));
});

test('history renders from canonical identities while local drafts and question text survive replies', () => {
  const value = { ...tag(), text: 'local question draft', draftText: 'unsent edit', status: 'draft', history: [
    { requestId: 'old', messageId: 'old-message', question: 'previous question', reply: 'obsolete copied reply' },
    { requestId: 'request', question: 'submitted question' },
  ] };
  const f = fixture([value], [message('old-message', 'old', 'canonical old'), message('new-message', 'request', 'canonical new')]);
  f.api.applyAgentMessages([], f.source);
  assert.equal(value.status, 'draft'); assert.equal(value.text, 'local question draft'); assert.equal(value.draftText, 'unsent edit');
  assert.equal(value.history[0].reply, 'canonical old'); assert.equal(value.history[1].reply, 'canonical new');
  assert.equal(value.history[1].status, 'completed');
  assert.equal(JSON.parse(JSON.stringify(value.history))[0].reply, 'canonical old');
  f.setMessages([message('old-message', 'old', 'updated old'), message('new-message', 'request', 'canonical new')]);
  assert.equal(JSON.parse(JSON.stringify(value.history))[0].reply, 'updated old');
});

test('read-required durable replies stay completed and read original only on explicit request', async () => {
  const value=tag(), f=fixture([value],[{...message('large','request',''),availability:'read-required',durable:true}]);
  const reads=[];f.source.readMessage=async(id,options)=>{reads.push([id,options]);return {read:{version:'v',fields:[{field:'text',totalBytes:999999}]}};};
  f.api.applyAgentMessages([],f.source);
  assert.equal(value.status,'completed');assert.equal(value.history[0].status,'completed');
  assert.equal(value.replyAvailability,'read-required');assert.equal(reads.length,0);assert.equal(f.requested.length,0);
  const read=value.readReply;await read();assert.deepEqual(reads,[['large',undefined]]);
  f.ui.project={id:'other'};await assert.rejects(read(),/项目已切换/);assert.equal(reads.length,1);
});

test('failed durable replies do not become completed just because original text is read-required',()=>{
  const value=tag(),f=fixture([value],[{...message('large','request',''),availability:'read-required',durable:true,failed:true}]);
  f.api.applyAgentMessages([],f.source);assert.equal(value.status,'failed');
});

test('canonical native progress advances to final reply without changing completed history or local drafts',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-tag-native-'));
 const store=await Workspace.open(path.join(root,'runtime'),path.join(root,'project'));
 t.after(async()=>{await store.close();await fs.rm(root,{recursive:true,force:true});});
 await store.mutate(()=>{store.state.jobs=[{id:'job-a',target:'frontdesk',status:'running',context:{},collabAttempts:[{requestId:'request-a',sessionId:'native-session',epoch:'native-session#0'}]}];});
 const index=new SessionIndex(store);await index.initialize();
 const replica=createSessionStore();replica.reset('p');t.after(()=>replica.reset(null));
 const value={...tag(),requestId:'job-a',draftText:'UNSENT_TAG',history:[{requestId:'older',messageId:'old-message',status:'completed',question:'old question'},{requestId:'job-a',question:'current question',status:'accepted-awaiting-reply'}]};
 const f=fixture([value]);f.source.getMessages=()=>sessionMessages(replica.getSnapshot(),store.state).reverse();
 const fact=(id,text)=>({sessionId:'native-session',epoch:'native-session#0',requestId:'request-a',jobId:'job-a',entry:{type:'message',id,parentId:null,message:{role:'assistant',content:[{type:'text',text}]}}});
 const apply=()=>{replica.apply('p',{...index.frame(),entries:[{id:'old-message',sequence:0,target:'frontdesk',speaker:'agent',jobId:'older',text:'immutable old answer',durable:true},...index.frame().entries]},{replace:true});f.api.applyAgentMessages([],f.source);};
 await index.recordBatch([fact('progress','Reading the selected material')],'frontdesk');apply();
 const progressId=value.messageId;assert.equal(value.status,'accepted-awaiting-reply');assert.equal(value.replyText,'Reading the selected material');
 value.status='draft';value.text='NEW_UNSENT_QUESTION';
 await index.recordBatch([fact('final','Final grounded answer')],'frontdesk');
 apply();assert.equal(value.status,'draft');assert.equal(value.replyText,'Reading the selected material\n\nFinal grounded answer');assert.equal(value.text,'NEW_UNSENT_QUESTION');
 value.status='accepted-awaiting-reply';await store.mutate(()=>{store.state.jobs[0].status='completed';});apply();
 assert.notEqual(value.messageId,progressId);assert.equal(value.replyText,'Reading the selected material\n\nFinal grounded answer');assert.equal(value.status,'completed');
 assert.equal(value.history[1].messageId,value.messageId);assert.equal(value.history[0].reply,'immutable old answer');assert.equal(value.history[0].messageId,'old-message');assert.equal(value.draftText,'UNSENT_TAG');
 await store.mutate(()=>{store.state.jobs[0].status='failed';});apply();assert.equal(value.status,'failed');assert.equal(value.history[1].status,'failed');
});
