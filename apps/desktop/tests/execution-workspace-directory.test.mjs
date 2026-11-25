import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';
import {assertGitDirectory} from '../src/agents/managed/git-runtime.mjs';

const work='6b29a80f-7283-4586-875a-3fa043cef222';
const root=path.resolve(path.sep,'managed','storage-v2','instances','347fd514-adcb-4121-878c-1261ccb738bb','execution');
const legacy=path.join(root,'execution',work),fresh=path.join(root,work);
const workspace=execution=>new ExecutionWorkspace({root,find:()=>({id:work,...(execution?{execution}:{})})});

test('a fresh work keeps the upstream execution area, shortened only on windows',()=>{
  const dir=workspace().directory(work);
  if(process.platform==='win32')assert.equal(dir,fresh);
  else assert.equal(dir,legacy);
});
test('an existing work keeps its persisted directory verbatim on every platform',()=>{
  assert.equal(workspace({directory:legacy}).directory(work),legacy);
  if(process.platform==='win32')assert.equal(workspace({directory:fresh}).directory(work),fresh);
  else assert.throws(()=>workspace({directory:fresh}).directory(work),{code:'WORK_ID'});
});
test('a persisted directory outside the two managed layouts refuses instead of remapping',()=>{
  assert.throws(()=>workspace({directory:path.join(root,'elsewhere',work)}).directory(work),{code:'WORK_ID'});
  assert.throws(()=>workspace({directory:path.join(root,'execution','another-work-id')}).directory(work),{code:'WORK_ID'});
  assert.throws(()=>workspace({directory:path.join(path.dirname(root),'escape',work)}).directory(work),{code:'WORK_ID'});
});
test('invalid work identifiers never reach the filesystem',()=>{
  assert.throws(()=>workspace().directory('../escape'),{code:'WORK_ID'});
});

test('worktree preflight enforces the measured bundled-git limit in utf-8 bytes',()=>{
  const at=n=>'C:\\'+'x'.repeat(n-3);
  if(process.platform==='win32'){
    // 221-byte worktree '.git' pointer: one over the measured die point.
    const over=at(216),// directory length216 + '\\.git' length5 =221 bytes
      under=at(215);// pointer220 bytes: last passing length
    assert.throws(()=>assertGitDirectory(over,{worktree:true}),error=>
      error.code==='UNSUPPORTED_GIT_WORKTREE_PATH'&&error.limit===220&&error.utf8Bytes===221);
    assert.doesNotThrow(()=>assertGitDirectory(under,{worktree:true}));
  }
});
test('working-directory preflight stays on utf-16 units so cjk paths are not over-restricted',()=>{
  if(process.platform==='win32'){
    // 200 CJK characters = 600 UTF-8 bytes but 200 UTF-16 units: must pass.
    const cjk='C:\\'+'\u4e2d'.repeat(200);
    assert.doesNotThrow(()=>assertGitDirectory(cjk));
    const long='C:\\'+'x'.repeat(256);// 259 UTF-16 units
    assert.throws(()=>assertGitDirectory(long),error=>
      error.code==='UNSUPPORTED_GIT_WORKING_DIRECTORY'&&error.limit===258&&error.utf16Units===259);
  }
});
