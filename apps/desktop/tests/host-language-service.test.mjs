import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopHost } from '../src/main/host.mjs';
import { LanguageServiceManager } from '../src/main/language-service-manager.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nozeli-lsp-project-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'nozeli-lsp-user-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'utils.ts'), 'export function formatUser(value: string): string { return value.trim(); }\n');
  await writeFile(path.join(root, 'src', 'main.ts'), 'import { formatUser } from "./utils";\nconst value: number = formatUser("Nozeli");\nformatUser("again");\n');
  const host = new DesktopHost(userData);
  const opened = await host.pick(root);
  return { root, userData, host, projectId: opened.project.id, async cleanup() { await rm(root, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true }); } };
}

test('real typescript-language-server supports diagnostics and cross-file requests', { timeout: 30000 }, async () => {
  const fx = await fixture(); const events = [];
  const manager = new LanguageServiceManager({ host: fx.host, userDataDir: fx.userData, onEvent: event => events.push(event) });
  try {
    const main = await fx.host.readFile(fx.projectId, 'src/main.ts');
    await manager.sync({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1 });
    let definition = await manager.request({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1, action: 'definition', line: 0, column: 14 });
    const first = Array.isArray(definition) ? definition[0] : definition;
    if (first?.relPath === 'src/main.ts') definition = await manager.request({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1, action: 'definition', line: first.range.start.line, column: first.range.start.character });
    const definitions = Array.isArray(definition) ? definition : definition?.value || definition;
    assert.ok((Array.isArray(definitions) ? definitions : [definitions]).some(item => item?.relPath === 'src/utils.ts'), JSON.stringify(definition));
    const references = await manager.request({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1, action: 'references', line: 2, column: 1 });
    assert.ok(Array.isArray(references) || Array.isArray(references?.value));
    const rename = await manager.request({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1, action: 'rename', line: 2, column: 7, newName: 'inputValue' });
    assert.ok(rename && (rename.changes || rename.value?.changes));
    const format = await manager.request({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1, action: 'format' });
    assert.ok(Array.isArray(format) || Array.isArray(format?.value));
    assert.equal(manager.status().projectId, fx.projectId);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !events.some(event => event.type === 'diagnostics')) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(events.some(event => event.type === 'ready'));
    assert.ok(events.some(event => event.type === 'diagnostics'));
    const diagnostic = events.find(event => event.type === 'diagnostics');
    assert.ok(diagnostic.diagnostics.some(item => /number|string|type/i.test(item.message)));
    const unsaved = main.text.replace('const value: number', 'const value: string');
    await manager.sync({ projectId: fx.projectId, relPath: 'src/main.ts', text: unsaved, version: 2 });
    assert.equal(manager.status().projectId, fx.projectId);
    const oldChild = manager.session.child;
    oldChild.kill('SIGTERM');
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline && !events.some(event => event.type === 'exit')) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(events.some(event => event.type === 'exit'));
    await manager.sync({ projectId: fx.projectId, relPath: 'src/main.ts', text: unsaved, version: 3 });
    assert.ok(events.filter(event => event.type === 'ready').length >= 2);
    const packageInfo = JSON.parse(await readFile(new URL('../node_modules/typescript-language-server/package.json', import.meta.url)));
    console.log(JSON.stringify({ serverVersion: packageInfo.version, cwd: fx.root, exit: events.find(event => event.type === 'exit'), logFile: events.find(event => event.type === 'exit')?.logFile }));
  } finally {
    await manager.stopAll();
    await fx.cleanup();
  }
});
