import {spawn} from 'node:child_process';
import {deserialize} from 'node:v8';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const INPUT_LIMIT = 32 * 1024 * 1024;
const OUTPUT_LIMIT = 40 * 1024 * 1024;
const DEADLINE_MS = 60000;
const workerPath = fileURLToPath(new URL('./search-document-worker.mjs', import.meta.url));
const error = (code, message) => Object.assign(new Error(message), {code});
const check = signal => { if (signal?.aborted) throw error('ABORT_ERR', '文档搜索已取消。'); };

/** Create a read-only, one-process-per-document reader using a standalone Node
 * runtime. args precede the worker script; env is an explicit complete environment
 * (empty by default, never implicitly inherit Electron/Node loader configuration).
 * Same input/result contract as searchDocumentText. No in-process fallback.
 */
export function createSearchDocumentReader({command, args = [], env = {}}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string')) throw new TypeError('文档提取需要独立 Node 运行时及明确的环境变量。');
  const runtimeArgs = [...args], runtimeEnv = {...env};
  return async function readDocument({host, projectId, relPath, signal}) {
    check(signal);
    const project = await host.requireProject(projectId);
    const located = await host.resolveFile(project, relPath);
    if (located.missing) throw error('NOT_FOUND', '搜索文档不存在。');
    const extension = path.posix.extname(located.rel).toLowerCase();
    if (!['.pdf', '.docx', '.pptx', '.xlsx'].includes(extension)) throw error('UNSUPPORTED', '正文搜索仅支持 PDF、DOCX、PPTX、XLSX；不支持旧版 Office、OCR 或外部转换。');
    check(signal);
    // Freeze the host-authorized bytes before starting a worker. No user file path
    // is passed to the child, and no material/history read APIs are involved.
    const bytes = await host.readSource(located.abs);
    check(signal);
    if (bytes.byteLength > INPUT_LIMIT) throw error('TOO_LARGE', '文档超过 32 MiB 搜索输入限制。');
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, [...runtimeArgs, workerPath, extension], {
          env: runtimeEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch {
        reject(error('DOCUMENT_WORKER_FAILED', '无法启动独立文档提取进程。'));
        return;
      }
      const chunks = [];
      let outputSize = 0, failure = null;
      const stop = reason => {
        failure ||= reason;
        child.kill('SIGKILL');
      };
      const abort = () => stop(error('ABORT_ERR', '文档搜索已取消。'));
      const timer = setTimeout(() => stop(error('DOCUMENT_WORKER_TIMEOUT', '文档提取超过 60 秒限制，已终止独立进程。')), DEADLINE_MS);
      timer.unref();
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      child.on('error', () => { failure ||= error('DOCUMENT_WORKER_FAILED', '无法启动独立文档提取进程。'); });
      child.stdin.on('error', () => { stop(error('DOCUMENT_WORKER_FAILED', '文档提取进程未能完整读取输入。')); });
      child.stdout.on('data', chunk => {
        outputSize += chunk.length;
        if (outputSize > OUTPUT_LIMIT) {
          stop(error('TOO_LARGE', '文档提取进程输出超过 40 MiB 限制。'));
          return;
        }
        if (!failure) chunks.push(chunk);
      });
      // Drain diagnostics without retaining potentially large or sensitive text.
      child.stderr.on('data', () => {});
      child.on('close', (code, terminationSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) failure = error('ABORT_ERR', '文档搜索已取消。');
        if (failure) { reject(failure); return; }
        if (code !== 0 || terminationSignal) {
          reject(error('DOCUMENT_WORKER_FAILED', `独立文档提取进程异常退出（${terminationSignal || code}），此文件未完成搜索。`));
          return;
        }
        try {
          const envelope = deserialize(Buffer.concat(chunks, outputSize));
          if (envelope?.ok === false && typeof envelope.error?.code === 'string' && typeof envelope.error?.message === 'string') {
            reject(error(envelope.error.code, envelope.error.message));
          } else if (envelope?.ok === true && typeof envelope.result?.text === 'string' && ['pdf', 'word', 'ppt', 'sheet'].includes(envelope.result.kind) && /^[a-f0-9]{64}$/.test(envelope.result.digest)) {
            resolve(envelope.result);
          } else {
            reject(error('DOCUMENT_WORKER_FAILED', '文档提取进程返回了无效结果。'));
          }
        } catch {
          reject(error('DOCUMENT_WORKER_FAILED', '文档提取进程返回了损坏的结果。'));
        }
      });
      child.stdin.end(bytes);
    });
  };
}
