export function mountConfiguration({document, invoke, onInitialized = () => {}, onError = () => {}, autoOpen = true}) {
  const $ = id => document.getElementById(id);
  const dialog = $('configuration-setup');
  let initialized = false, busy = false;
  const status = text => { $('configuration-status').textContent = text; };
  function open() { if (!initialized && !dialog.open) dialog.showModal(); }
  async function choose(mode) {
    if (busy || initialized) return;
    busy = true;
    for (const id of ['configuration-independent', 'configuration-import', 'configuration-cancel']) $(id).disabled = true;
    status('正在建立 Nozeli 独立配置…');
    try {
      const result = await invoke('config.initialize', {mode, includeApiKeys: mode === 'import' && $('configuration-api-keys').checked});
      if (!result.ok) throw Error(result.error.message);
      initialized = result.value.initialized === true;
      if (!initialized) throw Error('配置初始化尚未完成。');
      dialog.close();
      await onInitialized();
    } catch (error) { status(error.message); onError(error); }
    finally {
      busy = false;
      for (const id of ['configuration-independent', 'configuration-import', 'configuration-cancel']) $(id).disabled = false;
    }
  }
  $('configuration-independent').onclick = () => choose('independent');
  $('configuration-import').onclick = () => choose('import');
  $('configuration-cancel').onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  const ready = invoke('config.status', {}).then(result => {
    if (!result.ok) throw Error(result.error.message);
    initialized = result.value.initialized === true;
    if (!initialized && autoOpen) open();
    return initialized;
  }).catch(error => { status(error.message); if(autoOpen)open(); onError(error); return false; });
  return {ready, open, get initialized() { return initialized; }};
}
