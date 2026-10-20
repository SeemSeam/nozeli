import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export const MAX_RELAY_FRAME = 2 * 1024 * 1024;
const MAX_BUFFERED = 8 * MAX_RELAY_FRAME;
/** One capability-scoped room; no filesystem endpoints, external listeners or business state. */
export async function startLocalRelay() {
  const capability = randomBytes(32).toString('hex');
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_FRAME, perMessageDeflate: false });
  let host = null, room = null, nextPeer = 1, generation = 0, closed = false;
  const guests = new Map();
  const send = (ws, data, binary = false) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED) { ws.close(4029, 'backpressure'); return; }
    ws.send(data, { binary }, error => { if (error) ws.terminate(); });
  };
  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { socket.destroy(); return; }
    const parts = url.pathname.split('/');
    const candidate = Buffer.from(url.searchParams.get('cap') ?? '');
    if (url.username || url.password || url.hash) { socket.destroy(); return; }
    if (closed || candidate.length !== capability.length || !timingSafeEqual(candidate, Buffer.from(capability)) || parts[1] !== 'r' || !/^[A-Za-z0-9_-]{8,128}$/.test(parts[2] ?? '') || parts.length !== 3 || !['host', 'guest'].includes(url.searchParams.get('role'))) { socket.destroy(); return; }
    const role = url.searchParams.get('role'), name = parts[2];
    sockets.handleUpgrade(request, socket, head, ws => {
      if (role === 'host') {
        if (host) { ws.close(4009); return; }
        host = ws; room = name; generation++; nextPeer = 1;
      } else if (!host || name !== room) { ws.close(4004); return; }
      else if (guests.size >= 4) { ws.close(4029); return; }
      const ownGeneration = generation, peer = role === 'guest' ? nextPeer++ : 0;
      if (peer) { guests.set(peer, ws); send(host, JSON.stringify({ t: 'peer-joined', peer })); }
      ws.on('message', (data, binary) => {
        if (!binary || data.length < 32 || generation !== ownGeneration) { ws.close(1008); return; }
        const target = data.readUInt32BE(0);
        if (peer) {
          if (target !== 0 || guests.get(peer) !== ws) { ws.close(1008); return; }
          const envelope = Buffer.from(data); envelope.writeUInt32BE(peer, 0); send(host, envelope, true);
        } else if (host === ws) {
          const envelope = Buffer.from(data); envelope.writeUInt32BE(0, 0);
          if (target === 0) for (const guest of guests.values()) send(guest, envelope, true);
          else if (guests.has(target)) send(guests.get(target), envelope, true);
        }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        if (generation !== ownGeneration) return;
        if (peer) { if (guests.delete(peer) && host) send(host, JSON.stringify({ t: 'peer-left', peer })); }
        else if (host === ws) { host = null; room = null; generation++; for (const guest of guests.values()) guest.close(4001); guests.clear(); }
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `ws://127.0.0.1:${server.address().port}`, capability,
    async close() { closed = true; for (const ws of sockets.clients) ws.terminate(); await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve)); },
  };
}
