// Native CLI/SDK transport regression, not a visual-reasoning acceptance test.
// Run: node --test tests/omp-tui-images-live.mjs (uses the shipped private runtime)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { imageSize } from 'image-size';
import { OmpTuiSession } from '../src/agents/managed/omp-tui-session.mjs';
import { prepareOmpPrivateHome } from '../src/agents/managed/omp-provider-home.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=';

test('native Collab prompt consumes PNG data URL through SDK normalization and provider serialization', { timeout: 120000 }, async t => {
  const requests = [];
  let session = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { requests.push(JSON.parse(body)); } catch { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const delta of [{ role: 'assistant', content: 'transport accepted' }, {}]) {
        res.write('data: ' + JSON.stringify({ id: 'native-image', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: delta.content ? null : 'stop' }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-native-image-'));
  t.after(async () => { try { await session?.stop(); } finally { await rm(root, { recursive: true, force: true }); } });
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  await mkdir(cwd);
  const modelsYml = `providers:\n  image-transport:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    auth: none\n    models:\n      - id: vision\n        input: [text, image]\n`;
  await prepareOmpPrivateHome(home);
  await writeFile(path.join(home, 'models.yml'), modelsYml);
  await writeFile(path.join(home, 'config.yml'), 'setupVersion: 2\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nmodelRoles:\n  default: image-transport/vision\ndefaultThinkingLevel: off\n');
  session = new OmpTuiSession({ role: 'frontdesk', home, cwd, instructions: 'Return a brief response.', tools: [], settleTimeoutMs: 45000 });
  await session.start();
  // Session identity can arrive before native model selection initializes.
  // Observe readiness without dispatching a provider request.
  const modelDeadline = Date.now() + 20000;
  let native = await session.bridge.getState();
  while (!native.model && Date.now() < modelDeadline && !session.closed) {
    await new Promise(resolve => setTimeout(resolve, 100));
    native = await session.bridge.getState();
  }
  assert.equal(native.model, 'image-transport/vision');
  assert.ok(native.modelInput.includes('image'));
  const response = await session.prompt('PNG transport regression', {images:['data:image/png;base64,'+png],timeout:45000,job:{id:'image-transport-job',target:'frontdesk',revision:null,type:'front'}});
  assert.equal(response.completion, 'provider-completed');
  assert.equal(requests.length, 1);
  const user = requests[0].messages.find(message => message.role === 'user');
  const image = user.content.find(part => part.type === 'image_url');
  assert.ok(image, 'actual native provider request includes image_url, not merely an image type counter');
  // Native normalization may choose a smaller WebP/JPEG encoding.
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image.image_url.url);
  assert.ok(match, 'native provider receives image MIME and base64 data');
  const bytes = Buffer.from(match[2], 'base64');
  const size = imageSize(bytes);
  assert.equal(match[1], { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[size.type]);
  assert.ok(user.content.some(part => part.type === 'text' && part.text.includes('PNG transport regression')));
});
