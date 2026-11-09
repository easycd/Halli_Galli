// eight clearly different colours, one per player (up to 8 at a table); dark text stays readable on all of them
export const NAME_COLORS = ['#f4b6ae', '#cfe5a6', '#d3c1f0', '#f6dc8f', '#a8dcd6', '#f2b8d8', '#b9d2f2', '#f7c99a'];

// How thick a deck looks: one sheet more for every 3 cards (at most 14). Others see this, not the exact count.
export function stackLevel(count) {
  return count > 0 ? Math.min(14, 1 + Math.floor(count / 3)) : 0;
}

// Seats sit on one circle (percent of the table from the middle); names go behind the cards, so the
// circle leaves room outside for them.
export const SEAT_RADIUS = 27;

// Starting at the bottom, all seats follow the same clockwise circle.
export function seatGeometry(index, count) {
  const degrees = 90 + index * 360 / Math.max(1, count);
  const radians = degrees * Math.PI / 180;
  const dx = Math.cos(radians), dy = Math.sin(radians);
  return { x: 50 + dx * SEAT_RADIUS, y: 50 + dy * SEAT_RADIUS, dx, dy, rotation: degrees - 90 };
}

// A card held "about to flip": slid a little toward the middle and tipped up on its far edge. The held card is
// drawn at the flying card's size scaled down to the deck (deckScale), so the flight can carry on from it.
export const LIFT = { inward: 12, angle: -42, grow: 1.06 };
export function liftTransform(rotation, scale, angle = LIFT.angle) {
  return `translate(-50%, -50%) rotate(${rotation}deg) perspective(600px) rotateX(${angle}deg) scale(${scale})`;
}
// rest (lying on the deck) → held
export function liftKeyframes({ dx, dy, rotation }, offset, deckScale) {
  const at = r => ({ left: `${dx * r}px`, top: `${dy * r}px` });
  return [
    { ...at(offset), transform: liftTransform(rotation, deckScale, 0) },
    { ...at(offset - LIFT.inward), transform: liftTransform(rotation, deckScale * LIFT.grow) },
  ];
}

// lifted: the card starts from the held pose (the player was pressing their deck), so the motion continues from there
export function flipKeyframes({ dx, dy, rotation }, offset, lifted = false, deckScale = 1) {
  const transform = angle => `translate(-50%, -50%) rotate(${rotation}deg) perspective(600px) rotateX(${angle}deg)`;
  if (lifted) {
    const start = offset - LIFT.inward;
    return [
      { left: `${dx * start}px`, top: `${dy * start}px`, transform: liftTransform(rotation, deckScale * LIFT.grow), offset: 0 },
      { left: `${dx * offset * .25}px`, top: `${dy * offset * .25}px`, transform: `${transform(-112)} scale(${(1 + deckScale * LIFT.grow) / 2})`, offset: .45 },
      { left: `${-dx * offset}px`, top: `${-dy * offset}px`, transform: `${transform(-180)} scale(1)`, offset: 1 },
    ];
  }
  return [
    { left: `${dx * offset}px`, top: `${dy * offset}px`, transform: transform(0), offset: 0 },
    { left: `${dx * (offset + 22)}px`, top: `${dy * (offset + 22)}px`, transform: transform(-95), offset: .42 },
    { left: `${-dx * offset}px`, top: `${-dy * offset}px`, transform: transform(-180), offset: 1 },
  ];
}

// Name tags are turned with the seat but never upside down: returns the angle and which way "outward" is for the tag.
export function labelTurn(rotation) {
  const r = ((rotation % 360) + 360) % 360;
  if (r > 90 && r < 270) return { angle: r - 180, out: -1 };
  return { angle: r >= 270 ? r - 360 : r, out: 1 };
}

// Use confirmed public state only: a wrong bell, reconnect, or duplicate snapshot
// must never create a visual award that the server did not make.
export function detectCollection(previous, next) {
  if (!previous || !next || previous.id !== next.id || next.version <= previous.version) return null;
  if (!['playing', 'finished'].includes(next.phase)) return null;
  const winners = next.players.filter(p => p.hits - (previous.players.find(q => q.id === p.id)?.hits ?? p.hits) === 1);
  if (winners.length !== 1 || next.players.some(p => p.openCount !== 0)) return null;
  const winner = winners[0], beforeWinner = previous.players.find(p => p.id === winner.id);
  const piles = previous.players.map((p, index) => ({ playerId: p.id, index, count: p.openCount, top: p.top })).filter(p => p.count > 0 && p.top);
  const total = piles.reduce((sum, pile) => sum + pile.count, 0);
  // card counts are only known for my own seat (others are hidden), so check them only when both are known
  const known = Number.isInteger(winner.cards) && Number.isInteger(beforeWinner.cards);
  if (!total || (known && winner.cards - beforeWinner.cards !== total)) return null;
  return { id: `${next.id}:${next.version}`, winnerId: winner.id, winnerName: winner.nickname, winnerIndex: next.players.indexOf(winner), playerCount: next.players.length, total, piles };
}

export function collectionKeyframes(source, winner, size, offset) {
  const center = size / 2;
  const from = { x: size * source.x / 100 - source.dx * offset, y: size * source.y / 100 - source.dy * offset };
  const to = { x: size * winner.x / 100 + winner.dx * offset, y: size * winner.y / 100 + winner.dy * offset };
  const transform = (angle, scale, flip = 0) => `translate(-50%, -50%) rotate(${angle}deg) perspective(650px) rotateY(${flip}deg) scale(${scale})`;
  return [
    { left: `${from.x}px`, top: `${from.y}px`, transform: transform(source.rotation, 1), opacity: 1, offset: 0 },
    { left: `${center - winner.dx * 18}px`, top: `${center - winner.dy * 18}px`, transform: transform(winner.rotation - 14, .92), opacity: 1, offset: .48 },
    { left: `${to.x}px`, top: `${to.y}px`, transform: transform(winner.rotation, .76, 180), opacity: 1, offset: .92 },
    { left: `${to.x}px`, top: `${to.y}px`, transform: transform(winner.rotation, .76, 180), opacity: 0, offset: 1 },
  ];
}

// A wrong bell: one card leaves the hitter's deck, stops in the middle of the table, then goes into another deck.
// Turns are taken the short way round (a seat at 270° is -90°), so a card never spins all the way round.
export function penaltyKeyframes(from, to, size, offset) {
  const deck = s => ({ x: size * s.x / 100 + s.dx * offset, y: size * s.y / 100 + s.dy * offset });
  const turn = r => { const n = ((r % 360) + 360) % 360; return n > 180 ? n - 360 : n; };
  const a = deck(from), b = deck(to), c = size / 2;
  const t = (angle, scale) => `translate(-50%, -50%) rotate(${angle}deg) scale(${scale})`;
  return [
    { left: `${a.x}px`, top: `${a.y}px`, transform: t(turn(from.rotation), 1), opacity: 1, offset: 0 },
    { left: `${c}px`, top: `${c}px`, transform: t(0, 1.35), opacity: 1, offset: .38 },
    { left: `${c}px`, top: `${c}px`, transform: t(0, 1.35), opacity: 1, offset: .55 },
    { left: `${b.x}px`, top: `${b.y}px`, transform: t(turn(to.rotation), 1), opacity: 1, offset: .94 },
    { left: `${b.x}px`, top: `${b.y}px`, transform: t(turn(to.rotation), 1), opacity: 0, offset: 1 },
  ];
}
