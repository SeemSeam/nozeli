import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';

// Real Electron controls + real Config/Host stores; no injected IPC responses.
const appRoot=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-omp-setup-ui-'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(mode){
  const root=path.join(out,mode,'.Nozeli'),profile=path.join(root,'desktop');
  const host=new DesktopHost(profile),projects=[];
  const importSource=path.join(out,mode,'import-source');await fs.mkdir(importSource,{recursive:true});
  for(const name of ['first','second']){
    const dir=path.join(out,mode,name);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'note.md'),'# Local reading remains available\n');
    projects.push((await host.pick(dir)).project);
  }
  const [first,second]=projects;
  const store=await Workspace.open(path.join(profile,'nozeli/managed-v1',first.id,'runtime'),(await host.requireProject(first.id)).root);
  const work=await store.submit('Historical Codex report','fixture',{name:'Legacy work'});await store.activate(work.id);
  const receipt=await store.publish(work.id,1,'result','# Saved historical report\n\nNever replay this accepted job.\n','old-report');await store.settle(work.id);await store.close();
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const ozone=process.env.NOZELI_OZONE||'headless';
  const child=spawn(createRequire(import.meta.url)('electron'),[path.join(appRoot,'src/main/main.cjs'),'--ozone-platform='+ozone],{cwd:appRoot,env:{...process.env,OMP_PROFILE:'default',PI_PROFILE:'default',PI_CODING_AGENT_DIR:importSource,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:root,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:ozone==='headless'?'1':'0'},stdio:['ignore','pipe','pipe']});
  let log='',browser,page;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
  const exited=new Promise(resolve=>child.once('exit',resolve));
  try{
    for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await pause(100);}}
    assert(browser,log);
    const target=await browser.waitForTarget(target=>target.type()==='page'&&target.url().startsWith('http://127.0.0.1:'),{timeout:30000});
    page=await target.page();assert(page,'Renderer target must expose a page');
    await page.waitForFunction(()=>window.__nozeliReady);await page.waitForSelector('#configuration-setup[open]');
    assert.equal((await page.evaluate(()=>nozeli.invoke('config.status',{}))).value.initialized,false);
    await page.click('#configuration-cancel');
    assert.equal((await page.evaluate(()=>nozeli.invoke('config.status',{}))).value.initialized,false);
    for(const project of [first,second,first]){
      await page.locator('[data-project-id="'+project.id+'"]').click();
      await page.waitForFunction(name=>document.querySelector('#project-name').textContent===name,{},project.name);
      // The project heading precedes state restoration and __agentProject. Wait
      // for that project's offline session and history load, not a stale archive
      // left by the previous project while activation is still in flight.
      await page.waitForFunction(name=>document.querySelector('#provider-console-project').textContent==='项目：'+name&&document.querySelector('#ai-status').dataset.state==='unavailable'&&!document.querySelector('[data-history-reload]').disabled,{},project.name);
      assert.equal(await page.$eval('#configuration-setup',node=>node.open),false);
    }
    await page.$eval('#composer',node=>{node.value='Keep this local draft';node.dispatchEvent(new Event('input',{bubbles:true}));});
    // Input persists an offline draft into runtime state, which intentionally
    // invalidates the history snapshot. Refresh only after that real write;
    // stale snapshots must continue to be rejected rather than retried silently.
    let draftSaved=false;
    for(let i=0;i<100;i++){
      const state=JSON.parse(await fs.readFile(path.join(store.root,'state.json'),'utf8'));
      if(state.drafts?.frontdesk==='Keep this local draft'){draftSaved=true;break;}
      await pause(50);
    }
    assert(draftSaved,'offline draft must persist without configuration or execution');
    if(await page.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true'))await page.click('#toggle-sidebar');
    if(!await page.$eval('#managed-work-archive',node=>node.open))await page.locator('#managed-work-archive > summary').click();
    await page.waitForSelector('[data-managed-history-object="'+receipt.objectId+'"]',{visible:true});
    await page.locator('[data-history-reload]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-history-reload]').disabled);
    await page.locator('[data-managed-history-object="'+receipt.objectId+'"]').click();
    await page.waitForFunction(()=>document.querySelector('#managed-doc').textContent.includes('Never replay this accepted job.'));
    assert.equal(await page.$eval('#compose-form',node=>node.inert),true);
    assert.equal(await page.$eval('#composer',node=>node.value),'Keep this local draft');
    assert.equal(await page.$$eval('#managed-doc [data-managed-end-result],#managed-doc [data-managed-recovery-action]',nodes=>nodes.length),0);
    await page.evaluate(()=>window.__agentSend());
    assert.match(await page.$eval('#compose-status',node=>node.textContent),/发送未发出/);
    assert.equal(await page.$eval('#composer',node=>node.value),'Keep this local draft');
    // Open settings through the same visible UI action the user uses, not a source-text assertion.
    { await page.click('#open-settings'); await page.click('[data-settings-section="settings-general"]'); await page.click('#provider-console-toggle'); }
    await page.waitForSelector('#configuration-setup[open]');
    assert.equal(await page.$$eval('#configuration-setup select,#managed-settings select',nodes=>nodes.length),0);
    const forbidden=await page.$$eval('button,select,option',nodes=>nodes.filter(node=>!node.hidden&&/codex|claude|保存 Provider|选择 Provider/i.test(node.textContent)).map(node=>node.textContent));
    assert.deepEqual(forbidden,[]);
    // No secret consent is checked implicitly. Import uses the actual Config importer.
    assert.equal(await page.$eval('#configuration-api-keys',node=>node.checked),false);
    await page.click(mode==='import'?'#configuration-import':'#configuration-independent');
    await page.waitForFunction(()=>!document.querySelector('#configuration-setup').open);
    const status=(await page.evaluate(()=>nozeli.invoke('config.status',{}))).value;
    assert.equal(status.initialized,true);assert.equal(status.choice,mode);
    const duplicate=await page.evaluate(mode=>nozeli.invoke('config.initialize',{mode,includeApiKeys:false}),mode);
    assert.equal(duplicate.ok,false,'one-time setup cannot be changed or reimported');
    await page.screenshot({path:path.join(out,mode+'.png')});
  } catch(error) {
    if(page&&!page.isClosed()){
      await page.screenshot({path:path.join(out,mode+'-failure.png')}).catch(()=>{});
      await fs.writeFile(path.join(out,mode+'-failure-dom.json'),JSON.stringify(await page.evaluate(()=>({project:document.querySelector('#project-name')?.textContent,sessionProject:document.querySelector('#provider-console-project')?.textContent,ai:document.querySelector('#ai-status')?.outerHTML,history:document.querySelector('#managed-work-archive')?.outerHTML,report:document.querySelector('#managed-doc')?.textContent})),null,2)).catch(()=>{});
    }
    console.error('Electron setup smoke failed ('+mode+'); logs: '+path.join(out,mode+'.log')+'\n'+log);
    throw error;
  } finally {
    if(page&&!page.isClosed()&&child.exitCode===null)await page.evaluate(()=>nozeli.invoke('session.requestClose',{})).catch(()=>{});
    if(child.exitCode===null){await Promise.race([exited,pause(5000)]);if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);}if(child.exitCode===null){child.kill('SIGKILL');await exited;}}
    await browser?.disconnect();
    await fs.writeFile(path.join(out,mode+'.log'),log);
  }
}
await run('independent');await run('import');
console.log('OMP setup/cancel/import/independent/read-only history consumer checks passed; '+out);
