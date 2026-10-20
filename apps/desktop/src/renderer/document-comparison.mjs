import './document-comparison.css';

const $ = id => document.getElementById(id);
export function versionCaption(version) {
  if (!version.revision) return 'v0 · 开始记录时的版本';
  const time = new Date(version.time).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return `v${version.revision} · ${version.actor.name} · ${time}${version.actor.kind === 'external' ? '（检测时间）' : ''}`;
}

export function mountDocumentComparison({ current, invoke, openSnapshot, toast }) {
  const dialog = $('beside-dialog');
  let source = 'file', token = 0, context = null, cursor = null, versions = new Map(), busy = false;
  const identity = file => file ? file.projectId + '\0' + (file.relPath || '') : null;
  const active = request => request === token && identity(current()) === identity(context) && dialog.open;
  function controls() {
    $('beside-source-file').setAttribute('aria-pressed', String(source === 'file'));
    $('beside-source-history').setAttribute('aria-pressed', String(source === 'history'));
    $('beside-files').hidden = source !== 'file'; $('beside-history').hidden = source !== 'history';
    $('beside-source-history').disabled = context?.kind !== 'text';
    $('beside-source-history').title = context?.kind === 'text' ? '比较当前文件的历史正文' : '历史对比仅支持文本文件';
    const chosen = source === 'history' ? versions.has(Number($('beside-version').value)) : Boolean($('beside-file').value);
    $('beside-open').disabled = busy || !chosen;
    $('beside-diff').disabled = busy || !chosen || context?.kind !== 'text' || source === 'file' && /\.(pdf|docx?|pptx?|xlsx?|png|jpe?g|gif|webp|svg|bmp|tiff?)$/i.test($('beside-file').value);
    $('beside-diff').title = $('beside-diff').disabled ? '差异比较需要两侧均为文本' : '只读比较当前内容与所选版本';
  }
  async function pageHistory(request, append = false) {
    if (!append) { cursor = null; versions.clear(); $('beside-version').replaceChildren(); $('beside-more').hidden = true; }
    busy = true; controls(); $('beside-status').textContent = '正在读取版本…';
    const result = await invoke('document.versions', { projectId: context.projectId, relPath: context.relPath, cursor: append ? cursor : null, limit: 50 });
    if (!active(request)) return;
    busy = false;
    if (!result.ok) { $('beside-status').textContent = result.error.message; controls(); return; }
    const selected = $('beside-version').value;
    for (const version of result.value.versions) {
      versions.set(version.revision, version);
      const option = document.createElement('option'); option.value = String(version.revision); option.textContent = versionCaption(version); $('beside-version').append(option);
    }
    if (append) $('beside-version').value = selected;
    else $('beside-version').value = String(context.dirty ? result.value.head.revision : Math.max(0, result.value.head.revision - 1));
    cursor = result.value.nextCursor; $('beside-more').hidden = !cursor;
    $('beside-status').textContent = `${context.relPath} · ${result.value.total}个已记录版本`;
    controls();
  }
  async function choose(kind) {
    source = kind; const request = ++token; busy = true; controls();
    if (kind === 'history') return pageHistory(request);
    $('beside-status').textContent = '正在读取项目文件…'; $('beside-file').replaceChildren();
    const result = await invoke('project.list', { projectId: context.projectId });
    if (!active(request)) return;
    busy = false;
    if (!result.ok) { $('beside-status').textContent = result.error.message; controls(); return; }
    for (const entry of result.value.entries.filter(e => e.kind !== 'dir')) {
      const option = document.createElement('option'); option.value = entry.relPath; option.textContent = entry.relPath; option.selected = entry.relPath === context.relPath; $('beside-file').append(option);
    }
    $('beside-status').textContent = ''; controls();
  }
  async function open(kind = 'file') {
    context = current(); if (!context) return toast('请先打开项目。');
    if (kind === 'history' && context.kind !== 'text') return toast('请先打开文本文件。');
    dialog.showModal(); await choose(kind);
  }
  async function compareVersion(version) {
    const file = current(); if (file?.kind !== 'text') return;
    const result = await invoke('document.version', { projectId: file.projectId, relPath: file.relPath, version });
    if (identity(current()) !== identity(file)) return;
    if (!result.ok) return toast(result.error.message);
    await openSnapshot(result.value, true, file);
  }
  $('open-beside').title = '文档对比：其他文件或历史版本'; $('open-beside').setAttribute('aria-label', '文档对比');
  $('open-beside').addEventListener('click', () => void open());
  $('beside-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if(!dialog.open)token++; });
  for (const kind of ['file', 'history']) $('beside-source-' + kind).addEventListener('click', () => void choose(kind));
  $('beside-more').addEventListener('click', () => void pageHistory(token, true));
  for (const id of ['beside-file', 'beside-version']) $(id).addEventListener('change', controls);
  $('beside-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const request = token, file = context, diff = event.submitter?.id === 'beside-diff';
    const historical = source === 'history';
    const selected = versions.get(Number($('beside-version').value)), relPath = $('beside-file').value;
    busy = true; controls(); $('beside-status').textContent = '正在准备对比…';
    const result = await invoke(historical ? 'document.version' : 'file.read', { projectId: file.projectId, relPath: historical ? file.relPath : relPath, ...(historical ? { version: selected } : {}) });
    if (!active(request)) return;
    busy = false;
    if (!result.ok) { $('beside-status').textContent = result.error.message; controls(); return; }
    if (diff && result.value.kind !== 'text') { $('beside-status').textContent = '此文件不能作为文本差异比较，请使用普通对照。'; controls(); return; }
    dialog.close(); await openSnapshot(result.value, diff, file);
  });
  return { open, compareVersion, close() { token++; if (dialog.open) dialog.close(); } };
}
