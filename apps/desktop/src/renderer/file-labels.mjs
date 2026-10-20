import { FILE_COLORS } from '../domain/file-label.mjs';

export function mountFileLabels({ invoke, projectId, refresh, toast }) {
  let labels = Object.create(null), labelProject = null, editing = null, busy = false;
  const dialog = document.createElement('dialog'); dialog.id = 'file-label-dialog'; dialog.setAttribute('aria-labelledby', 'file-label-title');
  dialog.innerHTML = '<form><h2 id="file-label-title">颜色标签与备注</h2><p class="file-label-path"></p><fieldset><legend>颜色标签（可多选）</legend><div class="file-label-palette"></div></fieldset><label class="file-label-note">文字备注<textarea id="file-label-note" maxlength="2000" rows="5" placeholder="例如：核心实现，优先阅读；待核对测试…"></textarea></label><p class="quiet">文件级备注，不修改正文。</p><p id="file-label-error" role="alert"></p><div class="file-label-buttons"><button type="button" id="file-label-clear">清空</button><button type="button" id="file-label-cancel">取消</button><button type="submit" id="file-label-save">保存</button></div></form>';
  document.body.append(dialog);
  const form = dialog.querySelector('form'), note = dialog.querySelector('textarea'), error = dialog.querySelector('#file-label-error');
  const inputs = FILE_COLORS.map(color => {
    const label = document.createElement('label'), input = document.createElement('input'), swatch = document.createElement('span');
    input.type = 'checkbox'; input.value = color.id; input.setAttribute('aria-label', color.name);
    swatch.className = 'file-color-dot'; swatch.style.backgroundColor = color.hex; swatch.setAttribute('aria-hidden', 'true');
    label.append(input, swatch, document.createTextNode(color.name)); dialog.querySelector('.file-label-palette').append(label); return input;
  });
  const setBusy = value => { busy = value; for (const control of form.querySelectorAll('button,input,textarea')) control.disabled = value; };
  dialog.querySelector('#file-label-cancel').onclick = () => dialog.close();
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  dialog.querySelector('#file-label-clear').onclick = () => { for (const input of inputs) input.checked = false; note.value = ''; note.focus(); };
  form.onsubmit = async event => {
    event.preventDefault(); if (!editing || busy) return;
    if (editing.projectId !== projectId()) { error.textContent = '项目已切换，请重新打开文件标记。'; return; }
    setBusy(true); error.textContent = '';
    try {
      const result = await invoke('tree.label', { ...editing, colors: inputs.filter(n => n.checked).map(n => n.value), note: note.value });
      if (!result.ok) { error.textContent = result.error.message; return; }
      dialog.close(); await refresh(); toast('文件标签与备注已保存');
    } catch (e) { error.textContent = e.message; }
    finally { setBusy(false); }
  };
  return {
    async load(id) {
      const result = await invoke('tree.labels', { projectId: id });
      if (id !== projectId()) return;
      labels = Object.assign(Object.create(null), result.ok ? result.value.labels : {}); labelProject = id;
      if (!result.ok) toast('文件标记未能加载：' + result.error.message);
      return result.ok;
    },
    async edit(ctx) {
      if (!await this.load(ctx.projectId)) return;
      if (ctx.projectId !== projectId()) return;
      const label = labels[ctx.relPath] || { colors: [], note: '', revision: 0 };
      editing = { projectId: ctx.projectId, relPath: ctx.relPath, expectedRevision: label.revision };
      dialog.querySelector('.file-label-path').textContent = ctx.relPath;
      for (const input of inputs) input.checked = label.colors.includes(input.value);
      note.value = label.note; error.textContent = ''; dialog.showModal(); note.focus();
    },
    decorate(button) {
      if (labelProject !== projectId()) return;
      const label = labels[button.dataset.path]; if (!label) return;
      const names = FILE_COLORS.filter(c => label.colors.includes(c.id)).map(c => c.name);
      const marks = document.createElement('span'); marks.className = 'file-label-marks'; marks.setAttribute('aria-hidden', 'true');
      for (const color of FILE_COLORS.filter(c => label.colors.includes(c.id))) {
        const dot = document.createElement('span'); dot.className = 'file-color-dot'; dot.dataset.color = color.id; dot.style.backgroundColor = color.hex; marks.append(dot);
      }
      if (label.note) { const icon = document.createElement('span'); icon.className = 'file-note-icon'; icon.textContent = '✎'; marks.append(icon); }
      button.append(marks);
      const description = [names.join('、'), label.note].filter(Boolean).join('\n');
      button.title = [button.dataset.path, description].filter(Boolean).join('\n');
      button.setAttribute('aria-label', [button.getAttribute('aria-label'), description].filter(Boolean).join('，'));
      button.dataset.searchText = `${button.dataset.path} ${names.join(' ')} ${label.note}`;
    },
  };
}
