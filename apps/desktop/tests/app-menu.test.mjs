import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildApplicationMenuTemplate, createMenuDispatcher } from '../src/main/app-menu.cjs';

function menuItem(template, label) {
  const walk = items => {
    for (const item of items) {
      if (item.label === label) return item;
      const nested = item.submenu ? walk(item.submenu) : null;
      if (nested) return nested;
    }
    return null;
  };
  const found = walk(template);
  assert.ok(found, `menu item ${label} must exist`);
  return found;
}
function flatItems(template) {
  const out = [];
  const walk = items => { for (const item of items) { out.push(item); if (item.submenu) walk(item.submenu); } };
  walk(template);
  return out;
}
function buildMenu(platform = 'darwin') {
  const actions = [];
  const template = buildApplicationMenuTemplate({ platform, menuAction: action => actions.push(action), textEdit: () => {} });
  return { template, actions };
}

test('关闭窗口 is the native close role with Shift+W: key-window targeting and auto-disable, guards intact', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { template } = buildMenu(platform);
    const close = menuItem(template, '关闭窗口');
    assert.equal(close.role, 'close', `${platform}: the native role acts on the focused window, never a captured one`);
    assert.equal(close.accelerator, 'CmdOrCtrl+Shift+W', `${platform}: only the shift-modified combo closes a native window`);
    assert.equal('click' in close, false, `${platform}: no custom click can bypass or no-op the role`);
  }
});

test('plain Cmd/Ctrl+W and Cmd/Ctrl+S stay with the renderer', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { template } = buildMenu(platform);
    for (const item of flatItems(template)) {
      assert.notEqual(item.accelerator, 'CmdOrCtrl+W', `${platform}: Cmd+W belongs to the renderer tab close`);
      assert.notEqual(item.accelerator, 'CmdOrCtrl+S', `${platform}: the renderer owns the save shortcut; a menu accelerator would duplicate the flush`);
    }
  }
});

test('macOS keeps the application menu (Cmd+Q/Hide/Services); other platforms omit it', () => {
  const { template: mac } = buildMenu('darwin');
  assert.equal(mac[0].role, 'appMenu');
  for (const platform of ['linux', 'win32']) {
    const { template } = buildMenu(platform);
    assert.equal(flatItems(template).some(item => item.role === 'appMenu'), false, `${platform} must not carry an app menu`);
  }
});

test('window roles carry no captured window clicks and 打开项目… routes through the live dispatcher', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const { template, actions } = buildMenu(platform);
    for (const role of ['close', 'minimize', 'zoom', 'togglefullscreen', 'undo', 'redo', 'paste', 'selectAll']) {
      const item = flatItems(template).find(entry => entry.role === role);
      assert.ok(item, `${platform}: role ${role} present`);
      assert.equal('click' in item, false, `${platform}: role ${role} carries no captured window click`);
    }
    menuItem(template, '打开项目…').click();
    assert.deepEqual(actions, ['open-project']);
  }
});

class Contents extends EventEmitter { constructor(){super();this.sent=[];this.destroyed=false;} send(channel,payload){this.sent.push({channel,payload});} isDestroyed(){return this.destroyed;} }
test('menu actions reach the live shell; a windowless resident app reopens it first', async () => {
  const live = new Contents(), stale = new Contents(); stale.destroyed = true;
  const state = { records: [{ windowId: 'main', dead: false, wc: live }] };
  const ensureShellCalls = [];
  const dispatch = createMenuDispatcher({
    shellOf: () => state.records[0],
    ensureShell: () => { ensureShellCalls.push(1); state.records[0] = { windowId: 'main', dead: false, wc: new Contents() }; return state.records[0]; },
  });
  dispatch('open-project');
  assert.deepEqual(live.sent.map(row => row.payload), ['open-project'], 'live shell receives the action');
  state.records[0] = { windowId: 'main', dead: true, wc: stale };
  dispatch('focus');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ensureShellCalls.length, 1, 'a dead shell triggers the Dock-activate recreation path');
  assert.deepEqual(state.records[0].wc.sent.map(row => row.payload), ['focus'], 'the recreated shell receives the deferred action');
  assert.deepEqual(stale.sent, [], 'the destroyed window is never touched');
});
