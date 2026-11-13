const fs = require('node:fs/promises');
const {pipeline} = require('node:stream/promises');

// Large JS, fonts and document-engine assets must not allocate a whole-file
// Buffer in the host for every guest. Only nonce-bearing HTML needs rewriting.
async function serveStaticAsset(req, res, file, headers, {styleNonce, template = false} = {}) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('Static asset is not a regular file'), {code: 'EISDIR'});
    if (template) {
      const body = (await handle.readFile('utf8')).replaceAll('__NOZELI_STYLE_NONCE__', styleNonce);
      res.writeHead(200, {...headers, 'content-length': Buffer.byteLength(body)});
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    res.writeHead(200, {...headers, 'content-length': stat.size});
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(handle.createReadStream({autoClose: false}), res);
  } finally {
    await handle.close();
  }
}
module.exports = {serveStaticAsset};
