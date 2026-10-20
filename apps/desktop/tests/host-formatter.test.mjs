import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopHost } from '../src/main/host.mjs';
import { FormatterService } from '../src/main/formatter-service.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nozeli-formatter-project-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'nozeli-formatter-user-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'main.ts'), 'const value:number={a:1};\n');
  await writeFile(path.join(root, 'src', 'data.json'), '{"name":"Nozeli","items":[1,2]}');
  await writeFile(path.join(root, 'src', 'style.css'), 'body{color:red;margin:0  ;}\n');
  const host = new DesktopHost(userData); const opened = await host.pick(root);
  return { root, userData, host, projectId: opened.project.id, async cleanup() { await rm(root, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true }); } };
}

test('real Prettier formats TypeScript JSON and CSS in memory', async () => {
  const fx = await fixture(); const service = new FormatterService({ host: fx.host });
  try {
    const outputs = [];
    for (const relPath of ['src/main.ts', 'src/data.json', 'src/style.css']) {
      const file = await fx.host.readFile(fx.projectId, relPath);
      const result = await service.format({ projectId: fx.projectId, relPath, text: file.text });
      assert.ok(result.changed); assert.ok(result.text.length > 0); assert.ok(result.version); assert.ok(result.parser);
      const again = await service.format({ projectId: fx.projectId, relPath, text: result.text });
      assert.equal(again.text, result.text, `${relPath} output is not stable`);
      assert.equal(await readFile(path.join(fx.root, relPath), 'utf8'), file.text, `${relPath} was written unexpectedly`);
      outputs.push({ relPath, parser: result.parser, version: result.version });
    }
    console.log(JSON.stringify({ cwd: fx.root, outputs }));
  } finally { await fx.cleanup(); }
});

test('Prettier failures and project escapes preserve the buffer', async () => {
  const fx = await fixture(); const service = new FormatterService({ host: fx.host });
  try {
    const invalid = 'const = ;';
    await assert.rejects(() => service.format({ projectId: fx.projectId, relPath: 'src/main.ts', text: invalid }), error => error.code === 'FORMAT_FAILED');
    await assert.rejects(() => service.format({ projectId: fx.projectId, relPath: '../outside.ts', text: 'const value = 1;' }), error => error.code === 'BAD_PATH' || error.code === 'ESCAPE');
    assert.equal(await readFile(path.join(fx.root, 'src/main.ts'), 'utf8'), 'const value:number={a:1};\n');
  } finally { await fx.cleanup(); }
});

test('range formatting expands to a statement and preserves the other statements', async () => {
  const fx = await fixture(); const service = new FormatterService({ host: fx.host });
  try {
    const text = 'const first={a:1};\nconst second={b:2};\n';
    const result = await service.format({ projectId: fx.projectId, relPath: 'src/main.ts', text, range: { from: 0, to: text.indexOf('\n') } });
    assert.match(result.text, /^const first = \{ a: 1 \};\n/);
    assert.ok(result.text.endsWith('const second={b:2};\n'));
    await assert.rejects(() => service.format({ projectId: fx.projectId, relPath: 'src/main.ts', text, range: { from: -1, to: 3 } }), { code: 'FORMAT_RANGE' });
  } finally { await fx.cleanup(); }
});
