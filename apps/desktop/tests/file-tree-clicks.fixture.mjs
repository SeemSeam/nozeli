// Keep file navigation physical: reveal the current layout's file rail and expand
// ancestors before Puppeteer performs its normal visibility/hit-test click.
export function installFileTreeClicks(page, log = () => {}) {
  const click = page.click.bind(page);
  if(page.__fileTreeClicksInstalled)return;
  page.__fileTreeClicksInstalled=true;
  async function reveal() {
    const hidden = await page.$eval('#app', node => node.classList.contains('narrow-layout')
      ? !node.classList.contains('drawer-files-open')
      : node.classList.contains('files-collapsed'));
    if (hidden) {
      log('revealing file tree');
      await page.waitForSelector('#file-toggle', {visible:true});
      await click('#file-toggle');
    }
    await page.waitForFunction(() => {
      const files=document.getElementById('files'),bounds=files?.getBoundingClientRect();
      return bounds?.width>80&&!files.inert;
    });
  }
  page.click = async (selector, options) => {
    if (selector.startsWith('#file-tree ')) {
      await page.waitForSelector(selector);
      log('opening '+selector);
      await reveal();
      const path = await page.$eval(selector, node => node.dataset.path);
      if (path) {
        const parts=path.split('/');parts.pop();
        for(let depth=1;depth<=parts.length;depth++) {
          const parent='#file-tree button[data-path='+JSON.stringify(parts.slice(0,depth).join('/'))+']';
          if(await page.$eval(parent,node=>node.getAttribute('aria-expanded')==='false')) {
            await page.waitForSelector(parent,{visible:true});
            await click(parent);
          }
        }
      }
      await page.waitForSelector(selector,{visible:true});
    }
    return click(selector,options);
  };
}
