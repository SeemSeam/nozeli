import {isTerminalProtocolInput} from '../domain/terminal-input.mjs';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// xterm creates its own trusted style elements. Scope the page nonce to
// this component's document access; do not relax CSP or patch global DOM APIs.
function terminalDocument(container) {
  const doc = container.ownerDocument;
  const nonce = doc?.querySelector('meta[name="nozeli-style-nonce"]')?.content;
  if (!nonce) return doc;
  return new Proxy(doc, {
    get(target, key) {
      if (key === 'createElement') return (name, options) => {
        const element = target.createElement(name, options);
        if (String(name).toLowerCase() === 'style') element.nonce = nonce;
        return element;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createProviderTerminal({ container, invoke, subscribe, toast = () => {}, onState = () => {} }) {
  container.classList?.add('provider-terminal');
  const terminal = new Terminal({ documentOverride: terminalDocument(container), cursorBlink: true, scrollback: 5000, disableStdin: false, fontSize: 14, fontFamily: 'monospace', theme: { background: '#101512', foreground: '#e5ece7', cursor: '#a5dab9' } });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container);
  const loading = container.ownerDocument?.createElement('div');
  if (loading) { loading.className = 'terminal-loading'; loading.setAttribute('role','status'); loading.hidden=true; container.append(loading); }
  function setLoading(text) { if (loading) { loading.textContent=text || ''; loading.hidden=!text; } container.setAttribute?.('aria-busy',String(Boolean(text))); }
  let projectId = null; let role = null; let terminalId = null; let pendingLease = null; let visible = true; let generation = 0; let disposed = false; let lastSeq = 0;
  const setState=value=>{container.dataset.terminalState=value;onState(value);};
  let unsubscribe = () => {}; let pendingOutput = []; let writeChain = Promise.resolve();
  const current = (mine) => !disposed && mine === generation;
  const stale = () => ({ available: false, stale: true, reason: '过期的终端附着响应。' });
  const invalidate = (mine,id,error) => {
    if(!current(mine)||(terminalId||pendingLease)!==id)return;
    if(error?.code!=='TERMINAL_STALE')return;
    generation++;terminalId=null;pendingLease=null;pendingOutput=[];unsubscribe();unsubscribe=()=>{};
    setLoading(null);setState('stale');
  };
  const schedule = (operation) => {
    const next = writeChain.then(operation);
    writeChain = next.catch(() => {});
    return next;
  };
  const writeText = (text) => new Promise((resolve, reject) => {
    if (!text) { resolve(); return; }
    try { terminal.write(text, resolve); } catch (error) { reject(error); }
  });
  const writeEvent = async (event, mine) => {
    if (!current(mine) || event.terminalId !== terminalId) return;
    if (event.type !== 'terminal.exit' && event.seq != null && event.seq <= lastSeq) {
      // Replay has already reached the parser, but the host can still be
      // waiting for ACKs for queued chunks covered by that replay snapshot.
      if (event.type === 'terminal.output') await invoke('terminal.ack', { terminalId: event.terminalId, seq: event.seq });
      return;
    }
    if (event.seq != null) lastSeq = Math.max(lastSeq, event.seq);
    if (event.type === 'terminal.output' && typeof event.data === 'string') { await writeText(event.data); if (current(mine) && terminalId === event.terminalId) { if(event.data) setLoading(null); await invoke('terminal.ack', { terminalId: event.terminalId, seq: event.seq }); } }
    if (event.type === 'terminal.exit') {
      setState('exited');
      setLoading(null);
      await writeText('\r\n[终端已退出 ' + (event.exitCode ?? '') + ']\r\n');
    }
  };
  const enqueueEvent = (event, mine) => { void schedule(() => writeEvent(event, mine)).catch(() => {}); };
  const onEvent = (event, mine) => {
    if (!current(mine) || event?.projectId !== projectId || event?.role !== role) return;
    if (!terminalId) {
      if(container.dataset.terminalState==='connecting'&&event.terminalId){pendingLease=event.terminalId;if(event.type==='terminal.output')void schedule(()=>current(mine)?writeText(event.data):undefined).catch(()=>{});}
      if ((event.type === 'terminal.output' || event.type === 'terminal.exit') && pendingOutput.length < 256) pendingOutput.push(event);
      return;
    }
    if (event.terminalId === terminalId) enqueueEvent(event, mine);
  };
  terminal.onData((data) => { const id=terminalId||pendingLease,mine=generation;const protocol=isTerminalProtocolInput(data);if(!disposed&&id&&(container.dataset.terminalState==='attached'||(container.dataset.terminalState==='connecting'&&protocol)))void invoke('terminal.input',{terminalId:id,data}).then(r=>{if(!current(mine))return;if(r?.ok===false){invalidate(mine,id,r.error);toast(r.error?.message||'终端输入未送达，请检查连接。');}}).catch(error=>{if(current(mine)){invalidate(mine,id,error);toast('终端输入未送达，请检查连接。');}}); });
  let resizeChain = Promise.resolve();
  const resizeToFit = () => {
    if (!visible || disposed || !container.clientWidth || !container.clientHeight) return Promise.resolve();
    fit.fit();
    if (!terminalId) return Promise.resolve();
    const id=terminalId,mine=generation,cols=terminal.cols,rows=terminal.rows;
    // Layout/显隐/字体变化可能同批触发；串行转发，旧代次不得把旧尺寸写入新会话。
    const request=resizeChain.then(()=>current(mine)&&terminalId===id?invoke('terminal.resize',{terminalId:id,cols,rows}).then(r=>{if(r?.ok===false)invalidate(mine,id,r.error);}):undefined);
    resizeChain=request.catch(error=>{invalidate(mine,id,error);});
    return request;
  };
  const resizeObserver = new ResizeObserver(() => {
    if (!visible || disposed) return;
    void resizeToFit().catch(()=>{});
  });
  resizeObserver.observe(container);

  return {
    async attach(next) {
      if (disposed) return stale();
      const mine = ++generation;
      projectId = next?.projectId || null; role = next?.role || null; terminalId = null; pendingLease=null; lastSeq = 0; pendingOutput = [];
      // Reset behind in-progress parser writes. Never abandon the old queue:
      // its obsolete events must be skipped before the next view is rendered.
      void schedule(() => { if (current(mine)) terminal.reset(); }).catch(() => {});
      setState('connecting'); unsubscribe();
      setLoading('正在启动当前项目的 CLI…');
      unsubscribe = subscribe('terminal', (event) => onEvent(event, mine));
      if (visible) fit.fit();
      let result;
      try { result = await invoke('terminal.attach', { projectId, role, cols: terminal.cols, rows: terminal.rows }); }
      catch(error) { result={ok:false,error:{message:error?.message || '终端连接失败'}}; }
      if (!current(mine)) {if(result?.ok&&result.value?.terminalId)await invoke('terminal.detach',{terminalId:result.value.terminalId});return stale();}
      if(result?.ok&&result.value?.available)pendingLease=result.value.terminalId;
      return schedule(async () => {
        if (!current(mine)) return stale();
        if (!result?.ok || result.value?.available !== true) {
          const reason = (result?.value?.reason || result?.error?.message || '当前 provider 未提供真实附着能力。') + (next?.unavailableHint ? '\r\n' + next.unavailableHint : '');
          setState('unavailable');
          setLoading(null);
          await writeText('\r\n[原生终端不可用] ' + String(reason) + '\r\n');
          return current(mine) ? { available: false, reason } : stale();
        }
        terminal.reset();
        if (Array.isArray(result.value.replayFrames)) {
          for (const frame of result.value.replayFrames) {
            if (!current(mine)) return stale();
            if (Number.isInteger(frame.cols)&&Number.isInteger(frame.rows)&&frame.cols>0&&frame.rows>0) terminal.resize(frame.cols,frame.rows);
            await writeText(frame.data);
          }
        } else if (typeof result.value.replay === 'string') await writeText(result.value.replay);
        // A different project may have attached while the parser was busy.
        if (!current(mine)) return stale();
        terminalId = result.value.terminalId; pendingLease=null; setState('attached');
        setLoading(result.value.replay ? null : '终端已连接，等待 CLI 输出…');
        if (result.value.seq != null) lastSeq = result.value.seq;
        if (Number.isInteger(result.value.lastSentSeq)) await invoke('terminal.ack', { terminalId, seq: result.value.lastSentSeq });
        const buffered = pendingOutput.splice(0);
        for (const event of buffered) {
          if (!current(mine)) return stale();
          await writeEvent(event, mine);
        }
        if (!current(mine)) return stale();
        if(container.dataset.terminalState==='exited')return {available:false,reason:'终端已退出，请重新连接'};
        if (visible) await resizeToFit();
        return { available: true, terminalId };
      });
    },
    setVisible(next) {
      if (disposed) return;
      visible = Boolean(next); container.hidden = !visible; container.inert = !visible;
      // Hidden views must still answer terminal protocol queries. Block browser
      // focus/input via inert and blur, rather than dropping every onData event.
      if (!visible) terminal.blur();
      if (visible) void resizeToFit().catch(()=>{});
    },
    focus() { if (visible && !disposed) terminal.focus(); },
    dispose() {
      if (disposed) return;
      disposed = true; generation += 1; unsubscribe(); unsubscribe = () => {}; resizeObserver.disconnect();
      setLoading(null); loading?.remove();
      if (terminalId||pendingLease) void invoke('terminal.detach', { terminalId:terminalId||pendingLease });
      pendingLease=null;
      terminalId = null; pendingOutput = [];
      // Disposing while a parser callback is pending would strand the queue.
      void schedule(() => terminal.dispose()).catch(() => {});
    },
  };
}
