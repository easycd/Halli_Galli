import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, baseDeck } from '../server/game.js';
const settings = { mode: 'custom', cards: 10, max: 8, ending: 'last' };
const players = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, nickname: `친구${i}` }));
const card = (fruit, count) => ({ id: `${fruit}-${Math.random()}`, fruit, count });
function fixture(n = 3, ending = 'last') {
  const game = new Game(players(n), { ...settings, ending }, { pick: () => 0, now: 0 });
  game.phase = 'playing'; game.turn = 0;
  return game;
}
const total = game => game.players.reduce((n, p) => n + p.deck.length + p.open.length, 0);

test('base deck is 56 with 14 of each fruit and 5/3/3/2/1 distribution', () => {
  const cards = baseDeck(); assert.equal(cards.length, 56);
  for (const fruit of ['strawberry', 'banana', 'lime', 'plum']) {
    assert.deepEqual([1, 2, 3, 4, 5].map(n => cards.filter(c => c.fruit === fruit && c.count === n).length), [5, 3, 3, 2, 1]);
  }
});
test('8-person custom deals 80 cards, original distributes exactly 56 including remainder', () => {
  const custom = fixture(8); assert.equal(total(custom), 80); assert.ok(custom.players.every(p => p.deck.length === 10));
  const original = new Game(players(3), { ...settings, mode: 'original' });
  assert.equal(total(original), 56); assert.deepEqual(original.players.map(p => p.deck.length), [19, 19, 18]);
  assert.equal(new Set(custom.players.flatMap(p => p.deck).map(c => c.id)).size, 80);
});
test('only top cards count; 6 is incorrect and replacing a card can produce exactly 5', () => {
  const g = fixture();
  g.players[0].open = [card('banana', 5), card('banana', 3)];
  g.players[1].open = [card('banana', 3)]; assert.equal(g.canRing(), false);
  g.players[1].open.push(card('banana', 2)); assert.equal(g.canRing(), true);
});
test('success collects entire open piles once, preserves total and restarts at winner', () => {
  const g = fixture();
  g.players[0].open = [g.players[0].deck.shift(), card('lime', 3)];
  g.players[1].open = [card('lime', 2)];
  const before = total(g), held = g.players[1].deck.length;
  const first = g.act('p1', 'ring', 'same', 0, 20);
  assert.equal(g.players[1].deck.length, held + 3); assert.equal(g.turn, 1); assert.equal(total(g), before);
  assert.deepEqual(g.act('p1', 'ring', 'same', 0), first);
  assert.deepEqual(g.act('p0', 'ring', 'late', 0), { stale: true });
  assert.equal(g.players[0].misses, 0);
});
test('last-card player can ring to return; someone else winning eliminates after pickup', () => {
  const g = fixture(3, 'first');
  g.players[0].deck = [card('plum', 5)];
  g.flip('p0'); assert.equal(g.players[0].status, 'recovering'); assert.equal(g.phase, 'playing');
  g.ring('p0'); assert.equal(g.players[0].status, 'active'); assert.equal(g.phase, 'playing');
  g.flip('p0'); g.ring('p1'); assert.equal(g.players[0].status, 'out'); assert.equal(g.phase, 'finished');
  assert.equal(g.results[0].id, 'p1');
});
test('wrong bell pays clockwise, can restore a recovering player and conserves cards', () => {
  const g = fixture();
  g.players[1].deck = []; g.players[1].status = 'recovering';
  const before = total(g); g.ring('p0');
  assert.equal(g.players[0].deck.length, 8); assert.equal(g.players[1].deck.length, 1);
  assert.equal(g.players[1].status, 'active'); assert.equal(total(g), before);
});
test('penalty shortage becomes recovery, wrong ring with no cards eliminates', () => {
  const g = fixture(); g.players[0].deck = [card('lime', 2)];
  g.ring('p0'); assert.equal(g.players[0].status, 'recovering');
  g.ring('p0'); assert.equal(g.players[0].status, 'out'); assert.equal(g.phase, 'playing');
  assert.throws(() => g.ring('p0'));
});
test('last survivor mode continues at 2, resolves simultaneous eliminations and tied ranks', () => {
  const g = fixture(4);
  g.players[0].status = 'out'; g.players[0].eliminatedAt = 1; g.players[0].deck = [];
  g.players[1].status = 'recovering'; g.players[1].deck = [];
  g.players[2].status = 'recovering'; g.players[2].deck = [];
  g.players[1].open = [card('strawberry', 5)];
  g.ring('p3'); assert.equal(g.phase, 'finished'); assert.equal(g.results[0].id, 'p3');
  assert.equal(g.results.find(p => p.id === 'p1').rank, 2); assert.equal(g.results.find(p => p.id === 'p2').rank, 2);
});
test('first-elimination mode awards shared win to equal surviving hidden decks', () => {
  const g = fixture(3, 'first');
  g.players[0].deck = []; g.players[0].status = 'recovering';
  g.ring('p0'); assert.equal(g.phase, 'finished');
  assert.equal(g.results.filter(p => p.winner).length, 2);
});
test('no deck and no valid bell is draw, empty decks with valid bell can recover', () => {
  const g = fixture(2); g.players.forEach(p => { p.deck = []; p.status = 'recovering'; });
  g.players[0].open = [card('lime', 5)]; g.checkStalemate(); assert.equal(g.phase, 'playing');
  g.players[0].open = [card('lime', 4)]; g.checkStalemate(); assert.equal(g.phase, 'finished'); assert.equal(g.draw, true);
  assert.ok(g.results.every(p => !p.winner));
});
test('snapshot never exposes private cards or future shuffled order; start uses server time', () => {
  const g = new Game(players(2), settings, { now: 0 });
  assert.ok(g.snapshot().players.every(p => !('deck' in p) && !('open' in p)));
  g.tick(3000); assert.equal(g.phase, 'announcing');
  g.tick(4499); assert.equal(g.phase, 'announcing');
  g.tick(4500); assert.equal(g.phase, 'playing');
});

test('many complete 2-8 person games preserve every card through penalties and recovery', () => {
  let seed = 87654321;
  const pick = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let run = 0; run < 80; run++) {
    const count = 2 + pick(7), ending = run % 2 ? 'first' : 'last';
    const g = new Game(players(count), { ...settings, cards: 5, ending }, { pick, now: 0 });
    g.phase = 'playing';
    for (let step = 0; step < 20000 && g.phase === 'playing'; step++) {
      const eligible = g.players.filter(p => p.status !== 'out');
      if (g.canRing() || pick(18) === 0) g.ring(eligible[pick(eligible.length)].id, step);
      else if (g.turn >= 0) g.flip(g.players[g.turn].id, step);
      else g.checkStalemate();
      assert.equal(total(g), count * 5);
      assert.ok(g.players.every(p => p.status !== 'active' || p.deck.length > 0));
    }
    assert.equal(g.phase, 'finished', `game ${run} should finish`);
    if (!g.draw) assert.ok(g.results.some(p => p.winner));
  }
});
