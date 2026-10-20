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
    const shadow=new ShadowVersions({projectRoot:repo});
    await shadow.ensureRepo();
    assert.equal((await shadow.git(['rev-parse','--is-bare-repository'])).toString().trim(),'true');
    assert.deepEqual({...process.env},before);
  `;
  const env = { ...process.env, PATH: '', LOCAL_GIT_DIRECTORY: path.join(root, 'wrong-git'), GIT_EXEC_PATH: path.join(root, 'wrong-helpers') };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = '';
  await exec(process.execPath, ['--input-type=module', '-e', code], { env, timeout: 60000, maxBuffer: 1024 * 1024 });
});

test('relocated unpacked installation carries Git, libraries and helpers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-relocated-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installedRuntime = path.join(root, 'src/agents/managed/git-runtime.mjs');
  await fs.mkdir(path.dirname(installedRuntime), { recursive: true });
  await fs.copyFile(fileURLToPath(runtime), installedRuntime);
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
  const file = path.join(root, 'git-runtime.mjs');
  await fs.copyFile(fileURLToPath(runtime), file);
  const code = `
    import assert from 'node:assert/strict';
    const {ensureGit}=await import(${JSON.stringify(pathToFileURL(file).href)});
    await assert.rejects(ensureGit(),error=>error.code==='GIT_PROVISIONING_FAILED'&&/reinstall the application/.test(error.message));
  `;
  await exec(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, NODE_PATH: '', PATH: '' }, timeout: 30000 });
});
