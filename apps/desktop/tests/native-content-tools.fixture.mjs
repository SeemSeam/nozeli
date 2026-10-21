// Real pointer interactions with the native pane button and the shared document menu.
const menu = '#document-context-menu:not([hidden])';
const command = id => '.nozeli-context-menu:not([hidden]) [data-command="' + id + '"]';

export async function openContentTools(rootPage, contentPage, viewId) {
  await rootPage.locator('.workspace-pane:has([data-view-id="'+viewId+'"]) .workspace-pane-header').click({button:'right'});
  await rootPage.waitForSelector('#workspace-title-menu:not([hidden]) [data-command="tools"]');
  await rootPage.click('#workspace-title-menu [data-command="tools"]');
  await contentPage.waitForSelector(menu, {visible: true});
  return contentPage;
}

async function choose(contentPage, pathIds) {
  if (!Array.isArray(pathIds) || !pathIds.length) throw Error('A document command path is required');
  for (let index = 0; index < pathIds.length; index++) {
    const selector = command(pathIds[index]);
    await contentPage.waitForSelector(selector, {visible: true});
    if (index === pathIds.length - 1) await contentPage.click(selector);
    else await contentPage.hover(selector);
  }
  return contentPage;
}

export async function contentTool(rootPage, contentPage, viewId, pathIds) {
  await openContentTools(rootPage, contentPage, viewId);
  return choose(contentPage, pathIds);
}

async function scope(page) {
  return page.evaluate(async () => (await window.nozeli.invoke('workspace.bootstrap', {})).value).catch(() => null);
}

export async function openContentToolsForPage(page) {
  const own = await scope(page);
  if (own?.role === 'surface') {
    for (const root of await page.browser().pages()) {
      const candidate = await scope(root);
      if (candidate && ['shell', 'detached'].includes(candidate.role) &&
          (candidate.role === 'shell' ? own.windowId === 'main' : candidate.projectId === own.projectId && candidate.windowId === own.windowId)) {
        return openContentTools(root, page, own.viewId);
      }
    }
    throw Error('No native root found for document ' + own.viewId);
  }
  const viewId = await page.evaluate(() => {
    const focused = document.querySelector('[data-workspace-group].is-focused [data-workspace-content]');
    return (focused || document.querySelector('[data-workspace-content][data-view-id]'))?.dataset.viewId;
  });
  if (viewId) {
    for (const content of await page.browser().pages()) {
      const candidate = await scope(content);
      if (candidate?.role === 'surface' && candidate.viewId === viewId) return openContentTools(page, content, viewId);
    }
    throw Error('No content page found for view ' + viewId);
  }
  throw Error('No presented native document view');
}

export async function contentToolForPage(page, pathIds) {
  const content = await openContentToolsForPage(page);
  return choose(content, pathIds);
}
