import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const runtime = new URL('../src/agents/managed/git-runtime.mjs', import.meta.url);
const require = createRequire(import.meta.url);

test('Windows Git refuses an unsupported working directory before provisioning or spawn', {skip:process.platform!=='win32'}, async()=>{
  const {runGit}=await import(runtime.href);
  const cwd=path.join(os.tmpdir(),...Array.from({length:9},()=> '中文目录'+'x'.repeat(25)));
  await assert.rejects(runGit(cwd,['init']),error=>error.code==='UNSUPPORTED_GIT_WORKING_DIRECTORY'&&error.utf8Bytes>=260);
  const prefix=path.join(os.tmpdir(),'cwd-');
  await assert.rejects(runGit(prefix+'x'.repeat(259-prefix.length),['--version']),error=>error.code==='UNSUPPORTED_GIT_WORKING_DIRECTORY'&&error.utf16Units===259);
});

test('Windows Git working-directory qualification preserves supported Chinese paths above 260 UTF-8 bytes', {skip:process.platform!=='win32'}, async t=>{
 const {runGit}=await import(runtime.href),root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-git-unicode-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const prefix=path.join(root,'中'.repeat(35)),cwd=prefix+'x'.repeat(220-prefix.length);await fs.mkdir(cwd);
 assert.equal(cwd.length,220);assert.ok(Buffer.byteLength(cwd,'utf8')>260);
 const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(root,'no-global-config')};
 await runGit(cwd,['init','--initial-branch=main'],{env});
 assert.equal((await runGit(cwd,['rev-parse','--absolute-git-dir'],{env,encoding:'utf8'})).trim().replaceAll('/',path.sep),path.join(cwd,'.git'));
});

test('Windows bundled Git checks out long Unicode file paths without changing config', {skip:process.platform!=='win32'}, async t => {
  const {runGit}=await import(runtime.href);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-git-long-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_AUTHOR_NAME:'Synthetic test',GIT_AUTHOR_EMAIL:'test@localhost',GIT_COMMITTER_NAME:'Synthetic test',GIT_COMMITTER_EMAIL:'test@localhost'};
  for(const key of Object.keys(env))if(key.toLowerCase()==='path')env[key]='';
  const git=(cwd,args)=>runGit(cwd,args,{env,encoding:'utf8'});
  const repo=path.join(root,'repo');await fs.mkdir(repo);
  await git(repo,['init','--initial-branch=main']);
  await git(repo,['config','core.longpaths','false']);
  const relative=path.join(...Array.from({length:7},(_,i)=>'long-'+i+'-'.repeat(30)),'正文.md');
  assert.ok(path.join(repo,relative).length>300);
  await fs.mkdir(path.dirname(path.join(repo,relative)),{recursive:true});
  await fs.writeFile(path.join(repo,relative),'nested original\n');
  await fs.writeFile(path.join(repo,'正文.md'),'original\n');
  await git(repo,['add','--','.']);await git(repo,['-c','core.hooksPath='+path.join(root,'no-hooks'),'commit','-m','Synthetic baseline']);
  const config=await fs.readFile(path.join(repo,'.git','config'));
  const deep=path.join(root,'执行目录 中文 空格','worker');
  await git(repo,['worktree','add','-b','worker',deep]);
  assert.equal(await fs.readFile(path.join(deep,relative),'utf8'),'nested original\n');
  assert.equal(await fs.readFile(path.join(deep,'正文.md'),'utf8'),'original\n');
  assert.equal((await git(deep,['symbolic-ref','HEAD'])).trim(),'refs/heads/worker');
  await fs.writeFile(path.join(deep,'正文.md'),'worker candidate\n');
  await git(deep,['add','--','正文.md']);await git(deep,['-c','core.hooksPath='+path.join(root,'no-hooks'),'commit','-m','Synthetic candidate']);
  assert.equal(await git(repo,['show','worker:正文.md']),'worker candidate\n');
  assert.equal(await fs.readFile(path.join(repo,'正文.md'),'utf8'),'original\n');
  assert.deepEqual(await fs.readFile(path.join(repo,'.git','config')),config);
  await git(repo,['worktree','remove',deep]);
  assert.equal(await fs.stat(deep).catch(e=>{if(e.code==='ENOENT')return null;throw e;}),null);
});

