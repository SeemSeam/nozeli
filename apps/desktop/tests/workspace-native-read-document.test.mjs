import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceNative } from '../src/main/workspace-native.mjs';

// Behavioral regression for WorkspaceNative.readDocument — the local Windows
// retention read path that a merge dropped (GUI: "workspaceNative.readDocument
// is not a function"). Invokes the real prototype method with a hand-built
// receiver: retained cold content wins, a protected owner mirrors its content,
// plain and review sources are read strictly through the record's own bound
// source, and foreign scopes refuse.
function receiver({retained=new Map(),hostRead}={}){
  const workspace=Object.create(WorkspaceNative.prototype);
  workspace.surfaces=new Map();
  workspace.host={readFile:hostRead??(async()=>{throw Error('host.readFile must not run in this case');})};
  workspace.treeRecovery={journal:{
    ensure:async()=>{},
    read:async record=>retained.get(workspace.resource(record.projectId,record.relPath,record.documentSource))??null,
  }};
  return workspace;
}
const record=(over={})=>({role:'surface',kind:'document',projectId:'p1',relPath:'正文.md',documentSource:{type:'project'},readOnly:false,...over});

test('a plain project document reads through the host with the record source',async()=>{
  const calls=[];
  const workspace=receiver({hostRead:async(projectId,relPath,documentSource)=>{calls.push({projectId,relPath,documentSource});return {text:'plain 中文'};}});
  const file=await workspace.readDocument(record(),{projectId:'p1',relPath:'正文.md'});
  assert.deepEqual(file,{text:'plain 中文'});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{projectId:'p1',relPath:'正文.md',documentSource:{type:'project'}});
});
test('retained cold-recovery content is returned verbatim without touching the host',async()=>{
  const retainedFile={treeRecoveryRetained:true,text:'retained 编辑',digest:'a'.repeat(64)};
  const retained=new Map();const workspace=receiver({retained});retained.set(workspace.resource('p1','正文.md',{type:'project'}),retainedFile);
  const file=await workspace.readDocument(record(),{projectId:'p1',relPath:'正文.md'});
  assert.equal(file,retainedFile);
});
test('a protected read-only mirror reads its live owner retention first',async()=>{
  const ownerContent={treeRecoveryRetained:true,text:'owner 保留'};
  const mirror=record({readOnly:true}),owner=record({readOnly:false});
  const retained=new Map();const workspace=receiver({retained});retained.set(workspace.resource('p1','正文.md',{type:'project'}),ownerContent);
  workspace.surfaces.set('owner-view',{...owner,dead:false});
  const file=await workspace.readDocument(mirror,{projectId:'p1',relPath:'正文.md'});
  assert.equal(file,ownerContent);
});
test('a review document reads only through its exact bound review source',async()=>{
  const source={type:'review',workId:'w1',objectId:'o1'};
  const calls=[];
  const workspace=receiver({hostRead:async(projectId,relPath,documentSource)=>{calls.push({projectId,relPath,documentSource});return {text:'review 正文'};}});
  const file=await workspace.readDocument(record({documentSource:source}),{projectId:'p1',relPath:'正文.md',documentSource:source});
  assert.deepEqual(file,{text:'review 正文'});
  assert.deepEqual(calls,[{projectId:'p1',relPath:'正文.md',documentSource:source}]);
  await assert.rejects(workspace.readDocument(record({documentSource:source}),{projectId:'p1',relPath:'正文.md',documentSource:{type:'review',workId:'w1',objectId:'other'}}),{code:'PROJECT_SCOPE_DENIED'});
});
test('foreign project, path or role scopes refuse before any read',async()=>{
  const workspace=receiver({hostRead:async()=>({text:'must not leak'})});
  await assert.rejects(workspace.readDocument(record(),{projectId:'other',relPath:'正文.md'}),{code:'PROJECT_SCOPE_DENIED'});
  await assert.rejects(workspace.readDocument(record(),{projectId:'p1',relPath:'别的.md'}),{code:'PROJECT_SCOPE_DENIED'});
  await assert.rejects(workspace.readDocument(record({role:'shell'}),{projectId:'p1',relPath:'正文.md'}),{code:'PROJECT_SCOPE_DENIED'});
  await assert.rejects(workspace.readDocument(record({kind:'conversation'}),{projectId:'p1',relPath:'正文.md'}),{code:'PROJECT_SCOPE_DENIED'});
});
