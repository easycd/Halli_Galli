// eight clearly different colours, one per player (up to 8 at a table); dark text stays readable on all of them
export const NAME_COLORS = ['#f4b6ae', '#cfe5a6', '#d3c1f0', '#f6dc8f', '#a8dcd6', '#f2b8d8', '#b9d2f2', '#f7c99a'];

// Starting at the bottom, all seats follow the same clockwise circle.
export function seatGeometry(index, count) {
  const degrees = 90 + index * 360 / Math.max(1, count);
  const radians = degrees * Math.PI / 180;
  const dx = Math.cos(radians), dy = Math.sin(radians);
  return { x: 50 + dx * 30, y: 50 + dy * 30, dx, dy, rotation: degrees - 90 };
}

export function flipKeyframes({ dx, dy, rotation }, offset) {
  const transform = angle => `translate(-50%, -50%) rotate(${rotation}deg) perspective(600px) rotateX(${angle}deg)`;
  return [
    { left: `${dx * offset}px`, top: `${dy * offset}px`, transform: transform(0), offset: 0 },
    { left: `${dx * (offset + 22)}px`, top: `${dy * (offset + 22)}px`, transform: transform(-95), offset: .42 },
    { left: `${-dx * offset}px`, top: `${-dy * offset}px`, transform: transform(-180), offset: 1 },
  ];
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
