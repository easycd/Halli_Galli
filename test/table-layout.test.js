import test from 'node:test';
import assert from 'node:assert/strict';
import { seatGeometry, flipKeyframes, liftKeyframes, detectCollection, collectionKeyframes, SEAT_RADIUS, labelTurn, stackLevel } from '../public/table-layout.js';

test('2-8 players have equally spaced seats on a true circle, starting at bottom', () => {
  for (let count = 2; count <= 8; count++) {
    const seats = Array.from({ length: count }, (_, i) => seatGeometry(i, count));
    assert.ok(Math.abs(seats[0].x - 50) < 1e-9);
    assert.equal(seats[0].y, 50 + SEAT_RADIUS);
    for (let i = 0; i < count; i++) {
      const p = seats[i], next = seats[(i + 1) % count];
      assert.ok(Math.abs(Math.hypot(p.x - 50, p.y - 50) - SEAT_RADIUS) < 1e-9);
      const distance = Math.hypot(p.x - next.x, p.y - next.y);
      assert.ok(Math.abs(distance - 2 * SEAT_RADIUS * Math.sin(Math.PI / count)) < 1e-9);
    }
  }
});
test('each flip lifts outward and lands on the inward pile for every seat direction', () => {
  for (let i = 0; i < 8; i++) {
    const seat = seatGeometry(i, 8), frames = flipKeyframes(seat, 56);
    const radius = frame => Math.hypot(parseFloat(frame.left), parseFloat(frame.top));
    assert.ok(radius(frames[1]) > radius(frames[0]));
    const final = frames.at(-1);
    assert.ok(parseFloat(final.left) * seat.dx + parseFloat(final.top) * seat.dy < 0);
    assert.match(final.transform, /rotateX\(-180deg\)/);
    assert.ok(Math.abs(radius(final) - 56) < 1e-9);
  }
});

const previous = () => ({ id: 'game', version: 7, phase: 'playing', players: [
  { id: 'a', nickname: 'A', cards: 8, hits: 0, openCount: 3, top: { id: 'a1', fruit: 'lime', count: 2 } },
  { id: 'b', nickname: 'B', cards: 5, hits: 1, openCount: 2, top: { id: 'b1', fruit: 'lime', count: 3 } },
] });
const collected = () => ({ id: 'game', version: 8, phase: 'playing', players: [
  { id: 'a', nickname: 'A', cards: 13, hits: 1, openCount: 0, top: null },
  { id: 'b', nickname: 'B', cards: 5, hits: 1, openCount: 0, top: null },
] });
test('collection visual is created only for a confirmed pickup with the exact card gain', () => {
  const event = detectCollection(previous(), collected());
  assert.equal(event.winnerId, 'a'); assert.equal(event.total, 5);
  assert.deepEqual(event.piles.map(p => p.count), [3, 2]);
  assert.equal(detectCollection(null, collected()), null);
  assert.equal(detectCollection(collected(), collected()), null);
  const wrong = collected(); wrong.players[0].hits = 0;
  assert.equal(detectCollection(previous(), wrong), null);
  const missed = collected(); missed.players[0].cards = 12;
  assert.equal(detectCollection(previous(), missed), null);
  // another player's win: their counts are hidden (null), the hits and empty piles are enough
  const hiddenBefore = previous(), hiddenAfter = collected();
  for (const list of [hiddenBefore.players, hiddenAfter.players]) list.forEach(p => { p.cards = null; });
  assert.equal(detectCollection(hiddenBefore, hiddenAfter)?.total, 5);
});
test('winning bell ending a game still produces a pickup, a new game never does', () => {
  const next = collected(); next.phase = 'finished';
  assert.equal(detectCollection(previous(), next).total, 5);
  next.id = 'other-game'; assert.equal(detectCollection(previous(), next), null);
});
test('all eight sources converge on any winner private pile without changing game state', () => {
  for (let winnerIndex = 0; winnerIndex < 8; winnerIndex++) {
    const winner = seatGeometry(winnerIndex, 8);
    for (let sourceIndex = 0; sourceIndex < 8; sourceIndex++) {
      const frames = collectionKeyframes(seatGeometry(sourceIndex, 8), winner, 760, 56);
      const last = frames.at(-1);
      assert.ok(Math.abs(parseFloat(last.left) - (760 * winner.x / 100 + winner.dx * 56)) < 1e-9);
      assert.ok(Math.abs(parseFloat(last.top) - (760 * winner.y / 100 + winner.dy * 56)) < 1e-9);
      assert.equal(last.opacity, 0);
      assert.match(last.transform, /rotateY\(180deg\)/);
    }
  }
});

test('a held card flips on from where it was held; name tags are never upside down', () => {
  for (let i = 0; i < 8; i++) {
    const seat = seatGeometry(i, 8), frames = flipKeyframes(seat, 56, true, .77);
    const radius = frame => Math.hypot(parseFloat(frame.left), parseFloat(frame.top));
    assert.ok(Math.abs(radius(frames[0]) - 44) < 1e-9, 'starts at the held spot, a little inside the deck');
    assert.match(frames[0].transform, /rotateX\(-42deg\)/);
    assert.match(frames.at(-1).transform, /rotateX\(-180deg\)/);
    const [rest, held] = liftKeyframes(seat, 56, .77);
    assert.equal(held.left, frames[0].left); assert.equal(held.transform, frames[0].transform);
    assert.ok(Math.abs(Math.hypot(parseFloat(rest.left), parseFloat(rest.top)) - 56) < 1e-9);
    const { angle, out } = labelTurn(seat.rotation);
    assert.ok(angle >= -90 && angle <= 90, `${seat.rotation} → ${angle}`);
    assert.equal(out, seat.rotation > 90 && seat.rotation < 270 ? -1 : 1);
  }
});

test('decks look thicker with more cards', () => {
  assert.equal(stackLevel(0), 0);
  assert.equal(stackLevel(1), 1);
  assert.ok(stackLevel(5) < stackLevel(15) && stackLevel(15) < stackLevel(30));
  assert.equal(stackLevel(200), 14);
});