// This deliberately runs real dugite binaries. No system Git, echo substitutes,
// or mocked subprocesses can satisfy the commit/object/transport assertions.
test('bundled Git creates commits and resolves transport helpers without system PATH', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-git-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    const {ensureGit,runGit}=await import(${JSON.stringify(runtime.href)});
    const {ShadowVersions}=await import(${JSON.stringify(new URL('../src/agents/managed/shadow-versions.mjs', import.meta.url).href)});
    const root=${JSON.stringify(root)};
    const before={...process.env};
    const git=await ensureGit();
    assert.equal(git.source,'bundled');
    assert(path.isAbsolute(git.command));
    assert.match(git.version,/^git version /);
    assert.equal((await runGit(root,['--exec-path'])).toString().trim(),git.env.GIT_EXEC_PATH);
    if(process.platform==='linux') {
      assert.equal(git.env.PREFIX,path.dirname(path.dirname(git.command)));
      await fs.access(git.env.GIT_SSL_CAINFO);
    }
    const repo=path.join(root,'repo'),clone=path.join(root,'clone');
    await fs.mkdir(repo);
    const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_AUTHOR_NAME:'Runtime Test',GIT_AUTHOR_EMAIL:'test@localhost',GIT_COMMITTER_NAME:'Runtime Test',GIT_COMMITTER_EMAIL:'test@localhost'};
    await runGit(repo,['init','-q'],{env});
    await fs.writeFile(path.join(repo,'hello.txt'),'real bundled git\\n');
    await runGit(repo,['add','--','hello.txt'],{env});
    await runGit(repo,['-c','core.hooksPath='+path.join(root,'no-hooks'),'commit','-qm','Bundled Git'],{env});
    const head=await runGit(repo,['rev-parse','HEAD'],{env});
    assert(Buffer.isBuffer(head));
    assert.match(head.toString().trim(),/^[0-9a-f]{40}$/);
    assert.equal((await runGit(repo,['show','HEAD:hello.txt'],{env,encoding:'utf8'})),'real bundled git\\n');
    // --no-local exercises upload-pack, not a filesystem-copy shortcut.
    await runGit(root,['clone','--no-local','-q',repo,clone],{env});
    assert.equal(await fs.readFile(path.join(clone,'hello.txt'),'utf8'),'real bundled git\\n');
    const index=path.join(root,'private-index');
    await runGit(repo,['read-tree','HEAD'],{env:{...env,GIT_INDEX_FILE:index}});
    await fs.access(index);
    await assert.rejects(runGit(repo,['rev-parse','--verify','refs/heads/does-not-exist'],{env}),error=>Boolean(error.stderr));
    const {ProjectStorage}=await import(${JSON.stringify(new URL('../src/main/project-storage.mjs', import.meta.url).href)});
    const storage=new ProjectStorage(path.join(root,'profile'));
    const registered=await storage.register(repo);
    const shadow=new ShadowVersions({projectRoot:repo,projectId:registered.id,storage});
    await shadow.ensureRepo();
    assert.equal((await shadow.git(['rev-parse','--is-bare-repository'])).toString().trim(),'true');
    await storage.db.close();
    assert.deepEqual({...process.env},before);
  `;
  const env = { ...process.env, PATH: '', LOCAL_GIT_DIRECTORY: path.join(root, 'wrong-git'), GIT_EXEC_PATH: path.join(root, 'wrong-helpers') };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = '';
  // The child now boots a real ProjectStorage whose sqlite worker threads
  // inherit process.execArgv; `-e`/`--input-type` cannot start a Worker, so the
  // program runs from an actual module file in the temporary root.
  const script = path.join(root, 'git-runtime-child.mjs');
  await fs.writeFile(script, code);
  await exec(process.execPath, [script], { env, timeout: 60000, maxBuffer: 1024 * 1024 });
});

test('relocated unpacked installation carries Git, libraries and helpers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-relocated-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installedRuntime = path.join(root, 'src/agents/managed/git-runtime.mjs');
  await fs.mkdir(path.dirname(installedRuntime), { recursive: true });
  await fs.copyFile(fileURLToPath(runtime), installedRuntime);
  await fs.mkdir(path.join(root,'src/platform/shared'),{recursive:true});
  await fs.copyFile(new URL('../src/platform/shared/runtime-assets.mjs',import.meta.url),path.join(root,'src/platform/shared/runtime-assets.mjs'));
  const dugiteRoot = path.dirname(require.resolve('dugite/package.json'));
  // git-runtime uses dugite's environment exports only. Copy the installed
  // package whole, including its downloaded private git/ distribution.
  await fs.cp(dugiteRoot, path.join(root, 'node_modules/dugite'), { recursive: true, verbatimSymlinks: true });
  const code = `
    import assert from 'node:assert/strict';
    const {ensureGit,runGit}=await import(${JSON.stringify(pathToFileURL(installedRuntime).href)});
    const git=await ensureGit();
    assert(git.command.startsWith(${JSON.stringify(root)}));
    assert(git.env.GIT_EXEC_PATH.startsWith(${JSON.stringify(root)}));
    await runGit(${JSON.stringify(root)},['init','--bare','-q','relocated.git']);
    assert.equal((await runGit(${JSON.stringify(root)},['--git-dir=relocated.git','rev-parse','--is-bare-repository'])).toString().trim(),'true');
  `;
  const env = { ...process.env, PATH: '' };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = '';
  await exec(process.execPath, ['--input-type=module', '-e', code], { env, timeout: 60000 });
});

test('missing private dependency is an explicit broken provisioning error', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-missing-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'src/agents/managed/git-runtime.mjs');
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.copyFile(fileURLToPath(runtime), file);
  await fs.mkdir(path.join(root,'src/platform/shared'),{recursive:true});await fs.copyFile(new URL('../src/platform/shared/runtime-assets.mjs',import.meta.url),path.join(root,'src/platform/shared/runtime-assets.mjs'));
  const code = `
    import assert from 'node:assert/strict';
    const {ensureGit}=await import(${JSON.stringify(pathToFileURL(file).href)});
    await assert.rejects(ensureGit(),error=>error.code==='GIT_PROVISIONING_FAILED'&&/reinstall the application/.test(error.message));
  `;
  await exec(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, NODE_PATH: '', PATH: '' }, timeout: 30000 });
});
