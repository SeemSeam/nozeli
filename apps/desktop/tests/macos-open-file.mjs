import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {nativeFixture} from './desktop-native.fixture.mjs';
const f=await nativeFixture('macos-open-file',{'冷启动 中文.txt':'Cold launch 中文\n','同时打开.md':'# Multiple file\n','已有窗口.ts':'const existing = true;\n'});
async function presented(rel){return f.until(async()=>{for(const p of await f.browser.pages())if(await p.evaluate(rel=>__nozeliReady&&__workspaceScope?.relPath===rel,rel).catch(()=>false))return p;},'OS event opened '+rel);}
try{
 await f.start({launchServices:true,openFiles:['冷启动 中文.txt','同时打开.md']});
 for(const rel of ['冷启动 中文.txt','同时打开.md']){await presented(rel);assert.equal(await fs.readFile(path.join(f.project,rel),'utf8'),rel.endsWith('.md')?'# Multiple file\n':'Cold launch 中文\n');}
 f.check('Launch Services cold-starts the extracted application with PATH empty and routes multiple Chinese/space file paths to the registered project');
 const before=(await f.call('workspace.windows.list',{projectId:f.id})).map(w=>w.windowId??w.id);
 execFileSync('/usr/bin/open',['-a',process.env.NOZELI_TEST_BUNDLE,path.join(f.project,'已有窗口.ts')]);await presented('已有窗口.ts');
 assert.deepEqual((await f.call('workspace.windows.list',{projectId:f.id})).map(w=>w.windowId??w.id),before);f.check('a later OS open-file event reaches the existing application window');
 await f.close();await f.start({launchServices:true,openFiles:['已有窗口.ts']});const page=await presented('已有窗口.ts');await page.waitForFunction(()=>__nozeliInput.text()==='const existing = true;\n');f.check('normal quit and Launch Services restart reopen the same project and original source');await f.screenshot(page,'os-file-open');await f.close();await f.finish();
}catch(error){await f.finish(error);process.exitCode=1;}
