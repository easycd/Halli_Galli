import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';

test('auth, cookie sessions, real room/chat APIs and access boundaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'halli-galli-test-'));
  const app = await createApp({ dataDir: directory });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, data, cookie, extra = {}) {
    const response = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
  }
  assert.equal((await request('/api/state')).status, 401);
  const registered = await request('/api/register', { nickname: '테스트A', password: 'password123' });
  assert.equal(registered.status, 200); assert.ok(registered.cookie);
  const cookie = registered.cookie;
  const saved = await readFile(join(directory, 'accounts.json'), 'utf8');
  assert.ok(!saved.includes('password123')); assert.ok(!JSON.stringify(registered.body).includes('hash'));
  assert.equal((await request('/api/register', { nickname: '테스트a', password: 'password123' })).status, 400);
  assert.equal((await request('/api/login', { nickname: '테스트A', password: 'incorrect' })).status, 400);
  assert.equal((await request('/api/login', { nickname: '테스트A', password: 'password123' })).status, 200);
  const room = await request('/api/rooms', { name: '첫 번째 테이블', max: 2, mode: 'custom', cards: 10, ending: 'last' }, cookie);
  assert.equal(room.status, 200); assert.equal(room.body.room.players.length, 1);
  const bot = await request('/api/bot', {}, cookie); assert.equal(bot.body.room.players.length, 2);
  assert.equal((await request('/api/bot', {}, cookie)).status, 400);
  const chat = await request('/api/chat', { channel: 'room', text: '<script>alert(1)</script>' }, cookie);
  assert.equal(chat.body.room.messages[0].text, '<script>alert(1)</script>'); assert.equal(chat.body.messages.length, 0);
  const account2 = await request('/api/register', { nickname: '다른친구', password: 'password456' });
  assert.equal((await request('/api/join', { roomId: room.body.room.id }, account2.cookie)).status, 400);
  assert.equal((await request('/api/state', undefined, account2.cookie)).body.room, null);
  assert.equal((await request('/api/chat', { channel: 'room', text: 'hi' }, account2.cookie)).status, 400);
  assert.equal((await request('/api/leave', {}, cookie, { Origin: 'https://untrusted.example' })).status, 403);
  await request('/api/logout', {}, cookie);
  assert.equal((await request('/api/state', undefined, cookie)).status, 401);
});

test('8 independent sessions receive the same start, starter and 80-card public state over SSE', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'halli-galli-sse-'));
  const app = await createApp({ dataDir: directory });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function post(path, data, cookie) {
    const res = await fetch(base + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
    const result = await res.json(); assert.equal(res.status, 200, result.error);
    return { body: result, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  const cookies = [], readers = [];
  for (let i = 0; i < 8; i++) {
    const { cookie } = await post('register', { nickname: `접속친구${i}`, password: 'sse-test-password' }); cookies.push(cookie);
    const response = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: abort.signal });
    readers.push(response.body.getReader());
  }
  const { body: created } = await post('rooms', { name: '8인 동기화 검증', max: 8, mode: 'custom', cards: 10, ending: 'first' }, cookies[0]);
  for (const cookie of cookies.slice(1)) await post('join', { roomId: created.room.id }, cookie);
  for (const cookie of cookies) await post('ready', { ready: true }, cookie);
  async function readStart(reader) {
    let buffer = ''; const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read(); assert.equal(done, false);
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const entry = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (entry.startsWith('data: ')) {
          const snapshot = JSON.parse(entry.slice(6));
          if (snapshot.room?.game) return snapshot;
        }
      }
    }
  }
  const states = await Promise.all(readers.map(readStart));
  const game = states[0].room.game;
  assert.ok(states.every(s => s.online.length === 8 && s.room.game.id === game.id && s.room.game.starter === game.starter && s.room.game.startsAt === game.startsAt));
  assert.ok(states.every(s => s.room.game.players.every(p => p.cards === 10 && !('deck' in p))));
  assert.equal(game.startsAt - game.announceAt, 1500);
});
