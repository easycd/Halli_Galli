import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/game.js';
import { createPlayReporter, playReport } from '../server/homePlays.js';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const table = (settings = { max: 4, mode: 'custom', cards: 10, ending: 'last' }) => {
  const players = [{ id: ids[0], nickname: '가', bot: false }, { id: ids[1], nickname: '나', bot: false }, { id: 'bot-1', nickname: '봇1', bot: true }];
  return { name: '빠른 손', settings, players, game: new Game(players, settings, { now: 1_000_000 }) };
};

test('a finished table becomes one play record for the homepage', () => {
  const room = table();
  const g = room.game;
  g.players[1].status = 'out'; g.players[1].eliminatedAt = 2; g.players[2].status = 'out'; g.players[2].eliminatedAt = 1;
  g.finish();
  const play = playReport(room, 1_000_000 + 600_000);
  assert.equal(play.game, 'haligali');
  assert.equal(play.gameId, g.id);
  assert.equal(play.room, '빠른 손');
  assert.equal(play.mode, '한 명당 10장 · 마지막 1명까지 · 봇 포함');
  assert.equal(play.startedAt, g.startsAt);
  assert.equal(play.endedAt, 1_600_000);
  assert.equal(play.result, '가 승리');
  assert.equal(play.reason, '마지막 한 명이 남음');
  assert.deepEqual(play.players.map(p => [p.nickname, p.result, p.team]), [['가', 'win', null], ['나', 'loss', null], ['봇1', 'loss', '봇']]);
});

test('a draw is reported as a draw for everyone', () => {
  const room = table({ max: 4, mode: 'original', cards: 10, ending: 'first' });
  room.game.draw = true; room.game.notice = '낼 카드가 없어 무승부'; room.game.finish();
  const play = playReport(room, 2_000_000);
  assert.equal(play.result, '무승부');
  assert.equal(play.reason, '낼 카드가 없어 무승부');
  assert.ok(play.players.every(p => p.result === 'draw'));
});

test('the reporter posts with the shared secret and is off without one', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); };
  await createPlayReporter({ url: 'http://127.0.0.1:8080/api/internal/plays', token: 's3cret', fetchImpl })({ gameId: 'x' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['X-Internal-Token'], 's3cret');
  assert.deepEqual(JSON.parse(calls[0].init.body), { gameId: 'x' });
  await createPlayReporter({ token: '', fetchImpl })({ gameId: 'y' });
  assert.equal(calls.length, 1);
});
