
const $ = id => document.getElementById(id);
export function versionCaption(version) {
  if(version.kind==='baseline')return '输入基线（冻结）';
  if(version.kind==='candidate')return 'Worker 发布候选（冻结）';
  if(version.kind==='draft')return `人工草稿 v${version.revision} · 用户${version.at?' · '+new Date(version.at).toLocaleString('zh-CN'):''}`;
  if (!version.revision) return 'v0 · 开始记录时的版本';
  const time = new Date(version.time).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return `v${version.revision} · ${version.actor.name} · ${time}${version.actor.kind === 'external' ? '（检测时间）' : ''}`;
}

export function mountDocumentComparison({ current, invoke, openSnapshot, toast }) {
  const dialog = $('beside-dialog');
  let source = 'file', token = 0, context = null, cursor = null, versions = new Map(), busy = false;
  const identity = file => file ? file.documentKey || JSON.stringify([file.projectId,file.documentSource||{type:'project'},file.relPath||'']) : null;
  const versionKey = version => version.kind ? `${version.kind}:${version.revision??''}` : String(version.revision);
  const reviewContext = () => context?.documentSource && context.documentSource.type!=='project';
  const versionRef=version=>version?.kind?{kind:version.kind,...(version.kind==='draft'?{revision:version.revision}:{})}:version;
  const active = request => request === token && identity(current()) === identity(context) && dialog.open;
  function controls() {
    $('beside-source-file').setAttribute('aria-pressed', String(source === 'file'));
    $('beside-source-history').setAttribute('aria-pressed', String(source === 'history'));
    $('beside-files').hidden = source !== 'file'; $('beside-history').hidden = source !== 'history';
    $('beside-source-file').disabled=Boolean(reviewContext());
    $('beside-source-file').title=reviewContext()?'审核候选仅比较冻结材料；项目原件请从项目导航单独打开':'比较其他项目文件';
    $('beside-source-history').disabled = context?.kind !== 'text';
    $('beside-source-history').title = context?.kind === 'text' ? '比较当前文件的历史正文' : '历史对比仅支持文本文件';
    const chosen = source === 'history' ? versions.has($('beside-version').value) : Boolean($('beside-file').value);
    $('beside-open').disabled = busy || !chosen || source==='history'&&versions.get($('beside-version').value)?.kind==='baseline-candidate';
    $('beside-diff').disabled = busy || !chosen || context?.kind !== 'text' || source === 'file' && /\.(pdf|docx?|pptx?|xlsx?|png|jpe?g|gif|webp|svg|bmp|tiff?)$/i.test($('beside-file').value);
    $('beside-diff').title = $('beside-diff').disabled ? '差异比较需要两侧均为文本' : '只读比较当前内容与所选版本';
  }
  async function pageHistory(request, append = false) {
    if (!append) { cursor = null; versions.clear(); $('beside-version').replaceChildren(); $('beside-more').hidden = true; }
    busy = true; controls(); $('beside-status').textContent = '正在读取版本…';
    const result = await invoke('document.versions', { projectId: context.projectId, relPath: context.relPath, documentSource:context.documentSource, cursor: append ? cursor : null, limit: 50 });
    if (!active(request)) return;
    busy = false;
    if (!result.ok) { $('beside-status').textContent = result.error.message; controls(); return; }
    const selected = $('beside-version').value;
    for (const version of result.value.versions) {
      const key=versionKey(version);versions.set(key, version);
      const option = document.createElement('option'); option.value = key; option.textContent = versionCaption(version)+(reviewContext()?' ↔ 当前内容':''); $('beside-version').append(option);
    }
    if (append) $('beside-version').value = selected;
    else if(reviewContext()){
      const pair={kind:'baseline-candidate'};versions.set('baseline-candidate:',pair);
      const option=document.createElement('option');option.value='baseline-candidate:';option.textContent='输入基线 ↔ Worker 冻结候选（不含人工稿）';$('beside-version').append(option);
      $('beside-version').value=versions.has('candidate:')?'candidate:':'baseline-candidate:';
    }else $('beside-version').value = String(context.dirty ? result.value.head.revision : Math.max(0, result.value.head.revision - 1));
    cursor = reviewContext()?result.value.cursor:result.value.nextCursor; $('beside-more').hidden = !cursor;
    $('beside-status').textContent = `${context.relPath} · ${reviewContext()?versions.size-1:result.value.total}个已记录版本`;
    controls();
  }
  async function choose(kind) {
    if(kind==='file'&&reviewContext())kind='history';
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
  async function open(kind) {
    context = current(); if (!context) return toast('请先打开项目。');
    kind??=reviewContext()?'history':'file';
    if (kind === 'history' && context.kind !== 'text') return toast('请先打开文本文件。');
    dialog.showModal(); await choose(kind);
  }
  async function compareVersion(version) {
    const file = current(); if (file?.kind !== 'text') return;
    const result = await invoke('document.version', { projectId: file.projectId, relPath: file.relPath, documentSource:file.documentSource, version:versionRef(version) });
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
    const selected = versions.get($('beside-version').value), relPath = $('beside-file').value;
    busy = true; controls(); $('beside-status').textContent = '正在准备对比…';
    let result,left;
    if(historical&&selected?.kind==='baseline-candidate'){
      const payload={projectId:file.projectId,relPath:file.relPath,documentSource:file.documentSource};
      const [baseline,candidate]=await Promise.all([invoke('document.version',{...payload,version:{kind:'baseline'}}),invoke('document.version',{...payload,version:{kind:'candidate'}})]);
      result=!baseline.ok?baseline:candidate;left=baseline.ok?baseline.value:null;
    }else result = await invoke(historical ? 'document.version' : 'file.read', { projectId: file.projectId, relPath: historical ? file.relPath : relPath, documentSource:historical?file.documentSource:{type:'project'}, ...(historical ? { version: versionRef(selected) } : {}) });
    if (!active(request)) return;
    busy = false;
    if (!result.ok) { $('beside-status').textContent = result.error.message; controls(); return; }
    const snapshot=result.value;
    if (diff && (snapshot.kind !== 'text'||left&&left.kind!=='text')) { $('beside-status').textContent = '此文件不能作为文本差异比较，请使用普通对照。'; controls(); return; }
    dialog.close(); await openSnapshot(snapshot, diff, file, left);
  });
  return { open, compareVersion, close() { token++; if (dialog.open) dialog.close(); } };
}
