import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { readHomeToken } from '../server/homeAuth.js';

/** Stand-in for the homepage login server: token → member. */
function fakeHome() {
  const members = new Map();
  const verifySession = async cookie => members.get(readHomeToken(cookie)) ?? null;
  verifySession.forget = () => {};
  let n = 0;
  const signIn = (nickname, id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`) => {
    const token = String(n).padStart(2, '0').repeat(32);
    members.set(token, { id, name: `이름${n}`, nickname });
    return { cookie: `wj_session=${token}`, token, id };
  };
  return { verifySession, signIn, signOut: token => members.delete(token), members };
}
test('homepage login, real room/chat APIs, internal admin API and access boundaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'halli-galli-test-'));
  const home = fakeHome();
  const app = await createApp({ dataDir: directory, verifySession: home.verifySession, internalToken: 'secret-token-for-test' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, data, cookie, extra = {}, method) {
    const response = await fetch(base + path, { method: method ?? (data ? 'POST' : 'GET'), headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/state', undefined, 'wj_session=not-a-token')).status, 401);
  // Own login is gone: the homepage is the only way in.
  assert.equal((await request('/api/register', { nickname: '테스트A', password: 'password123' })).status, 401);
  assert.equal((await request('/api/login', { nickname: '테스트A', password: 'password123' })).status, 401);
  const a = home.signIn('테스트A');
  const state = await request('/api/state', undefined, a.cookie);
  assert.equal(state.status, 200); assert.equal(state.body.me.nickname, '테스트A'); assert.equal(state.body.me.id, a.id);
  await app.accounts.saveQueue;
  const saved = JSON.parse(await readFile(join(directory, 'records.json'), 'utf8'));
  assert.deepEqual(saved, [{ id: a.id, nickname: '테스트A', wins: 0, played: 0 }]);
  const room = await request('/api/rooms', { name: '첫 번째 테이블', max: 2, mode: 'custom', cards: 10, ending: 'last' }, a.cookie);
  assert.equal(room.status, 200); assert.equal(room.body.room.players.length, 1);
  const bot = await request('/api/bot', {}, a.cookie); assert.equal(bot.body.room.players.length, 2);
  assert.equal((await request('/api/bot', {}, a.cookie)).status, 400);
  const chat = await request('/api/chat', { channel: 'room', text: '<script>alert(1)</script>' }, a.cookie);
  assert.equal(chat.body.room.messages[0].text, '<script>alert(1)</script>'); assert.equal(chat.body.messages.length, 0);
  const b = home.signIn('다른친구');
  assert.equal((await request('/api/join', { roomId: room.body.room.id }, b.cookie)).status, 400);
  assert.equal((await request('/api/state', undefined, b.cookie)).body.room, null);
  assert.equal((await request('/api/chat', { channel: 'room', text: 'hi' }, b.cookie)).status, 400);
  assert.equal((await request('/api/leave', {}, a.cookie, { Origin: 'https://untrusted.example' })).status, 403);

  // Internal admin API: hidden without the secret, refused through the tunnel.
  const secret = { 'X-Internal-Token': 'secret-token-for-test' };
  assert.equal((await request(`/internal/users/${a.id}`)).status, 404);
  assert.equal((await request(`/internal/users/${a.id}`, undefined, null, { 'X-Internal-Token': 'wrong' })).status, 404);
  assert.equal((await request(`/internal/users/${a.id}`, undefined, null, { ...secret, 'CF-Connecting-IP': '1.2.3.4' })).status, 404);
  assert.equal((await request(`/internal/users/${a.id}`, undefined, null, { ...secret, 'X-Forwarded-For': '1.2.3.4' })).status, 404);
  const record = await request(`/internal/users/${a.id}`, undefined, null, secret);
  assert.deepEqual(record.body, { ok: true, record: { id: a.id, nickname: '테스트A', wins: 0, played: 0 } });
  assert.equal((await request('/internal/users/unknown-id', undefined, null, secret)).body.record, null);
  const renamed = await request(`/internal/users/${a.id}`, { nickname: '새이름' }, null, secret, 'PUT');
  assert.equal(renamed.status, 200); assert.equal(renamed.body.changed, true);
  home.members.get(a.token).nickname = '새이름';
  const after = await request('/api/state', undefined, a.cookie);
  assert.equal(after.body.me.nickname, '새이름'); assert.equal(after.body.room.players[0].nickname, '새이름');
  // Forced logout from the admin page: live stream closes with signedOut right away.
  const b2 = await fetch(base + '/api/events', { headers: { Cookie: b.cookie } });
  const r2 = b2.body.getReader();
  assert.equal((await request(`/internal/users/${b.id}/logout`, undefined, null, secret)).status, 405);
  assert.equal((await request(`/internal/users/${b.id}/logout`, {}, null, { 'X-Internal-Token': 'nope' })).status, 404);
  assert.equal((await request(`/internal/users/${b.id}/logout`, {}, null, secret)).status, 200);
  let t2 = ''; const d2 = new TextDecoder();
  while (true) { const { value, done } = await r2.read(); if (done) break; t2 += d2.decode(value); }
  assert.match(t2, /event: signedOut/);
  // Delete: live stream gets signedOut, record and room seat disappear.
  const events = await fetch(base + '/api/events', { headers: { Cookie: a.cookie } });
  const reader = events.body.getReader();
  home.signOut(a.token);
  const removed = await request(`/internal/users/${a.id}`, undefined, null, secret, 'DELETE');
  assert.deepEqual(removed.body, { ok: true, removed: true });
  let text = ''; const decoder = new TextDecoder();
  while (true) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); }
  assert.match(text, /event: signedOut/);
  assert.equal(app.rooms.size, 0);
  assert.equal((await request('/api/state', undefined, a.cookie)).status, 401);
  await app.accounts.saveQueue;
  const left = JSON.parse(await readFile(join(directory, 'records.json'), 'utf8'));
  assert.deepEqual(left.map(u => u.nickname), ['다른친구']);
});

test('8 independent sessions receive the same start, starter and 80-card public state over SSE', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'halli-galli-sse-'));
  const home = fakeHome();
  const app = await createApp({ dataDir: directory, verifySession: home.verifySession });
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
    const { cookie } = home.signIn(`접속친구${i}`); cookies.push(cookie);
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
  // each player sees only their own card count; the others' stay hidden until the game ends
  assert.ok(states.every(s => s.room.game.players.every(p => !('deck' in p) && (p.id === s.me.id ? p.cards === 10 : p.cards === null))));
  assert.equal(game.startsAt - game.announceAt, 1500);
});

test('everyone at a table gets their own colour, picked at random', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'halli-galli-color-'));
  const home = fakeHome();
  const app = await createApp({ dataDir: directory, verifySession: home.verifySession });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, data, cookie) => (await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(data) })).json();
  const seen = new Set();
  for (let round = 0; round < 6; round++) {
    const host = home.signIn(`색${round}`);
    await post('rooms', { name: '색', max: 8, mode: 'custom', cards: 5, ending: 'last' }, host.cookie);
    let state;
    for (let i = 0; i < 7; i++) state = await post('bot', {}, host.cookie);
    const colors = state.room.players.map(p => p.color);
    assert.equal(new Set(colors).size, 8, 'eight players, eight different colours');
    assert.ok(colors.every(c => Number.isInteger(c) && c >= 0 && c < 8));
    seen.add(colors.join());
    await post('leave', {}, host.cookie);
  }
  assert.ok(seen.size > 1, 'the order is random');
});
