import {installFileTreeClicks} from './file-tree-clicks.fixture.mjs';

export async function waitForDesktopPage(browser) {
  const target = await browser.waitForTarget(target => target.type() === 'page' && target.url().startsWith('http://127.0.0.1:'));
  const page = await target.page();
  if (!page) throw new Error('Desktop page target has no page');
  return page;
}

// Call only after a pick that the fixture expects to succeed, never after cancel.
export async function waitForReadingProject(page, directory) {
  const ready = await page.waitForFunction(async directory => {
    const result = await window.nozeli.invoke('project.recent', {});
    if (!result.ok) throw new Error(result.error.message);
    const project = result.value.projects.find(project => project.rootDisplay === directory);
    if (!project) return false;
    const active = document.querySelector('#recent button[aria-current="true"]');
    return active?.dataset.projectId === project.id && document.querySelector('#project-name').textContent === project.name ? project.id : false;
  }, {}, directory);
  const id = await ready.jsonValue();
  await ready.dispose();
  return id;
}

export async function prepareReading(page) {
  await page.waitForFunction(()=>window.__nozeliReady===true);
  const status=await page.evaluate(()=>window.nozeli.invoke('config.status',{}));
  if(!status.ok)throw Error(status.error.message);
  // The one-time setup dialog may (re)open while its own config.status probe is
  // still resolving, so a single cancel can race a second showModal. Dismiss
  // deterministically: wait open===true, cancel, wait open===false, and repeat
  // while the dialog reappears; end by proving no modal remains to block clicks.
  for(let round=0;round<10;round++){
    const open=await page.$eval('#configuration-setup',node=>node.open).catch(()=>false);
    if(!open){
      if(status.value.initialized)break;
      await page.waitForFunction(()=>document.querySelector('#configuration-setup')?.open===true||window.__readingSetupDismissed===true,{timeout:5000}).catch(()=>{});
      if(!(await page.$eval('#configuration-setup',node=>node.open).catch(()=>false)))break;
    }
    await page.waitForSelector('#configuration-setup[open]',{timeout:5000});
    await page.click('#configuration-cancel');
    await page.waitForFunction(()=>document.querySelector('#configuration-setup').open===false,{timeout:5000});
    await page.evaluate(()=>{window.__readingSetupDismissed=true;});
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  await page.waitForFunction(()=>!document.querySelector('#configuration-setup[open]'),{timeout:5000});
  if(!page.__nativeDocumentNavigation)installFileTreeClicks(page,message=>console.log('reading smoke: '+message));
}
