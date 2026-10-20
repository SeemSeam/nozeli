// Frozen result viewing never opens a live project file or replaces its editor.
// Inject the existing MergeView mount so this lifecycle can also run without Electron.
export function mountFrozenChangeReader({ parent, invoke, mountDiff, currentProjectId }) {
  const document = parent.ownerDocument;
  let overlay = null, diff = null, retained = [], focus = null, generation = 0;

  function restore({ focus: restoreFocus = true } = {}) {
    generation += 1;
    diff?.destroy(); diff = null;
    overlay?.remove(); overlay = null;
    for (const entry of retained) {
      entry.node.style.visibility = entry.visibility;
      entry.node.inert = entry.inert;
      if (entry.ariaHidden === null) entry.node.removeAttribute('aria-hidden');
      else entry.node.setAttribute('aria-hidden', entry.ariaHidden);
    }
    retained = [];
    if (restoreFocus && focus?.isConnected) focus.focus({ preventScroll: true });
    focus = null;
  }

  async function open({ projectId, changeSetId, fileId }) {
    if (projectId !== currentProjectId()) return { ok: false, error: { message: '项目已切换，原变更未打开。' } };
    if (!overlay) {
      focus = document.activeElement;
      retained = Array.from(parent.children, node => ({ node, visibility: node.style.visibility, inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') }));
      for (const { node } of retained) {
        node.style.visibility = 'hidden'; node.inert = true; node.setAttribute('aria-hidden', 'true');
      }
      overlay = document.createElement('section');
      overlay.className = 'document-diff frozen-change-reader';
      overlay.setAttribute('aria-label', '冻结变更 · 只读');
      overlay.style.inset = '0';
      parent.append(overlay);
    }
    const token = ++generation;
    diff?.destroy(); diff = null;
    overlay.replaceChildren();
    const head = document.createElement('div'); head.className = 'document-diff-head';
    const left = document.createElement('header'), right = document.createElement('header');
    const back = document.createElement('button'); back.type = 'button'; back.textContent = '返回阅读';
    back.addEventListener('click', () => restore());
    const title = document.createElement('span'); title.className = 'document-diff-title'; title.textContent = '冻结变更 · 只读';
    const previous = document.createElement('button'), next = document.createElement('button'), count = document.createElement('span');
    previous.type = next.type = 'button'; previous.textContent = '上一处'; next.textContent = '下一处';
    previous.setAttribute('aria-label', '上一处差异'); next.setAttribute('aria-label', '下一处差异');
    previous.disabled = next.disabled = true; count.setAttribute('role', 'status');
    previous.addEventListener('click', () => diff?.navigate(-1));
    next.addEventListener('click', () => diff?.navigate(1));
    const navigation = document.createElement('div'); navigation.className = 'diff-navigation'; navigation.append(previous, count, next);
    const versions=document.createElement('span');versions.className='frozen-change-versions';versions.textContent='输入版本 → 候选版本 · 只读';
    left.append(back, title);right.append(versions,navigation);head.append(left,right);
    const body = document.createElement('div'); body.className = 'document-diff-body';
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = '正在读取冻结版本…';
    body.append(status); overlay.append(head, body); back.focus({ preventScroll: true });
    let result;
    try { result = await invoke('managed.changes.read', { projectId, changeSetId, fileId }); }
    catch (error) { result = { ok: false, error: { message: error.message } }; }
    if (token !== generation || projectId !== currentProjectId()) return { ok: false, stale: true };
    if (!result.ok) { status.textContent = '冻结变更不可用：' + (result.error?.message || '读取失败'); return result; }
    const value = result.value;
    const presentation = frozenChangePresentation(value);
    title.textContent = presentation.path + ' · 冻结变更 · 只读'; title.title = title.textContent;
    versions.textContent = '输入版本 → 候选版本 · 只读' + (presentation.modeChange ? ' · 模式 ' + presentation.modeChange : '');
    if (!presentation.text) { status.textContent = presentation.reason; return result; }
    diff = mountDiff({ parent: body, leftPath: presentation.leftPath, rightPath: presentation.rightPath,
      leftText: presentation.before, rightText: presentation.after,
      onNavigate(index, total) {
        count.textContent = total ? index < 0 ? `${total} 处差异` : `${index + 1}/${total} 处差异` : presentation.modeChange ? '内容相同 · 模式 ' + presentation.modeChange : '内容相同';
        previous.disabled = next.disabled = !total;
      },
    });
    return result;
  }
  return { open, restore, get active() { return overlay !== null; } };
}

export function frozenChangePresentation(value) {
  const rightPath = value.file?.path || value.file?.oldPath || '冻结文件';
  const leftPath = value.file?.oldPath || rightPath;
  const path = leftPath === rightPath ? rightPath : leftPath + ' → ' + rightPath;
  const beforeMode = value.before?.mode ?? value.file?.before?.mode ?? null;
  const afterMode = value.after?.mode ?? value.file?.after?.mode ?? null;
  const modeChange = beforeMode !== afterMode ? `${beforeMode ?? '不存在'} → ${afterMode ?? '不存在'}` : null;
  const identity = {path,leftPath,rightPath,beforeMode,afterMode,modeChange};
  const reasons = {
    binary: '二进制文件，不能显示文本差异。',
    'special-file': '符号链接或 Git 子模块等特殊文件，不能显示文本差异。',
    'non-utf8': '文件不是 UTF-8 文本，不能显示文本差异。',
    'byte-budget': '冻结文件超过文本大小限制，未截断或加载正文。',
    'line-budget': '冻结文件超过文本行数限制，未截断或加载正文。',
  };
  if (value.availability !== 'available') return { ...identity, text: false, reason: (reasons[value.reason] || value.reason || '冻结版本不可用。') + ' 不会读取当前文件代替。' };
  if (![value.before, value.after].every(side => side === null || typeof side?.text === 'string')) {
    return { ...identity, text: false, reason: '冻结文本不完整，无法显示差异。不会读取当前文件代替。' };
  }
  return { ...identity, text: true, before: value.before === null ? '' : value.before.text, after: value.after === null ? '' : value.after.text };
}
