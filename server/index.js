import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import { randomBytes, randomUUID, randomInt } from 'node:crypto';
import { Accounts } from './auth.js';
import { Game } from './game.js';

export async function createApp({ dataDir = fileURLToPath(new URL('../.data/', import.meta.url)), debug = true } = {}) {
  const accounts = new Accounts(dataDir); await accounts.load();
  const sessions = new Map(), streams = new Map(), rooms = new Map(), chats = [], limits = new Map();
  const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
  const roomFor = id => [...rooms.values()].find(r => r.players.some(p => p.id === id));
  const online = id => (streams.get(id)?.size ?? 0) > 0;
  const identity = user => ({ id: user.id, nickname: user.nickname });
  const roomView = room => ({
    id: room.id, name: room.name, host: room.host, settings: room.settings,
    players: room.players.map(p => ({ ...p, online: p.bot || online(p.id) })), messages: room.messages,
    game: room.game?.snapshot() ?? null,
  });
  const snapshot = user => ({
    me: accounts.public(user), debug, serverTime: Date.now(),
    ranking: accounts.users.filter(u => u.played).map(u => accounts.public(u)).sort((a, b) => b.wins - a.wins || b.wins / b.played - a.wins / a.played || b.played - a.played),
    online: accounts.users.filter(u => online(u.id)).map(u => ({ ...identity(u), status: ['spinning', 'announcing', 'playing'].includes(roomFor(u.id)?.game?.phase) ? '게임중' : '대기중' })),
    rooms: [...rooms.values()].map(r => ({ id: r.id, name: r.name, count: r.players.length, settings: r.settings, phase: r.game?.phase ?? 'waiting' })),
    messages: chats, room: roomFor(user.id) ? roomView(roomFor(user.id)) : null,
  });
  function broadcast() {
    for (const [id, responses] of streams) {
      const user = accounts.users.find(u => u.id === id);
      if (!user) continue;
      const data = `data: ${JSON.stringify(snapshot(user))}\n\n`;
      for (const res of responses) res.write(data);
    }
  }
  function rate(key, max, ms) {
    const now = Date.now(); let entry = limits.get(key);
    if (!entry || now > entry.until) { entry = { count: 0, until: now + ms }; limits.set(key, entry); }
    if (++entry.count > max) throw new Error('입력이 너무 빨라요. 잠시 후 다시 시도해주세요.');
  }
  function maybeStart(room) {
    if (room.game && room.game.phase !== 'finished') return;
    if (room.players.length >= 2 && room.players.every(p => p.ready && (p.bot || online(p.id)))) {
      room.game = new Game(room.players, room.settings); room.recorded = false;
      room.botAt = Date.now() + 5000; broadcast();
    }
  }
  function leave(user) {
    const room = roomFor(user.id); if (!room) return;
    if (room.game && room.game.phase !== 'finished') {
      room.messages.push({ id: randomUUID(), nickname: '안내', text: `${user.nickname}님이 나가 경기를 취소했어요.`, at: Date.now(), system: true });
    }
    room.game = null;
    room.players = room.players.filter(p => p.id !== user.id);
    room.players.forEach(p => p.ready = !!p.bot);
    if (!room.players.some(p => !p.bot)) rooms.delete(room.id);
    else if (room.host === user.id) room.host = room.players.find(p => !p.bot).id;
  }
  function record(room) {
    if (room.recorded || room.game?.phase !== 'finished') return;
    room.recorded = true;
    // Debug games never alter persistent rankings, including games with only humans.
    if (debug || room.players.some(p => p.bot) || room.game.draw) return;
    for (const result of room.game.results) {
      const user = accounts.users.find(u => u.id === result.id);
      if (user) { user.played++; if (result.winner) user.wins++; }
    }
    accounts.save().catch(console.error);
  }
  async function body(req) {
    let result = ''; for await (const chunk of req) {
      result += chunk; if (Buffer.byteLength(result) > 8192) throw new Error('요청이 너무 커요.');
    }
    try { return JSON.parse(result || '{}'); } catch { throw new Error('올바르지 않은 요청이에요.'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = /(?:^|; )hg_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const session = sessions.get(token);
      const user = session && session.expires > Date.now() ? accounts.users.find(u => u.id === session.id) : null;
      if (req.method === 'POST') {
        if (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin)) return json(403, { error: '허용되지 않은 출처예요.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON 요청만 허용해요.' });
      }
      if (req.method === 'POST' && ['/api/register', '/api/login'].includes(url.pathname)) {
        rate(`auth:${req.socket.remoteAddress}`, 30, 60000);
        const data = await body(req);
        const account = url.pathname.endsWith('register') ? await accounts.register(data.nickname?.trim(), data.password) : await accounts.login(data.nickname?.trim(), data.password);
        if (token) sessions.delete(token);
        const sid = randomBytes(32).toString('hex');
        sessions.set(sid, { id: account.id, expires: Date.now() + 86400000 });
        res.setHeader('Set-Cookie', `hg_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${req.socket.encrypted ? '; Secure' : ''}`);
        return json(200, snapshot(account));
      }
      if (url.pathname.startsWith('/api/')) {
        if (!user) return json(401, { error: '로그인 후 이용해주세요.' });
        if (url.pathname === '/api/state' && req.method === 'GET') return json(200, snapshot(user));
        if (url.pathname === '/api/events' && req.method === 'GET') {
          if ((streams.get(user.id)?.size ?? 0) >= 8) return json(429, { error: '열린 탭이 너무 많아요.' });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          if (!streams.has(user.id)) streams.set(user.id, new Set());
          streams.get(user.id).add(res); broadcast();
          req.on('close', () => {
            streams.get(user.id)?.delete(res);
            if (!streams.get(user.id)?.size) streams.delete(user.id);
            const room = roomFor(user.id);
            if (room && !online(user.id)) room.disconnected.set(user.id, Date.now());
            broadcast();
          });
          roomFor(user.id)?.disconnected.delete(user.id);
          return;
        }
        if (req.method !== 'POST') return json(404, { error: '요청을 찾을 수 없어요.' });
        rate(`actions:${user.id}`, 80, 10000);
        const data = await body(req); let room = roomFor(user.id);
        switch (url.pathname) {
          case '/api/logout':
            leave(user); sessions.delete(token);
            for (const response of streams.get(user.id) ?? []) response.end();
            streams.delete(user.id);
            res.setHeader('Set-Cookie', 'hg_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
            broadcast(); return json(200, { ok: true });
          case '/api/rooms': {
            if (room) throw new Error('현재 방을 나간 후 새 방을 만들어주세요.');
            if (rooms.size >= 100) throw new Error('생성 가능한 방 수를 초과했어요.');
            const { name, max, mode, cards, ending } = data;
            if (typeof name !== 'string' || !name.trim() || name.trim().length > 24) throw new Error('방 이름은 1~24자로 입력해주세요.');
            if (!Number.isInteger(max) || max < 2 || max > 8 || !['original', 'custom'].includes(mode) || !['first', 'last'].includes(ending) || !Number.isInteger(cards) || cards < 5 || cards > 30) throw new Error('방 설정을 확인해주세요.');
            room = { id: randomUUID(), name: name.trim(), host: user.id, settings: { max, mode, cards, ending }, players: [{ ...identity(user), ready: false, bot: false }], messages: [], game: null, disconnected: new Map() };
            rooms.set(room.id, room); break;
          }
          case '/api/join':
            if (room) throw new Error('이미 방에 입장해 있어요.');
            room = rooms.get(data.roomId);
            if (!room || room.players.length >= room.settings.max || (room.game && room.game.phase !== 'finished')) throw new Error('지금 입장할 수 없는 방이에요.');
            room.game = null; room.players.forEach(p => p.ready = !!p.bot);
            room.players.push({ ...identity(user), ready: false, bot: false }); break;
          case '/api/leave': leave(user); break;
          case '/api/ready':
            if (!room || (room.game && room.game.phase !== 'finished')) throw new Error('지금 준비 상태를 바꿀 수 없어요.');
            if (room.game?.phase === 'finished') {
              room.game = null; room.players.forEach(p => p.ready = !!p.bot);
            }
            room.players.find(p => p.id === user.id).ready = !!data.ready;
            maybeStart(room); break;
          case '/api/bot': {
            if (!debug || !room || room.host !== user.id || (room.game && room.game.phase !== 'finished')) throw new Error('대기 중인 방장만 테스트 봇을 추가할 수 있어요.');
            if (room.players.length >= room.settings.max) throw new Error('방이 가득 찼어요.');
            room.game = null; room.players.forEach(p => p.ready = !!p.bot);
            const names = ['복숭아', '바나나', '라임', '자두', '체리', '망고', '멜론'];
            const name = names.find(n => !room.players.some(p => p.nickname === `${n} 봇`));
            room.players.push({ id: randomUUID(), nickname: `${name} 봇`, bot: true, ready: true }); break;
          }
          case '/api/action':
            if (!room?.game || data.gameId !== room.game.id) throw new Error('현재 경기를 찾을 수 없어요.');
            room.game.act(user.id, data.action, data.actionId, data.version);
            room.botAt = Date.now() + 650 + randomInt(650); record(room); break;
          case '/api/chat': {
            rate(`chat:${user.id}`, 1, 800);
            if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 200) throw new Error('메시지는 1~200자로 입력해주세요.');
            if (!['global', 'room'].includes(data.channel) || (data.channel === 'room' && !room)) throw new Error('채팅방을 확인해주세요.');
            const list = data.channel === 'room' ? room.messages : chats;
            list.push({ id: randomUUID(), nickname: user.nickname, text: data.text.trim(), at: Date.now() });
            if (list.length > 100) list.shift(); break;
          }
          default: return json(404, { error: '요청을 찾을 수 없어요.' });
        }
        broadcast(); return json(200, snapshot(user));
      }
      if (req.method !== 'GET') return json(405, { error: '지원하지 않는 요청이에요.' });
      const files = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/table.css': 'table.css', '/table-layout.js': 'table-layout.js', '/fruit.svg': 'fruit.svg', '/login-art.svg': 'login-art.svg', '/silver-bell.svg': 'silver-bell.svg' };
      const file = files[url.pathname];
      if (!file) { res.writeHead(404); return res.end('Not found'); }
      const content = await readFile(join(publicRoot, file));
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[extname(file)], 'Cache-Control': 'no-cache' });
      res.end(content);
    } catch (error) {
      if (!res.headersSent) json(400, { error: error.message });
      else res.end();
    }
  });
  const timer = setInterval(() => {
    let changed = false; const now = Date.now();
    for (const room of rooms.values()) {
      for (const [id, at] of room.disconnected) {
        if (online(id)) room.disconnected.delete(id);
        else if (now - at >= 30000) { const u = accounts.users.find(u => u.id === id); if (u) leave(u); changed = true; }
      }
      const g = room.game; if (!g) continue;
      if (g.tick(now)) changed = true;
      if (g.phase === 'playing' && now >= room.botAt) {
        if (g.canRing()) {
          const bots = g.players.filter(p => p.bot && p.status !== 'out');
          if (bots.length) { g.ring(bots[randomInt(bots.length)].id, now); changed = true; }
        } else {
          const p = g.players[g.turn];
          if (p?.bot && p.deck.length) { g.flip(p.id, now); changed = true; }
        }
        room.botAt = now + 900 + randomInt(700);
      }
      record(room);
    }
    if (changed) broadcast();
  }, 150);
  const heartbeat = setInterval(() => {
    for (const responses of streams.values()) for (const res of responses) res.write(': heartbeat\n\n');
    const now = Date.now();
    for (const [key, value] of limits) if (value.until < now) limits.delete(key);
    for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
  }, 15000);
  return { server, accounts, rooms, close: async () => {
    clearInterval(timer); clearInterval(heartbeat);
    for (const responses of streams.values()) for (const res of responses) res.end();
    await new Promise(resolve => server.close(resolve));
    await accounts.saveQueue;
  } };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await createApp({ debug: process.env.DEBUG_MODE !== 'false' });
  const port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? '127.0.0.1';
  app.server.listen(port, host, () => console.log(`Halli Galli ready at http://${host}:${port} (DEBUG=${process.env.DEBUG_MODE !== 'false'})`));
}
