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
  if(!status.value.initialized){
    await page.waitForFunction(()=>document.querySelector('#configuration-setup')?.open||window.__readingSetupDismissed===true);
    if(await page.$eval('#configuration-setup',node=>node.open))await page.click('#configuration-cancel');
    await page.evaluate(()=>{window.__readingSetupDismissed=true;});
  }
  installFileTreeClicks(page,message=>console.log('reading smoke: '+message));
}
