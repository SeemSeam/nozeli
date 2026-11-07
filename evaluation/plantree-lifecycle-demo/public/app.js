'use strict';
const $ = (id) => document.getElementById(id);
const roles = { plan: '方案', decision: '决策', implementation: '实施', test: '测试', report: '报告', knowledge: '知识提议（未集成批准）' };
const statuses = { active: '进行中', done: '已完成', conflict: '存在冲突', proposed: '待核验提议', archived: '已归档' };
let state = null, nodeId = null, documentId = null, currentDocument = null;
let documentRequest = 0, stateRequest = 0, searchRequest = 0;
let cleanupPlan = null, gcPlan = null, searchPage = null;
let draft = null, draftKey = null;
const draftPrefix = 'plantree-lifecycle-draft:';
const memoryDrafts = new Map();
let storageWarningShown = false;

function text(id, value) { $(id).textContent = value ?? ''; }
function message(id, value, error = false) { text(id, value); $(id).classList.toggle('error', error); }
function element(tag, content, className) {
  const el = document.createElement(tag);
  if (content != null) el.textContent = content;
  if (className) el.className = className;
  return el;
}
function statusName(value) { return statuses[value] || value || '未标注'; }
function revision() { if (!state) throw new Error('尚未读取服务器版本，请先刷新。'); return state.revision; }
async function api(path, body) {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`服务器未返回有效 JSON（HTTP ${response.status}）。`); }
  if (!response.ok || !result.ok) {
    const error = new Error(`${result.error?.code || `HTTP_${response.status}`}：${result.error?.message || '请求未完成'}`);
    error.code = result.error?.code;
    throw error;
  }
  return result.value;
}
async function action(buttonId, messageId, work) {
  const button = $(buttonId) || document.querySelector(`[data-testid="${buttonId}"]`);
  if (button.disabled) return;
  button.disabled = true;
  message(messageId, '正在处理…');
  try { await work(); } catch (error) { message(messageId, error.message, true); }
  finally {
    button.disabled = false;
    updatePlanButtons();
    if (buttonId === 'save-document') button.disabled = !nodeId || !!selectedNode()?.archived;
  }
}
function selectedNode() { return state?.nodes.find((node) => node.id === nodeId); }
function nodePath(id) {
  const parts = [], seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = state?.nodes.find((item) => item.id === id);
    if (!node) break;
    parts.unshift(node.title);
    id = node.parentId;
  }
  return parts.join(' / ');
}
function invalidatePlans(reason) {
  if (cleanupPlan) {
    cleanupPlan.stale = true;
    message('cleanup-message', `预览已失效：${reason}。请重新预览；不会自动替换或执行旧范围。`, true);
  }
  if (gcPlan) {
    gcPlan.stale = true;
    message('gc-message', `GC 预览已失效：${reason}。请重新预览并确认。`, true);
  }
  updatePlanButtons();
}
function draftBlocks(plan) {
  if (!plan || !state) return [];
  const keys = new Set(memoryDrafts.keys());
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(draftPrefix)) keys.add(key.slice(draftPrefix.length));
    }
  } catch { /* Current-page drafts are still checked. */ }
  const roots = new Set(plan.candidates.map((item) => item.nodeId));
  const blocked = new Set();
  for (const key of keys) {
    const value = readDraft(key);
    if (!value?.dirty) continue;
    const ownerId = value.nodeId || (key.startsWith('new:') ? key.slice(4) : state.documents.find((item) => item.id === key.slice(4))?.nodeId);
    let id = ownerId;
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      if (roots.has(id)) { blocked.add(ownerId); break; }
      id = state.nodes.find((item) => item.id === id)?.parentId;
    }
  }
  return [...blocked];
}
function updatePlanButtons() {
  const blocked = draftBlocks(cleanupPlan);
  message('cleanup-draft-message', blocked.length ? `本地草稿保护：${blocked.map((id) => nodePath(id) || id).join('、')} 有未保存输入。归档被阻止；请先保存或在对应编辑器中明确放弃草稿。` : '', blocked.length > 0);
  $('cleanup-apply').disabled = !cleanupPlan || cleanupPlan.stale || !cleanupPlan.candidates?.length || cleanupPlan.revision !== state?.revision || blocked.length > 0;
  $('gc-apply').disabled = !gcPlan || gcPlan.stale || !gcPlan.candidates?.length || gcPlan.revision !== state?.revision;
}
function readDraft(key) {
  if (memoryDrafts.has(key)) return memoryDrafts.get(key);
  try { const raw = sessionStorage.getItem(draftPrefix + key); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function storeDraft() {
  if (!draft || !draftKey) return;
  draft.title = $('document-title').value;
  draft.body = $('document-body').value;
  draft.type = $('document-type').value;
  draft.nodeId = nodeId;
  memoryDrafts.set(draftKey, { ...draft });
  try { sessionStorage.setItem(draftPrefix + draftKey, JSON.stringify(draft)); }
  catch {
    if (!storageWarningShown) {
      message('global-message', '浏览器会话存储不可用：草稿仍保留在当前页面内，但刷新将丢失，请先复制正文。', true);
      storageWarningShown = true;
    }
  }
  updatePlanButtons();
}
function removeDraft(key) {
  memoryDrafts.delete(key);
  try { sessionStorage.removeItem(draftPrefix + key); } catch { /* Current-page map remains authoritative. */ }
  updatePlanButtons();
}
function showDraft(key, doc = null) {
  draftKey = key;
  const existing = readDraft(key);
  draft = existing?.dirty ? existing : { title: doc?.title || '', body: doc?.body || '', type: doc?.type || 'plan', baseRevision: doc?.revision ?? null, dirty: false, nodeId };
  $('document-title').value = draft.title;
  $('document-body').value = draft.body;
  $('document-type').value = draft.type;
  $('document-type').disabled = !!doc;
  $('discard-draft').hidden = !nodeId;
  text('draft-state', draft.dirty ? '● 未保存草稿（切换时保留）' : '已与服务器同步');
  text('editor-heading', doc ? '更新同一职责文档' : '在选中节点新建职责文档');
  text('save-document', doc ? '保存原文档的新版本' : '创建职责文档');
  text('document-meta', doc ? `文档 ID：${doc.id} · 服务器文档版本 ${doc.revision} · 草稿基线 ${draft.baseRevision} · ${statusName(doc.status)}${doc.pinned ? ' · 已保护' : ''}${draft.dirty && draft.baseRevision !== doc.revision ? ' · 服务器已变化：保存将进行版本冲突检查，草稿不会被覆盖' : ''}` : `主要归属：${nodePath(nodeId) || '请先选择节点'} · 知识文档默认为提议，不自动批准`);
  $('pin-document').hidden = !doc;
  text('pin-document', doc?.pinned ? '取消文档保护' : '保护文档');
  $('document-form').hidden = !nodeId;
  $('save-document').disabled = !nodeId || !!selectedNode()?.archived;
  $('versions-panel').hidden = !doc;
  message('document-error', selectedNode()?.archived ? '这是已归档节点。正文仍可读取；恢复节点后再保存文档。' : '');
}
function renderTree() {
  const tree = $('tree'); tree.replaceChildren();
  const visible = state.nodes.filter((node) => $('history').checked || !node.archived);
  const activeCount = state.nodes.filter((node) => !node.archived).length;
  text('tree-count', `活动 ${activeCount} · 归档 ${state.nodes.length - activeCount} · 当前显示 ${visible.length}`);
  const visibleIds = new Set(visible.map((node) => node.id));
  const visited = new Set();
  function append(node, depth) {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const button = element('button', null, 'tree-node');
    button.type = 'button'; button.dataset.testid = 'tree-node'; button.dataset.nodeId = node.id;
    button.style.setProperty('--depth', Math.min(depth, 8));
    button.setAttribute('aria-current', String(node.id === nodeId));
    button.append(element('span', node.title), element('small', `${statusName(node.status)}${node.archived ? ' · 已归档' : ''}${node.pinned ? ' · 已保护' : ''}`));
    button.addEventListener('click', () => selectNode(node.id)); tree.append(button);
    for (const child of visible.filter((item) => item.parentId === node.id)) append(child, depth + 1);
  }
  for (const node of visible.filter((item) => !visibleIds.has(item.parentId))) append(node, 0);
  for (const node of visible) append(node, 0);
  if (!visible.length) tree.append(element('p', state.nodes.length ? '活动树为空。打开“包含归档”查看并恢复历史。' : '尚无节点。从目标开始建树，再沿节点维护方案、决定和证据。', 'muted'));
}
function renderNode() {
  const node = selectedNode();
  text('node-badge', node ? `${statusName(node.status)}${node.archived ? ' · 已归档' : ''}` : '未选择节点');
  text('node-path', node ? `${nodePath(node.id)} · ID ${node.id}` : '选择节点 → 查找既有职责 → 更新原文档或有界新增。');
  $('node-actions').hidden = !node;
  $('new-document').disabled = !node || !!node.archived;
  if (node) {
    $('node-status').value = node.status;
    $('node-status').disabled = !!node.archived;
    $('save-status').disabled = !!node.archived;
    text('pin-node', node.pinned ? '取消节点保护' : '保护节点');
    $('restore').hidden = !node.archived;
  }
  const list = $('documents'); list.replaceChildren();
  const docs = state.documents.filter((doc) => doc.nodeId === nodeId);
  for (const doc of docs) {
    const button = element('button', null, 'doc-button'); button.type = 'button';
    button.dataset.testid = 'document-item'; button.dataset.documentId = doc.id;
    button.setAttribute('aria-current', String(doc.id === documentId));
    button.append(element('strong', `${roles[doc.type] || doc.type} · ${doc.title}`), element('small', `文档版本 ${doc.revision} · ${statusName(doc.status)}${doc.pinned ? ' · 已保护' : ''}`));
    button.addEventListener('click', () => openDocument(doc.id)); list.append(button);
  }
  if (!docs.length) list.append(element('p', node ? '此节点没有职责文档。按实际需要创建，不强制补齐整套空文档。' : '先在左侧选择或创建节点。', 'muted small'));
}
async function loadState({ preserveDocument = true } = {}) {
  const token = ++stateRequest;
  const next = await api('/api/state?history=1');
  if (token !== stateRequest) return;
  if (state && state.revision !== next.revision) invalidatePlans(`全局版本由 ${state.revision} 变为 ${next.revision}`);
  state = next;
  text('revision', `全局版本 ${state.revision}`);
  if (nodeId && !selectedNode()) { storeDraft(); nodeId = null; documentId = null; currentDocument = null; }
  if (!nodeId) nodeId = state.nodes.find((node) => !node.archived)?.id || ($('history').checked ? state.nodes[0]?.id : null) || null;
  renderTree(); renderNode(); updatePlanButtons();
  if (preserveDocument && documentId) await openDocument(documentId, { revealHistory: false });
  else if (!documentId) {
    showDraft(`new:${nodeId || 'none'}`);
    $('document-form').hidden = !nodeId;
  }
}
async function selectNode(id) {
  storeDraft(); ++documentRequest;
  nodeId = id; documentId = null; currentDocument = null;
  renderTree(); renderNode();
  message('node-action-message', ''); message('reference-error', '');
  showDraft(`new:${id}`);
}
function renderVersions(doc) {
  const container = $('versions'); container.replaceChildren();
  container.append(element('p', `稳定身份 ${doc.id}；当前文档版本 ${doc.revision}。版本不因导航归档而删除。`));
  for (const version of doc.versions || []) {
    const row = element('div', null, 'plan-item');
    row.append(element('span', `版本 ${version.revision ?? version.version ?? '—'} · 对象 ${version.digest || version.objectDigest || '未提供摘要'}`));
    const button = element('button', '读取此版本正文');
    button.type = 'button'; button.dataset.testid = 'read-version';
    button.dataset.revision = version.revision;
    const output = element('div');
    button.addEventListener('click', async () => {
      button.disabled = true;
      output.replaceChildren(element('p', '正在读取历史正文…'));
      try {
        const historical = await api(`/api/document?id=${encodeURIComponent(doc.id)}&revision=${version.revision}`);
        output.replaceChildren(element('p', `${historical.title} · 只读版本 ${historical.revision} · 当前 head ${historical.currentRevision}（不改变编辑草稿基线）`), element('pre', historical.body));
      } catch (error) { output.replaceChildren(element('p', error.message, 'message error')); }
      finally { button.disabled = false; }
    });
    row.append(button, output);
    container.append(row);
  }
  if (!doc.versions?.length) container.append(element('p', '服务器未返回独立历史版本入口；当前正文可在上方读取。', 'muted'));
  const refs = doc.references || [];
  text('references', `已登记引用：${refs.length ? refs.map((ref) => typeof ref === 'string' ? ref : (ref.toId || ref.docId || JSON.stringify(ref))).join('、') : '无'}`);
}
async function openDocument(id, { revealHistory = true } = {}) {
  storeDraft();
  const token = ++documentRequest;
  message('document-error', '正在读取文档…');
  try {
    const doc = await api(`/api/document?id=${encodeURIComponent(id)}`);
    if (token !== documentRequest) return;
    documentId = doc.id; currentDocument = doc; nodeId = doc.nodeId;
    if (revealHistory && selectedNode()?.archived) $('history').checked = true;
    renderTree(); renderNode(); showDraft(`doc:${doc.id}`, doc); renderVersions(doc);
  } catch (error) { if (token === documentRequest) message('document-error', error.message, true); }
}
function cleanupReason(reason) {
  if (typeof reason !== 'string') return JSON.stringify(reason);
  if (reason === 'done subtree without active/conflict/pin/live external source references') return '子树已完成，且无进行中节点、冲突、用户保护或活动范围的来源引用';
  const prefixes = { 'active descendant: ': '子树内仍有进行中节点：', 'conflict descendant: ': '子树内仍有冲突：', 'pinned node: ': '用户保护节点：', 'pinned document: ': '用户保护文档：', 'live source reference: ': '仍被活动范围文档引用为来源：' };
  for (const [prefix, translated] of Object.entries(prefixes)) if (reason.startsWith(prefix)) return translated + reason.slice(prefix.length);
  return reason;
}
function renderCleanup(plan) {
  const container = $('cleanup-plan'); container.replaceChildren();
  container.append(element('p', `预览基线：全局版本 ${plan.revision} · 预计整理后活动节点 ${plan.estimatedActiveAfter ?? '服务器未提供'}`, 'small'));
  container.append(element('h2', `可归档 ${plan.candidates.length} 个范围`));
  for (const item of plan.candidates) {
    const row = element('div', null, 'plan-item'); row.append(element('strong', item.title), element('span', `ID ${item.nodeId} · ${cleanupReason(item.reason || '满足服务端归档条件')}`)); container.append(row);
  }
  container.append(element('h2', `保留 / 阻止 ${plan.blocked.length} 个范围`));
  for (const item of plan.blocked) {
    const row = element('div', null, 'plan-item'); row.append(element('strong', item.title));
    const reasons = element('ul'); for (const reason of item.reasons || []) reasons.append(element('li', cleanupReason(reason)));
    row.append(reasons); container.append(row);
  }
}
function renderGC(plan) {
  const container = $('gc-plan'); container.replaceChildren();
  container.append(element('p', `全局版本 ${plan.revision} · 可回收 ${plan.candidates.length} 个对象 · 受保护 ${plan.protectedCount ?? '未提供'} 个`, 'small'));
  if (plan.graceMs != null) container.append(element('p', `宽限期 ${plan.graceMs} 毫秒`, 'small'));
  for (const item of plan.candidates) container.append(element('p', `${item.digest} · ${item.bytes} 字节`, 'plan-item'));
  if (!plan.candidates.length) container.append(element('p', plan.reason || '没有符合服务端宽限期与无引用条件的孤儿工具对象；历史版本仍受保护。', 'muted small'));
}
async function search(append = false) {
  const query = $('search-query').value.trim();
  if (!query) { message('search-message', '请输入检索关键词。', true); return; }
  const token = ++searchRequest;
  const settings = append && searchPage ? searchPage : { query, history: $('search-history').checked, nextOffset: 0, revision: null };
  const offset = append ? settings.nextOffset : 0;
  $('search-more').disabled = true;
  message('search-message', '正在检索…');
  try {
    const result = await api(`/api/search?q=${encodeURIComponent(settings.query)}&history=${settings.history ? 1 : 0}&offset=${offset}&limit=20`);
    if (token !== searchRequest) return;
    if (append && settings.revision !== result.revision) {
      searchPage = null; $('search-more').hidden = true;
      message('search-message', '检索版本已变化，请重新检索以避免跨版本分页。', true); return;
    }
    if (!append) $('search-results').replaceChildren();
    for (const row of result.rows) {
      const card = element('div', null, 'result'); const button = element('button', row.title);
      button.type = 'button'; button.dataset.testid = 'search-result'; button.dataset.documentId = row.docId;
      button.addEventListener('click', () => openDocument(row.docId));
      card.append(button, element('p', `${roles[row.type] || row.type} · ${statusName(row.status)} · ${row.archived ? '归档历史' : '当前'} · ${nodePath(row.nodeId) || row.nodeId}`), element('p', row.excerpt || ''), element('p', `ID ${row.docId}`, 'muted'));
      $('search-results').append(card);
    }
    searchPage = { ...settings, revision: result.revision, nextOffset: result.nextOffset };
    $('search-more').hidden = result.nextOffset == null;
    message('search-message', `全局版本 ${result.revision} · 共 ${result.total} 条 · 已显示 ${$('search-results').children.length} 条`);
  } catch (error) { if (token === searchRequest) message('search-message', error.message, true); }
  finally { $('search-more').disabled = false; }
}

$('history').addEventListener('change', () => { if (state) renderTree(); });
$('refresh').addEventListener('click', () => action('refresh', 'global-message', async () => {
  storeDraft(); await loadState(); message('global-message', '已刷新服务器状态；未保存草稿保持原基线。');
}));
$('node-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action('create-node', 'node-error', async () => {
    const result = await api('/api/node', { title: $('node-title').value.trim(), ...($('node-child').checked && nodeId ? { parentId: nodeId } : {}) });
    invalidatePlans('新增了节点'); await loadState();
    const createdId = result.id || result.node?.id;
    if (createdId) await selectNode(createdId);
    $('node-title').value = ''; message('node-error', '节点已创建。现在可沿该节点维护职责文档。');
  });
});
$('save-status').addEventListener('click', () => action('save-status', 'node-action-message', async () => {
  await api('/api/node/status', { id: nodeId, status: $('node-status').value, expectedRevision: revision() });
  invalidatePlans('节点状态已变更'); await loadState(); message('node-action-message', '节点状态已更新。旧整理预览已失效。');
}));
$('pin-node').addEventListener('click', () => action('pin-node', 'node-action-message', async () => {
  await api('/api/pin', { id: nodeId, kind: 'node', pinned: !selectedNode().pinned, expectedRevision: revision() });
  invalidatePlans('节点保护状态已变更'); await loadState(); message('node-action-message', '节点保护状态已更新。旧整理预览已失效。');
}));
$('restore').addEventListener('click', () => action('restore', 'node-action-message', async () => {
  await api('/api/restore', { nodeId, expectedRevision: revision() }); invalidatePlans('归档节点已恢复');
  await loadState(); message('node-action-message', '已恢复到活动树，文档身份和版本保持不变。');
}));
$('discard-draft').addEventListener('click', async () => {
  if (!draftKey) return;
  if (draft?.dirty && !confirm('确定放弃当前未保存草稿？此操作不会删除服务器文档或历史版本。')) return;
  removeDraft(draftKey); draft = null; draftKey = null;
  if (documentId) await openDocument(documentId);
  else showDraft(`new:${nodeId}`);
  message('document-error', '当前草稿已明确放弃；其他节点/文档的草稿不受影响。');
});
$('new-document').addEventListener('click', () => {
  storeDraft(); ++documentRequest; documentId = null; currentDocument = null; renderNode(); showDraft(`new:${nodeId}`); $('document-title').focus();
});
for (const id of ['document-title', 'document-body', 'document-type']) $(id).addEventListener('input', () => {
  if (!draft) return; draft.dirty = true; storeDraft(); text('draft-state', '● 未保存草稿（切换时保留）');
});
$('document-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action('save-document', 'document-error', async () => {
    storeDraft();
    const savingKey = draftKey, savingNode = nodeId, savingId = documentId;
    const snapshot = { ...draft };
    const result = await api('/api/document', {
      nodeId: savingNode, type: snapshot.type, title: snapshot.title, body: snapshot.body,
      ...(savingId ? { existingId: savingId, expectedDocumentRevision: snapshot.baseRevision } : {}),
    });
    invalidatePlans('文档内容与版本已变化');
    const id = result.id || result.document?.id || savingId;
    // A user may continue typing or change selection while the request is in flight.
    const latest = readDraft(savingKey);
    const unchanged = latest && latest.title === snapshot.title && latest.body === snapshot.body && latest.type === snapshot.type;
    const stillSelected = draftKey === savingKey;
    removeDraft(savingKey);
    if (!unchanged && latest && id) {
      latest.baseRevision = result.revision;
      const nextKey = `doc:${id}`;
      memoryDrafts.set(nextKey, latest);
      try { sessionStorage.setItem(draftPrefix + nextKey, JSON.stringify(latest)); } catch { /* Keep the in-page draft. */ }
      if (stillSelected) { draftKey = nextKey; draft = latest; }
    } else if (stillSelected) { draft = null; draftKey = null; }
    if (stillSelected && id) documentId = id;
    await loadState({ preserveDocument: false });
    if (stillSelected && nodeId === savingNode && id) await openDocument(id);
    message('document-error', savingId ? '已更新同一文档，历史版本保留。' : '职责文档已登记到当前节点。');
  });
});
$('pin-document').addEventListener('click', () => action('pin-document', 'document-error', async () => {
  await api('/api/pin', { id: documentId, kind: 'document', pinned: !currentDocument.pinned, expectedRevision: revision() });
  invalidatePlans('文档保护状态已变更'); await loadState(); message('document-error', '文档保护状态已更新。旧整理预览已失效。');
}));
$('reference-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action('add-reference', 'reference-error', async () => {
    if (!documentId) throw new Error('先保存并选择引用发起文档。');
    await api('/api/reference', { fromId: documentId, toId: $('reference-target').value.trim() });
    invalidatePlans('文档来源引用已变化'); await loadState(); message('reference-error', '确切来源引用已登记。');
  });
});
$('search-form').addEventListener('submit', (event) => { event.preventDefault(); search(false); });
$('search-more').addEventListener('click', () => search(true));
for (const id of ['search-query', 'search-history']) $(id).addEventListener('input', () => {
  ++searchRequest; searchPage = null; $('search-more').hidden = true;
  if ($('search-results').children.length) message('search-message', '检索条件已变化；下方为旧结果，请重新检索。');
});
$('cleanup-preview').addEventListener('click', () => action('cleanup-preview', 'cleanup-message', async () => {
  const plan = await api('/api/cleanup/preview', {});
  cleanupPlan = { ...plan, stale: plan.revision !== state?.revision };
  renderCleanup(plan); updatePlanButtons();
  message('cleanup-message', cleanupPlan.stale ? '服务器版本已变化，请刷新状态后重新预览。' : (plan.candidates.length ? '请核对归档范围和阻止原因，再显式确认。' : '没有可归档范围，请查看保留原因。'), cleanupPlan.stale);
}));
$('cleanup-apply').addEventListener('click', () => action('cleanup-apply', 'cleanup-message', async () => {
  if (!cleanupPlan || cleanupPlan.stale || cleanupPlan.revision !== revision()) throw new Error('预览已失效，请重新预览。');
  if (draftBlocks(cleanupPlan).length) throw new Error('归档范围内存在未保存草稿。请先保存或明确放弃；未向服务器执行归档。');
  const controls = ['document-title', 'document-body', 'document-type', 'save-document', 'discard-draft', 'new-document'];
  const disabled = controls.map((id) => $(id).disabled);
  for (const id of controls) $(id).disabled = true;
  document.querySelector('.workspace').inert = true;
  try {
    await api('/api/cleanup/apply', { id: cleanupPlan.id, expectedRevision: cleanupPlan.revision });
    cleanupPlan.stale = true; invalidatePlans('已执行归档'); await loadState();
  } catch (error) { invalidatePlans('服务器拒绝旧预览或执行失败'); throw error; }
  finally {
    document.querySelector('.workspace').inert = false;
    controls.forEach((id, index) => { $(id).disabled = disabled[index]; });
    $('document-type').disabled = !!documentId;
    $('save-document').disabled = !nodeId || !!selectedNode()?.archived;
    $('new-document').disabled = !nodeId || !!selectedNode()?.archived;
  }
  message('cleanup-message', '预览范围已归档，未删除正文。打开左侧“包含归档”可读取和恢复。');
}));
$('cache-rebuild').addEventListener('click', () => action('cache-rebuild', 'cache-message', async () => {
  await api('/api/cache/rebuild', {}); await loadState(); message('cache-message', '缓存已从规范数据重建；正文与持久归属不依赖缓存。');
}));
$('gc-preview').addEventListener('click', () => action('gc-preview', 'gc-message', async () => {
  const plan = await api('/api/gc/preview', {}); gcPlan = { ...plan, stale: plan.revision !== state?.revision };
  renderGC(plan); updatePlanButtons();
  message('gc-message', gcPlan.stale ? '服务器版本已变化，请刷新并重新预览。' : (plan.candidates.length ? '仅下列孤儿工具对象满足当前服务端回收条件；执行时会再次核验。' : '服务端未发现可回收对象：须同时满足工具自有、无当前/历史引用且超过 60 秒宽限期。请查看保护对象计数；未回收不等于归档失败。'), gcPlan.stale);
}));
$('gc-apply').addEventListener('click', () => action('gc-apply', 'gc-message', async () => {
  if (!gcPlan || gcPlan.stale || gcPlan.revision !== revision()) throw new Error('GC 预览已失效，请重新预览。');
  try { await api('/api/gc/apply', { id: gcPlan.id, expectedRevision: gcPlan.revision }); }
  catch (error) { invalidatePlans('服务器拒绝旧 GC 预览或执行失败'); throw error; }
  gcPlan.stale = true; await loadState(); message('gc-message', '已完成预览孤儿对象回收；当前和历史文档不在删除范围内。');
}));
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  text('theme', theme === 'dark' ? '浅色主题' : '深色主题');
  $('theme').setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  try { localStorage.setItem('plantree-demo-theme', theme); } catch { /* Theme can remain page-local. */ }
}
$('theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
let initialTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
try { initialTheme = localStorage.getItem('plantree-demo-theme') || initialTheme; } catch { /* Use system preference. */ }
setTheme(initialTheme);
$('document-form').hidden = true; $('versions-panel').hidden = true; $('new-document').disabled = true;
loadState().catch((error) => message('global-message', `无法读取独立 demo：${error.message}。请检查服务并点击刷新。`, true));
