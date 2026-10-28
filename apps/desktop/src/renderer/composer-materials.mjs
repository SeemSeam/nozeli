import { appendDrawingMaterial } from '../domain/drawing-delivery.mjs';
import { renderTagMarkdown } from './tag-markdown.mjs';
import { createFileIcon, fileIconType } from './file-icons.mjs';
import './conversation-rendering.css';

/* Composer materials and formatting for the main conversation.
 * - The original #composer textarea stays the single editing source.
 * - Renderer-selected local files are stored host-side (material.attach) as
 *   immutable instance recovery copies; sending promotes supported materials
 *   into project objects without altering user documents.
 * - Pending attachments, reply quote and preview state persist per project
 *   through the workspace snapshot hooks. */

const MAX_TEXT_INLINE = 256 * 1024;
const TEXT_EXT = /^(txt|md|markdown|mdx|json|ya?ml|toml|ini|log|csv|js|mjs|cjs|ts|jsx|tsx|css|scss|less|html?|xml|svg|py|sh|c|h|cpp|go|rs|java|rb|php|vue|svelte)$/i;

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtSize = n => n == null ? '' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MiB' : Math.max(1, Math.round(n / 1024)) + ' KiB';
const classify = (name, mime) => {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if ((mime || '').startsWith('image/')) return 'image';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (mime === 'application/json' || mime === 'text/plain' || (mime || '').startsWith('text/') || TEXT_EXT.test(ext)) return ext === 'md' || ext === 'markdown' || ext === 'mdx' ? 'markdown' : 'text';
  return 'binary';
};

