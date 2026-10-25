
const STORAGE_KEY = 'nozeli.appearance';
const FONT_STACKS = Object.freeze({
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  sans: 'Arial, "Helvetica Neue", "Noto Sans", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Noto Serif", "Noto Serif CJK SC", "Songti SC", SimSun, serif',
  mono: 'ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", monospace',
});
export function normalizeAppearance(value) {
  return {
    theme: ['light', 'dark', 'system'].includes(value?.theme) ? value.theme : 'system',
    palette: ['sage', 'slate'].includes(value?.palette) ? value.palette : 'sage',
    font: Object.hasOwn(FONT_STACKS, value?.font) ? value.font : 'system',
    size: Number.isInteger(value?.size) && value.size >= 12 && value.size <= 20 ? value.size : 13,
  };
}
function readPreferences() {
  try { return normalizeAppearance(JSON.parse(localStorage.getItem(STORAGE_KEY))); }
  catch { return normalizeAppearance(null); }
}
let preferences = readPreferences();
let saveQueue=Promise.resolve();
const appearanceReady=window.nozeli.invoke('settings.appearance.read',{}).then(result=>{
  if(!result.ok)throw new Error(result.error.message);
  if(result.value)preferences=normalizeAppearance(result.value);
  applyAppearance();
}).catch(error=>{console.error('Appearance preferences unavailable',error);});
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let lastApplied = '';
function applyAppearance() {
  const root = document.documentElement;
  root.dataset.appearanceTheme = preferences.theme;
  root.dataset.palette = preferences.palette;
  root.dataset.theme = preferences.theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preferences.theme;
  root.style.setProperty('--chrome-font-family', FONT_STACKS[preferences.font]);
  root.style.setProperty('--chrome-font-size', preferences.size + 'px');
  // Do not change root/body typography: rem-based document and conversation sizes stay intact.
  // One notification for each distinct preference/effective-theme state. This
  // includes font/size and system-to-explicit changes, not only visible colors.
  const state = JSON.stringify({...preferences, effectiveTheme:root.dataset.theme});
  if (state !== lastApplied) {
    lastApplied = state;
    document.dispatchEvent(new CustomEvent('appearance:change',{detail:{...preferences,effectiveTheme:root.dataset.theme}}));
  }
}
applyAppearance();
systemTheme.addEventListener('change', applyAppearance);
window.addEventListener('storage', event => {
  if (event.key === STORAGE_KEY || event.key === null) {
    preferences = readPreferences();
    applyAppearance();
  }
});
window.nozeli.subscribe('workspace.control', event => {
  if (event.type !== 'appearance') return;
  preferences = normalizeAppearance(event.value);
  applyAppearance();
});

export function mountAppearanceSettings({ container } = {}) {
  if (!container) throw new TypeError('外观设置需要容器');
  container.classList.add('settings-appearance');
  container.innerHTML = `
    <h2>外观</h2>
    <label class="appearance-field"><span>主题</span><select data-appearance="theme" aria-label="界面主题"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
    <label class="appearance-field"><span>配色</span><select data-appearance="palette" aria-label="界面配色"><option value="sage">草木（默认）</option><option value="slate">岩蓝</option></select></label>
    <label class="appearance-field"><span>界面字体</span><select data-appearance="font" aria-label="界面字体"><option value="system">系统字体</option><option value="sans">无衬线</option><option value="serif">衬线</option><option value="mono">等宽</option></select></label>
    <label class="appearance-field"><span>界面字号</span><select data-appearance="size" aria-label="界面字号">${Array.from({ length: 9 }, (_, i) => `<option value="${i + 12}">${i + 12} px</option>`).join('')}</select></label>
    <p class="appearance-help">字体与字号仅应用于应用界面（文件栏、工作与待办、设置和弹窗），不改变工作区、正文、编辑器、对话、输入、标签或终端的字体与字号。</p>
    <p class="appearance-help">配色与浅色、深色或跟随系统独立选择；不改变文档原件、PDF、扫描件、终端画面或用户网页的颜色。编辑器与报告正文的阅读底色跟随主题。</p>
    <p class="appearance-save-status" role="status" aria-live="polite"></p>`;
  const status = container.querySelector('.appearance-save-status');
  function refresh() {
    for (const select of container.querySelectorAll('[data-appearance]')) select.value = String(preferences[select.dataset.appearance]);
  }
  container.addEventListener('change', async event => {
    const key = event.target.dataset.appearance;
    if (!['theme', 'palette', 'font', 'size'].includes(key)) return;
    await appearanceReady;
    preferences = normalizeAppearance({ ...preferences, [key]: key === 'size' ? Number(event.target.value) : event.target.value });
    applyAppearance();
    try {
      const captured={...preferences};
      saveQueue=saveQueue.catch(()=>{}).then(async()=>{const result=await window.nozeli.invoke('settings.appearance.save',captured);if(!result.ok)throw new Error(result.error.message);});
      await saveQueue;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(captured));
      status.textContent = '已保存，重启后继续使用。';
    } catch { status.textContent = '已应用，但本地存储不可用；重启后可能无法保留。'; }
    refresh();
  });
  document.addEventListener('appearance:change', refresh);
  refresh();
  void appearanceReady.then(refresh);
  return { refresh };
}
