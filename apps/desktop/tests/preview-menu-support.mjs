import assert from 'node:assert/strict';

// Exercise the public context menu with native mouse input, including the
// source-side entry when the preview has been closed.
export async function openPreviewMenu(page, control, side = 'preview') {
  // Closing a pane resizes the editor and restores its saved viewport. Wait
  // for that layout before opening a menu that correctly closes on scrolling.
  await new Promise(resolve => setTimeout(resolve, 250));
  const candidates = side === 'source' ? ['#text-host', '#text-preview'] :
    control.startsWith('tex-') ? ['#secondary-pdf', '#text-host'] : ['#text-preview', '#text-host'];
  let point;
  for (const selector of candidates) {
    point = await page.$eval(selector, node => {
      const box = node.getBoundingClientRect();
      const viewport = node.closest('#markdown-preview-scroll,#reader-scroll,#secondary-scroll')?.getBoundingClientRect() || box;
      const left = Math.max(0, box.left, viewport.left), top = Math.max(0, box.top, viewport.top);
      return Math.min(box.right, viewport.right) - left > 12 && Math.min(box.bottom, viewport.bottom) - top > 30 ? { x: left + 5, y: top + 20 } : null;
    });
    if (point) break;
  }
  assert(point, 'No visible source/preview surface');
  const hit = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y);
    return { x, y, tag: node?.tagName, id: node?.id, class: String(node?.className || ''), parents: [...(function*(){for(let p=node;p;p=p.parentElement)if(p.id)yield p.id;})()] };
  }, point);
  console.log('MENU_HIT '+JSON.stringify({control,side,...hit}));
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.waitForSelector('#document-context-menu:not([hidden])');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await page.$eval('#document-context-menu', node => node.hidden), false, 'Right-click menu was dismissed by delayed preview navigation');
  if (control !== 'tex-auto') {
    await page.click('#document-context-menu [data-command="view"]');
    await page.waitForSelector('.nozeli-submenu [data-command="preview-toggle"]');
  }
  const checks = await page.$$eval('.nozeli-context-menu:not([hidden]) [role="menuitemcheckbox"]', nodes => nodes.map(node => ({
    checked: node.getAttribute('aria-checked') === 'true',
    mark: getComputedStyle(node.querySelector('span'), '::before').content,
  })));
  assert(checks.length > 0, 'Preview menu has no checked-state controls');
  for (const check of checks) assert.equal(check.mark.includes('✓'), check.checked, 'Visible menu tick differs from actual state');
}

export async function clickPreviewControl(page, control, side = 'preview') {
  const command = control === 'tex-auto' ? 'tex-auto' : control.endsWith('sync') ? 'preview-link' : 'preview-toggle';
  await openPreviewMenu(page, control, side);
  const selector = (command === 'tex-auto' ? '#document-context-menu' : '.nozeli-submenu') + ' [data-command="' + command + '"]';
  assert.equal(await page.$eval(selector, node => node.disabled), false, command + ' is unavailable');
  await page.click(selector);
  await page.waitForSelector('#document-context-menu', { hidden: true });
}
