import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { windowBrand } from '../src/renderer/window-chrome.mjs';

test('window brand uses the supplied paired-tabs image and preserves accessibility', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement(tag) { return { tagName: tag }; } };
  try {
    const image = windowBrand();
    assert.equal(image.tagName, 'img');
    assert.equal(image.src, './nozeli-paired-tabs-icon.png');
    assert.equal(image.alt, 'Nozeli');
    assert.equal(image.className, 'nozeli-window-logo');
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('renderer build copies the supplied PNG under the referenced filename', async () => {
  const build = await readFile(new URL('../tools/build-renderer.mjs', import.meta.url), 'utf8');
  assert.ok(build.includes("await fs.copyFile(path.join(root,'assets/brand/nozeli-paired-tabs-icon.png'),path.join(output,'nozeli-paired-tabs-icon.png'));"));
  const image = await readFile(new URL('../assets/brand/nozeli-paired-tabs-icon.png', import.meta.url));
  assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(image.readUInt32BE(16), 1254);
  assert.equal(image.readUInt32BE(20), 1254);
});