export function mountComposerMaterials({ invoke, toast, openProjectFile, getProjectFile , composerReady, exposeProjectRoot }) {
  const projectRootGetter = exposeProjectRoot;
  const composer = document.getElementById('composer');
  const form = document.getElementById('compose-form');
  const statusEl = document.getElementById('compose-status');
  const footer = form.querySelector('.composer-footer');
  let projectId = null;
  let pending = [];       // [{key,name,mime,size,kind,source,status,digest?,relPath?,note?}]
  let quoteTo = null;
  let seq = 0;
  let revision = 0;
  let materialOwner = { projectId, target: null, pending, quote: quoteTo, reads: 0 };
  const readingOwners = new Map();
  const ownerKey = owner => JSON.stringify([owner.projectId, owner.target]);
  function persistedMaterials(owner) {
    return { pending: owner.pending.map(({ key, name, mime, size, kind, source, status, digest, relPath, note, frozenText, deliveryId, sources, projectId, instanceId, storage }) => ({ key, name, mime, size, kind, source, status, digest, relPath, note, frozenText, deliveryId, sources, projectId, instanceId, storage })), quote: owner.quote, deliveredDrawingIds: owner.deliveredDrawingIds || [] };
  }
  function beginRead() {
    if (!materialOwner.projectId || !materialOwner.target || composer.readOnly) { toast('请先核实材料的接收目标；材料尚未读取。'); return null; }
    const owner = materialOwner;
    owner.reads++;
    readingOwners.set(ownerKey(owner), owner);
    return owner;
  }
  function materialsChanged(owner) {
    if (owner === materialOwner) renderChips();
    composerReady?.({ projectId: owner.projectId, target: owner.target, materials: persistedMaterials(owner) });
  }
  function endRead(owner) {
    owner.reads--;
    if (!owner.reads && readingOwners.get(ownerKey(owner)) === owner) readingOwners.delete(ownerKey(owner));
    materialsChanged(owner);
  }

  /* ---------- markup (inserted around the untouched textarea) ----------
   * 2026-10-17 用户纠正：不做输入框内编辑工具或正文预览——textarea 保持
   * 原生多行/IME/选区/撤销；「美化输入」只发生在发送后的消息渲染。 */
  const quoteBar = document.createElement('div');
  quoteBar.className = 'cm-quote';
  quoteBar.hidden = true;
  const quoteText = document.createElement('span'); quoteText.className = 'cm-quote-text';
  const quoteCancel = document.createElement('button'); quoteCancel.type = 'button'; quoteCancel.textContent = '✕'; quoteCancel.setAttribute('aria-label', '取消回复');
  quoteBar.append(quoteText, quoteCancel);
  composer.before(quoteBar);

  const chipRow = document.createElement('div');
  chipRow.className = 'cm-chips';
  chipRow.setAttribute('aria-label', '待发送材料');
  footer.before(chipRow);




  /* ---------- send keys: Enter newline, Ctrl/Cmd+Enter send, IME guard --- */
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      // Enter inserts a newline natively; nothing to do, kept explicit for clarity.
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!event.repeat) form.requestSubmit();
    }
  });

  /* ---------- paste / drop images ------------------------------------------ */
  composer.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])];
    const images = files.filter(f => f.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    void addLocalFiles(images, 'paste');
  });
  form.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
  form.addEventListener('drop', event => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    void addLocalFiles([...event.dataTransfer.files], 'drop');
  });

  /* ---------- local files → host-managed immutable materials -------------- */
  async function addLocalFiles(files, source) {
    const owner = beginRead();
    if (!owner) return;
    try {
      // Stage the entire selection before the first await; every late receipt
      // and subsequent file belongs to this container, even after switching.
      const entries = [];
      for (const file of files) {
        const entry = { key: `f${++seq}`, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, kind: classify(file.name, file.type), source, status: 'reading' };
        if (file.size > 8 * 1024 * 1024) { entry.status = 'error'; entry.note = '超过单文件 8 MiB 上限，未添加'; }
        else if (owner.pending.some(a => a.name === file.name && a.size === file.size)) { entry.status = 'dup'; entry.note = '同名同大小材料已在列表'; }
        owner.pending.push(entry);
        if (entry.status === 'reading') entries.push({ file, entry });
      }
      materialsChanged(owner);
      for (const { file, entry } of entries) {
        if (!owner.pending.includes(entry)) continue;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!owner.pending.includes(entry)) continue;
          const result = await invoke('material.attach', { projectId: owner.projectId, name: file.name, mime: entry.mime, size: file.size, source, bytes: b64(bytes) });
          if (!result?.ok) throw new Error(result?.error?.message || '材料保存失败');
          Object.assign(entry, result.value); entry.status = 'ok';
          if (result.value.duplicate) entry.note = '相同内容已在历史材料中复用';
        } catch (error) { entry.status = 'error'; entry.note = String(error.message || error).slice(0, 80); }
        materialsChanged(owner);
      }
    } finally { endRead(owner); }
  }
  function b64(bytes) {
    let out = ''; const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(out);
  }

  /* ---------- 「引用文件」面板（用户收敛：合并所有＋内容，无二级菜单） ----
   * 一次点击直接进入文件列表：默认当前项目目录，当前阅读文件置顶；
   * 顶部路径输入/系统选目录可跳任意本机目录；目录仅浏览不读取内容，
   * 只有确认引用时宿主才读取并冻结所选文件（material.attachPath）。 */
  const addButton = document.createElement('button');
  addButton.type = 'button'; addButton.className = 'cm-add'; addButton.textContent = '＋ 引用文件';
  addButton.setAttribute('aria-haspopup', 'dialog');
  addButton.setAttribute('aria-expanded', 'false');
  footer.prepend(addButton);
  const panel = document.createElement('div');
  panel.className = 'cm-picker'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '引用文件'); panel.hidden = true;
  panel.innerHTML = `
    <div class="cm-picker-bar">
      <button type="button" class="cm-up" title="返回上级目录">↑ 上级</button>
      <input class="cm-path" type="text" placeholder="输入本机目录路径后 Enter，或点右侧选择…" aria-label="目录路径">
      <button type="button" class="cm-pick-files">选择文件…</button>
      <button type="button" class="cm-browse">选择文件夹…</button>
    </div>
    <p class="cm-picker-error" role="status" hidden></p>
    <div class="cm-picker-list" role="listbox" aria-multiselectable="true" tabindex="0"></div>
    <div class="cm-picker-foot">
      <span class="cm-picker-count">未选择文件</span>
      <span class="cm-picker-more" hidden></span>
      <button type="button" class="cm-cancel">取消</button>
      <button type="button" class="cm-confirm" disabled>引用所选文件</button>
    </div>
  `;
  document.body.append(panel);
  const listEl = panel.querySelector('.cm-picker-list'), pathInput = panel.querySelector('.cm-path');
  const errorEl = panel.querySelector('.cm-picker-error'), countEl = panel.querySelector('.cm-picker-count');
  const moreEl = panel.querySelector('.cm-picker-more'), confirmBtn = panel.querySelector('.cm-confirm');
  const upBtn = panel.querySelector('.cm-up'), browseBtn = panel.querySelector('.cm-browse'), pickFilesBtn = panel.querySelector('.cm-pick-files');
  let pickerPath = null, pickerOffset = 0, pickerHasMore = false, pickerEntries = [];
  const picked = new Map(); // absPath -> {name,size}

  function positionPicker() {
    if (panel.hidden) return;
    const anchor = addButton.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8)) + 'px';
    panel.style.top = Math.max(8, Math.min(anchor.top - bounds.height - 8, innerHeight - bounds.height - 8)) + 'px';
  }
  // Observe the rendered box, including late directory results and wrapped
  // footer/error text, rather than guessing the file list's eventual height.
  const pickerResize = new ResizeObserver(positionPicker);
  pickerResize.observe(panel);
  window.addEventListener('resize', positionPicker);
  function closePicker() { panel.hidden = true; addButton.setAttribute('aria-expanded', 'false'); addButton.focus({ preventScroll: true }); }
  addButton.addEventListener('click', async () => {
    if (!panel.hidden) { closePicker(); return; }
    panel.hidden = false; addButton.setAttribute('aria-expanded', 'true');
    positionPicker();
    // Focus before browsing: a late response must not steal focus after Esc.
    pathInput.focus({ preventScroll: true });
    const current = getProjectFile?.();
    const start = current?.absPath ? current.absPath.replace(/[\\/][^\\/]+$/, '') : projectRoot();
    await loadDir(start);
  });
  function projectRoot() { return projectRootGetter?.() || ''; }
  async function loadDir(target, offset = 0, keepError = null) {
    errorEl.hidden = !keepError; errorEl.textContent = keepError || '';
    const result = await invoke('material.browse', { path: target, offset });
    if (!result?.ok) {
      errorEl.hidden = false;
      errorEl.textContent = result?.error?.message || '目录读取失败';
      if (!pickerPath) { listEl.replaceChildren(); }
      return false;
    }
    const data = result.value;
    pickerPath = data.path; pickerOffset = data.offset; pickerHasMore = data.hasMore;
    pickerEntries = offset === 0 ? data.entries : pickerEntries.concat(data.entries);
    pathInput.value = data.path;
    renderPickerList();
    return true;
  }
  function renderPickerList() {
    listEl.replaceChildren();
    const current = getProjectFile?.();
    if (pickerOffset === 0 && current?.absPath && current.absPath.startsWith(pickerPath + pathSep()) && !current.absPath.slice(pickerPath.length + 1).includes(pathSep())) {
      const pin = document.createElement('button');
      pin.type = 'button'; pin.className = 'cm-entry cm-entry-current'; pin.dataset.path = current.absPath;
      pin.setAttribute('role', 'option');
      pin.innerHTML = `<span class="cm-entry-name">${esc(current.relPath.split('/').pop())}</span><span class="cm-entry-note">当前文件</span>`;
      pin.prepend(createFileIcon(current.relPath));
      pin.setAttribute('aria-selected', String(picked.has(current.absPath)));
      listEl.append(pin);
    }
    for (const entry of pickerEntries) {
      if (entry.dir) continue;
      if (current?.absPath && pickerOffset === 0 && entry.name === current.relPath.split('/').pop()) continue; // 已置顶
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'cm-entry'; row.dataset.path = pickerPath + pathSep() + entry.name;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(picked.has(row.dataset.path)));
      const note = entry.kind === 'symlink' ? '符号链接' : entry.size > 8 * 1024 * 1024 ? '超过 8 MiB' : fmtSize(entry.size);
      row.innerHTML = `<span class="cm-entry-name">${esc(entry.name)}</span><span class="cm-entry-note">${note}</span>`;
      row.prepend(createFileIcon(entry.name));
      listEl.append(row);
    }
    if (pickerOffset === 0) {
      for (const entry of pickerEntries) {
        if (!entry.dir) continue;
        const row = document.createElement('button');
        row.type = 'button'; row.className = 'cm-entry cm-entry-dir'; row.dataset.dir = pickerPath + pathSep() + entry.name;
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
        row.innerHTML = `<span class="cm-dir-mark">▸</span><span class="cm-entry-name">${esc(entry.name)}</span><span class="cm-entry-note">目录</span>`;
        listEl.append(row);
      }
    }
    if (pickerHasMore) {
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'cm-entry cm-entry-more';
      more.textContent = `加载更多（还有未显示项）`;
      listEl.append(more);
    }
    moreEl.hidden = true;
    updatePickerCount();
  }
  const pathSep = () => pickerPath && pickerPath.includes('\\') ? '\\' : '/';
  function updatePickerCount() {
    countEl.textContent = picked.size ? `已选 ${picked.size} 个文件（跨目录保留）` : '未选择文件';
    confirmBtn.disabled = picked.size === 0;
  }
  listEl.addEventListener('click', async event => {
    const more = event.target.closest('.cm-entry-more');
    if (more) { await loadDir(pickerPath, pickerOffset + 500); return; }
    const dir = event.target.closest('.cm-entry-dir');
    if (dir) { await loadDir(dir.dataset.dir); return; }
    const entry = event.target.closest('.cm-entry');
    if (!entry) return;
    const abs = entry.dataset.path;
    if (picked.has(abs)) picked.delete(abs); else picked.set(abs, { name: abs.split(/[\\\\/]/).pop(), path: abs });
    entry.setAttribute('aria-selected', String(picked.has(abs)));
    updatePickerCount();
  });
  listEl.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const entry = event.target.closest('.cm-entry');
    if (entry) { event.preventDefault(); entry.click(); }
  });
  upBtn.addEventListener('click', () => { if (pickerPath) void loadDir(parentOf(pickerPath)); });
  function parentOf(p) {
    const norm = p.replace(/[\\/]$/, '');
    const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
    if (idx <= 0) return p;
    return norm.slice(0, idx) || '/';
  }
  pathInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void loadDir(pathInput.value.trim()); }
  });
  browseBtn.addEventListener('click', async () => {
    browseBtn.disabled = true;
    browseBtn.textContent = '选择中…';
    errorEl.hidden = false;
    errorEl.textContent = '请在系统窗口选择目录；也可取消后在上方直接输入路径。';
    try {
      const result = await invoke('material.pickDirectory', { path: pickerPath });
      if (!result?.ok) throw new Error(result?.error?.message || '系统目录选择失败，请直接输入目录路径。');
      if (result.value?.path) await loadDir(result.value.path);
      else { errorEl.hidden = true; if (!panel.hidden) pathInput.focus(); }
    } catch (error) {
      errorEl.hidden = false;
      errorEl.textContent = error.message;
      if (!panel.hidden) pathInput.focus();
    } finally {
      browseBtn.disabled = false;
      browseBtn.textContent = '选择文件夹…';
    }
  });
  pickFilesBtn.addEventListener('click', async () => {
    pickFilesBtn.disabled = true;
    try {
      const result = await invoke('material.pickFiles', {});
      if (!result?.ok) throw new Error(result?.error?.message || '系统文件选择失败。');
      for (const abs of result.value?.paths || []) if (typeof abs === 'string' && abs) picked.set(abs, { name: abs.split(/[\\/]/).pop(), path: abs });
      renderPickerList();
      if (result.value?.paths?.length) errorEl.hidden = true;
    } catch (error) { errorEl.hidden = false; errorEl.textContent = error.message; }
    finally { pickFilesBtn.disabled = false; if (!panel.hidden) pathInput.focus(); }
  });
  document.addEventListener('keydown', event => {
    if (panel.hidden || event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    // Capture before a higher layer's own Escape handler can hide it. Native
    // dialogs, material previews and drawing retain ownership of that key.
    const higherLayer = [...document.querySelectorAll('dialog[open], [role="dialog"]:not([hidden]), [aria-modal="true"]:not([hidden]), [popover]:popover-open, .material-viewer:not([hidden]), .region-drawing-editor:not([hidden]), .nozeli-context-menu:not([hidden])')]
      .some(node => node !== panel && !panel.contains(node) && node.getClientRects().length > 0);
    if (higherLayer) return;
    event.preventDefault();
    event.stopPropagation();
    closePicker();
  }, true);
  panel.querySelector('.cm-cancel').addEventListener('click', () => { picked.clear(); updatePickerCount(); closePicker(); });
  confirmBtn.addEventListener('click', async () => {
    const owner = beginRead();
    if (!owner) return;
    const selected = [...picked], root = projectRoot();
    picked.clear(); updatePickerCount(); closePicker();
    try {
      const entries = [];
      for (const [abs, info] of selected) {
        if (owner.pending.some(a => a.absPath === abs)) continue;
        const inProject = owner.projectId && root && abs.startsWith(root);
        const entry = { key: `e${++seq}`, name: info.name, absPath: abs, kind: 'binary', source: 'path-select', status: 'reading', note: inProject ? '项目文件 · 只读引用' : '项目外 · 只读材料' };
        if (inProject) entry.relPath = abs.slice(root.length + 1).replace(/\\/g, '/');
        owner.pending.push(entry); entries.push({ abs, entry, inProject });
      }
      materialsChanged(owner);
      for (const { abs, entry, inProject } of entries) {
        if (!owner.pending.includes(entry)) continue;
        try {
          const result = await invoke('material.attachPath', { projectId: owner.projectId, path: abs });
          if (!result?.ok) throw new Error(result?.error?.message || '读取失败');
          Object.assign(entry, result.value);
          entry.kind = classify(entry.name, result.value.mime); entry.status = 'ok';
          if (looksLikeCredential(entry.name)) entry.note = (inProject ? '项目文件' : '项目外 · 只读材料') + ' · 注意：疑似凭据/密钥文件，确认后再随消息引用';
        } catch (error) { entry.status = 'error'; entry.note = String(error.message || error).slice(0, 90); }
        materialsChanged(owner);
      }
    } finally { endRead(owner); }
  });
  function looksLikeCredential(name) {
    return /(^|[\\/])(\.env|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials\.json|.*\.p12|.*\.kdbx)$/i.test(name);
  }


  /* ---------- @ project file search ---------------------------------------- */
  const atPopup = document.createElement('div');
  atPopup.className = 'cm-at'; atPopup.setAttribute('role', 'listbox'); atPopup.hidden = true;
  document.body.append(atPopup);
  let atItems = [], atIndex = 0, filePathsCache = [];
  async function refreshFilePaths() {
    if (!projectId) { filePathsCache = []; return; }
    const result = await invoke('project.list', { projectId });
    if (result?.ok) filePathsCache = result.value.entries.filter(e => e.kind !== 'dir').map(e => e.relPath);
  }
  function openAt(filter) {
    const q = (filter || '').toLowerCase();
    atItems = filePathsCache.filter(p => p.toLowerCase().includes(q)).slice(0, 8);
    if (!atItems.length) { closeAt(); return; }
    atIndex = 0;
    atPopup.replaceChildren();
    atItems.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(i === atIndex));
      b.append(createFileIcon(p), Object.assign(document.createElement('span'), { textContent: p }));
      b.addEventListener('click', () => insertAt('`' + p + '` '));
      atPopup.append(b);
    });
    const r = composer.getBoundingClientRect();
    atPopup.style.left = Math.min(r.left, innerWidth - 320) + 'px';
    atPopup.style.top = Math.max(8, r.top - 250) + 'px';
    atPopup.hidden = false;
  }
  function closeAt() { atPopup.hidden = true; atItems = []; }
  composer.addEventListener('input', () => {
    const upto = composer.value.slice(0, composer.selectionStart);
    const m = upto.match(/@([^@\s`]*)$/);
    if (m) openAt(m[1]); else closeAt();
  });
  composer.addEventListener('keydown', event => {
    if (atPopup.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      atIndex = (atIndex + (event.key === 'ArrowDown' ? 1 : atItems.length - 1)) % atItems.length;
      [...atPopup.children].forEach((n, i) => n.setAttribute('aria-selected', String(i === atIndex)));
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.isComposing) {
      event.preventDefault();
      insertAt('`' + atItems[atIndex] + '` ');
    } else if (event.key === 'Escape') {
      event.stopPropagation(); closeAt();
    }
  });
  composer.addEventListener('blur', () => setTimeout(closeAt, 150));
  function insertAt(text) {
    composer.focus();
    const s = composer.selectionStart, e = composer.selectionEnd;
    let ok = false;
    try { composer.setSelectionRange(s, e); ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    if (!ok) composer.setRangeText(text, s, e, 'end');
    closeAt();
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ---------- chips row + send preview ------------------------------------ */
  function chipNode(a) {
    const chip = document.createElement('span');
    chip.className = 'cm-chip' + (a.status === 'error' || a.status === 'dup' ? ' cm-chip-warn' : '');
    const main = document.createElement('button');
    main.type = 'button'; main.className = 'cm-chip-main';
    if (a.relPath && a.source !== 'selection') main.dataset.relPath = a.relPath;
    else if (a.digest) main.dataset.digest = a.digest;
    main.title = `${a.name}${a.size ? ' · ' + fmtSize(a.size) : ''} · ${sourceLabel(a.source)}${a.note ? ' · ' + a.note : ''}`;
    main.append(createFileIcon(a.relPath || a.name, { kind: a.kind === 'binary' ? undefined : a.kind }));
    const label = document.createElement('span'); label.textContent = a.name;
    const meta = document.createElement('small');
    meta.textContent = [a.size != null ? fmtSize(a.size) : null, sourceLabel(a.source)].filter(Boolean).join(' · ');
    main.append(label, meta);
    const badge = document.createElement('span');
    badge.className = 'cm-chip-status';
    badge.dataset.status = a.status;
    badge.textContent = a.status === 'ok' ? '已就绪' : a.status === 'reading' ? '读取中' : a.status === 'dup' ? '重复' : a.status === 'error' ? '失败' : '已就绪';
    main.append(badge);
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'cm-chip-x'; x.setAttribute('aria-label', '移除材料 ' + a.name); x.textContent = '×';
    x.addEventListener('click', () => {
      const i = pending.indexOf(a);
      if (i >= 0) pending.splice(i, 1);
      renderChips(); composerReady?.();
    });
    chip.append(main, x);
    return chip;
  }
  const sourceLabel = s => ({ 'local-select': '本地选择', paste: '粘贴', drop: '拖入', current: '当前文件', selection: '选区', project: '项目文件', 'path-select': '路径引用',drawing:'涂鸦' }[s] || s);
  function renderChips() {
    revision++;
    materialOwner.pending = pending; materialOwner.quote = quoteTo;
    chipRow.replaceChildren();
    pending.forEach(a => chipRow.append(chipNode(a)));
    updateSendState();
  }
  composer.addEventListener('input', () => { updateSendState(); });

  function updateSendState() {
    const send = document.getElementById('send-message');
    if (!send) return;
    const blocked = pending.some(a => a.status === 'error' || a.status === 'reading');
    send.classList.toggle('cm-send-blocked', blocked);
    if (blocked) send.title = '有材料未就绪，先移除或重新添加'; else send.title = '';
  }

  /* ---------- reply quote --------------------------------------------------- */
  quoteCancel.addEventListener('click', () => setQuote(null));
  function setQuote(message) {
    revision++;
    quoteTo = message ? { role: message.role, time: message.createdAt || message.time || '', text: String(message.text || '') } : null;
    materialOwner.quote = quoteTo;
    quoteBar.hidden = !quoteTo;
    if (quoteTo) quoteText.textContent = `回复 ${quoteTo.role === 'user' ? '你' : '前台'}${quoteTo.time ? ' ' + quoteTo.time : ''}：${quoteTo.text.replace(/\s+/g, ' ').slice(0, 60)}${quoteTo.text.length > 60 ? '…' : ''}`;
    composerReady?.();
  }

  /* ---------- chip open → project file or material viewer ------------------ */
  chipRow.addEventListener('click', async event => {
    const main = event.target.closest('.cm-chip-main');
    if (!main) return;
    await openChip(main);
  });
  async function openChip(main) {
    if (main.dataset.relPath) {
      if (projectId && openProjectFile) {
        try { await openProjectFile({ projectId, relPath: main.dataset.relPath }); } catch (error) { toast(error.message || '文件打开失败'); }
      } else toast('文件打开入口尚未接通');
      return;
    }
    if (main.dataset.digest) await openMaterial(main.dataset.digest, main.title);
  }
  window.__openMaterialAttachment = async ref => openMaterial(ref.digest, ref.name, ref);

  const viewer = document.createElement('aside');
  viewer.className = 'material-viewer';
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-label', '附件只读预览');
  viewer.hidden = true;
  viewer.innerHTML = `<header><strong class="mv-title"></strong><button type="button" class="mv-close">关闭 Esc</button></header><div class="mv-body" tabindex="0"></div>`;
  document.body.append(viewer);
  let viewerOpener = null;
  viewer.querySelector('.mv-close').addEventListener('click', closeViewer);
  viewer.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeViewer(); } });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !viewer.hidden) { closeViewer(); } });
  function closeViewer() {
    if (viewer.hidden) return;
    viewer.hidden = true;
    if (viewerOpener && document.contains(viewerOpener)) viewerOpener.focus(); else composer.focus();
    viewerOpener = null;
  }
  async function openMaterial(digest, title, sourceRef) {
    viewerOpener = document.activeElement;
    const body = viewer.querySelector('.mv-body');
    viewer.querySelector('.mv-title').textContent = title || '附件';
    body.replaceChildren();
    const note = document.createElement('p');
    note.className = 'mv-note';
    note.textContent = '读取中…';
    body.append(note);
    viewer.hidden = false;
    body.focus();
    const ref = sourceRef || pending.find(a => a.digest === digest);
    const result = await invoke('material.read', { projectId: ref?.projectId || materialOwner.projectId, instanceId: ref?.instanceId, storage: ref?.storage, source: ref?.source, digest });
    if (!result?.ok) {
      note.textContent = '附件读取失败：' + (result?.error?.message || '未知错误');
      return;
    }
    const { name, mime, size, bytes, source } = result.value;
    const drawing=pending.find(a=>a.digest===digest&&a.source==='drawing');
    if(drawing){const provenance=document.createElement('p');provenance.textContent=drawing.sources?.length?drawing.sources.map(s=>s.summary||s.identity?.relPath||'工作区来源 · 仅视口').join('；'):'工作区截图，未锚定文件';body.append(provenance);}
    viewer.querySelector('.mv-title').textContent = `${name} · ${fmtSize(size)} · 只读${source === 'drawing' ? ' · 涂鸦截图' : source === 'paste' ? ' · 粘贴' : source === 'drop' ? ' · 拖入' : source === 'path-select' ? ' · 路径引用' : ' · 本地选择'}`;
    note.remove();
    const kind = classify(name, mime);
    if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'mv-image';
      img.src = `data:${mime};base64,${bytes}`;
      img.alt = name;
      body.append(img);
    } else if (kind === 'pdf') {
      const frame = document.createElement('iframe');
      frame.className = 'mv-pdf';
      frame.src = `data:application/pdf;base64,${bytes}`;
      frame.title = name + '（只读 PDF）';
      body.append(frame);
      const cap = document.createElement('p');
      cap.className = 'mv-note';
      cap.textContent = '浏览器内置 PDF 阅读 · 附件为发送时冻结的副本。';
      body.append(cap);
    } else if (kind === 'markdown' || kind === 'text') {
      let text = '';
      try { text = new TextDecoder().decode(Uint8Array.from(atob(bytes), c => c.charCodeAt(0))); } catch { text = ''; }
      if (text && !text.includes('\u0000')) {
        const rendered = document.createElement('div');
        rendered.className = 'agent-message-body';
        renderTagMarkdown(rendered, text, {});
        body.append(rendered);
      } else {
        const meta = metaPanel(name, mime, size, '文本解码失败，按二进制材料保留');
        body.append(meta);
      }
    } else {
      body.append(metaPanel(name, mime, size, '该格式不支持解析预览（本产品未内置该引擎）；附件按原样冻结保留，可随消息引用'));
    }
  }
  function metaPanel(name, mime, size, note) {
    const p = document.createElement('p');
    p.className = 'mv-meta';
    p.textContent = `${name} · ${mime} · ${fmtSize(size)} · ${note}。`;
    return p;
  }

  /* ---------- send snapshot / confirm -------------------------------------- */
  function composedText() {
    const questions=pending.filter(a=>a.source==='drawing'&&a.status==='ok'&&typeof a.frozenText==='string'&&a.frozenText.trim()).map(a=>'涂鸦问题：'+a.frozenText);
    const text=[composer.value,...questions].filter(Boolean).join('\n\n');
    if (!quoteTo) return text;
    const excerpt = quoteTo.text.replace(/\s+/g, ' ').slice(0, 200);
    return `> 回复 ${quoteTo.role === 'user' ? '你' : '前台'}${quoteTo.time ? ' ' + quoteTo.time : ''}：${excerpt}${quoteTo.text.length > 200 ? '…' : ''}\n\n${text}`;
  }
  return {
    appendDrawing(delivery) {
      if (delivery.projectId !== materialOwner.projectId || delivery.target !== materialOwner.target) return false;
      const before = persistedMaterials(materialOwner), next = appendDrawingMaterial(before, delivery);
      if (next === before) return false;
      materialOwner.pending = next.pending; materialOwner.deliveredDrawingIds = next.deliveredDrawingIds;
      pending = materialOwner.pending; revision++;
      materialsChanged(materialOwner);
      return true;
    },
    setProject(id) { if (id === projectId) return; projectId = id; materialOwner = { projectId: id, target: null, pending: [], quote: null, reads: 0 }; pending = materialOwner.pending; quoteTo = null; quoteBar.hidden = true; renderChips(); closeAt(); if (!panel.hidden) closePicker(); void refreshFilePaths(); },
    setFilePaths(paths) { filePathsCache = paths || []; },
    blocked() { return pending.some(a => a.status === 'error' || a.status === 'reading'); },
    /** Snapshot for send: text (with quote) + material descriptors. */
    snapshot() {
      return {
        text: composedText(),
        attachments: pending.filter(a => a.status === 'ok').map(a => ({
          name: a.name, mime: a.mime || 'application/octet-stream', size: a.size ?? 0, kind: a.kind,
          digest: a.digest || null, relPath: a.relPath || null, source: a.source,
          frozenText: a.frozenText || null,
          projectId: a.projectId, instanceId: a.instanceId, storage: a.storage,
          ...(a.source === 'drawing' ? { deliveryId: a.deliveryId || a.key?.slice('drawing-'.length), sources: a.sources || [] } : {}),
        })),
      };
    },
    /** Receipt: clear only if nothing changed since the snapshot token. */
    confirmSent(token) {
      if (!token) return;
      if (token.pendingRef !== pending || token.revision !== revision || token.projectId !== projectId) return;
      pending = [];
      materialOwner.pending = pending;
      renderChips();
      setQuote(null);
    },
    token() { return { pendingRef: pending, revision, projectId }; },
    restore(value, identity = materialOwner) {
      const next = { projectId: identity.projectId ?? projectId, target: typeof identity.target === 'string' ? identity.target : null };
      if (next.projectId !== materialOwner.projectId || next.target !== materialOwner.target) { picked.clear(); closePicker(); closeAt(); }
      const inFlight = readingOwners.get(ownerKey(next));
      materialOwner = inFlight || { ...next, pending: Array.isArray(value?.pending) ? value.pending.filter(a => a && a.key).map(a => a.status === 'reading' ? { ...a, status: 'error', note: '上次读取未完成；材料已保留，请移除后重新添加。' } : a) : [], quote: value?.quote || null, deliveredDrawingIds: value?.deliveredDrawingIds || [], reads: 0 };
      pending = materialOwner.pending; quoteTo = materialOwner.quote;
      quoteBar.hidden = !quoteTo;
      if (quoteTo) quoteText.textContent = `回复 ${quoteTo.role === 'user' ? '你' : '前台'}${quoteTo.time ? ' ' + quoteTo.time : ''}：${String(quoteTo.text || '').replace(/\s+/g, ' ').slice(0, 60)}`;
      renderChips();
    },
    snapshotPersist() { return persistedMaterials(materialOwner); },
    setQuote,
    statusNote(message) { statusEl.textContent = message; },
    refreshFilePaths,
  };
}
