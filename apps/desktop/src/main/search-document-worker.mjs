import {serialize} from 'node:v8';

// This entry point runs only in the configured standalone Node runtime, never
// Electron's main process. Its only document input is a bounded stdin byte stream.
const INPUT_LIMIT = 32 * 1024 * 1024;
const OUTPUT_LIMIT = 40 * 1024 * 1024;
// PDF.js may emit diagnostics while importing its optional native bindings. Keep
// stdout exclusively for the binary result protocol; diagnostics are not results.
for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
  console[name] = (...values) => { process.stderr.write(values.map(String).join(' ') + '\n'); };
}

let envelope;
try {
  const extension = process.argv[2];
  if (!['.pdf', '.docx', '.pptx', '.xlsx'].includes(extension)) throw Object.assign(new Error('文档提取格式无效。'), {code:'UNSUPPORTED'});
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > INPUT_LIMIT) throw Object.assign(new Error('文档超过 32 MiB 搜索输入限制。'), {code:'TOO_LARGE'});
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  const relPath = `document${extension}`;
  const project = {id:'search-document-worker'};
  // Deliberately no filesystem, storage, material, actor or recovery methods.
  const host = {
    async requireProject() { return project; },
    async resolveFile() { return {rel:relPath, abs:relPath, missing:false}; },
    async readSource() { return bytes; },
  };
  const {searchDocumentText} = await import('./search-document-text.mjs');
  envelope = {ok:true, result:await searchDocumentText({host, projectId:project.id, relPath})};
} catch (error) {
  envelope = {ok:false, error:{code:typeof error.code === 'string' ? error.code : 'INVALID_DOCUMENT', message:String(error.message || '文档文字提取失败。')}};
}
let output = serialize(envelope);
if (output.length > OUTPUT_LIMIT) output = serialize({ok:false, error:{code:'TOO_LARGE', message:'文档提取进程输出超过 40 MiB 限制。'}});
process.stdout.write(output, () => { process.exit(0); });
