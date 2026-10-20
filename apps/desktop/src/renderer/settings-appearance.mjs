import { setIconButton } from './ui-icons.mjs';

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
function applyAppearance() {
  const root = document.documentElement;
  root.dataset.appearanceTheme = preferences.theme;
  root.dataset.theme = preferences.theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preferences.theme;
  root.style.setProperty('--chrome-font-family', FONT_STACKS[preferences.font]);
  root.style.setProperty('--chrome-font-size', preferences.size + 'px');
  // Do not change root/body typography: rem-based document and conversation sizes stay intact.
}
applyAppearance();
systemTheme.addEventListener('change', applyAppearance);
window.addEventListener('storage', event => {
  if (event.key === STORAGE_KEY || event.key === null) {
    preferences = readPreferences();
    applyAppearance();
    document.dispatchEvent(new Event('appearance:change'));
  }
});

export function mountAppearanceSettings({ container, zen } = {}) {
  if (!container) throw new TypeError('外观设置需要容器');
  container.classList.add('settings-appearance');
  container.innerHTML = `
    <h2>外观</h2>
    <label class="appearance-field"><span>主题</span><select data-appearance="theme" aria-label="界面主题"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
    <label class="appearance-field"><span>界面字体</span><select data-appearance="font" aria-label="界面字体"><option value="system">系统字体</option><option value="sans">无衬线</option><option value="serif">衬线</option><option value="mono">等宽</option></select></label>
    <label class="appearance-field"><span>界面字号</span><select data-appearance="size" aria-label="界面字号">${Array.from({ length: 9 }, (_, i) => `<option value="${i + 12}">${i + 12} px</option>`).join('')}</select></label>
    <p class="appearance-help">字体与字号仅应用于应用界面（文件栏、工作与待办、设置和弹窗），不改变工作区、正文、编辑器、对话、输入、标签或终端的字体与字号。</p>
    <p class="appearance-save-status" role="status" aria-live="polite"></p>
    <section class="appearance-zen" aria-label="Zen 专注模式"><h3>Zen 专注模式</h3><p class="appearance-help">隐藏项目、文件和工作侧栏，专注当前阅读面。未打开项目时也可使用；不会创建项目。全屏不可用时仍铺满窗口。</p><button type="button" class="appearance-zen-button"></button><p class="appearance-help">切换：<kbd>Ctrl/Cmd+Shift+F11</kbd> · 退出：<kbd>Esc</kbd>。弹窗中的 Esc 优先关闭弹窗。</p></section>`;
  const status = container.querySelector('.appearance-save-status');
  const button = container.querySelector('.appearance-zen-button');
  function refresh() {
    for (const select of container.querySelectorAll('[data-appearance]')) select.value = String(preferences[select.dataset.appearance]);
    const enabled = document.getElementById('app')?.classList.contains('focus-mode') || false;
    setIconButton(button, enabled ? 'minimize' : 'maximize', { text: enabled ? '退出 Zen 专注模式' : '进入 Zen 专注模式' });
    button.setAttribute('aria-pressed', String(enabled));
    button.title = '切换 Zen 专注模式 (Ctrl/Cmd+Shift+F11)，Esc 退出';
  }
  container.addEventListener('change', async event => {
    const key = event.target.dataset.appearance;
    if (!['theme', 'font', 'size'].includes(key)) return;
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
  button.addEventListener('click', () => {
    if (typeof zen === 'function') zen();
    else container.dispatchEvent(new CustomEvent('settings:enter-zen', { bubbles: true }));
  });
  document.addEventListener('zen:change', refresh);
  document.addEventListener('appearance:change', refresh);
  refresh();
  void appearanceReady.then(refresh);
  return { refresh };
}
