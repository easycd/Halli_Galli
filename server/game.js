import { randomInt, randomUUID } from 'node:crypto';
import { stackLevel } from '../public/table-layout.js';

export const FRUITS = ['strawberry', 'banana', 'lime', 'plum'];
export const BASE_COUNTS = [5, 3, 3, 2, 1];
export function baseDeck() {
  return FRUITS.flatMap(fruit => BASE_COUNTS.flatMap((copies, i) =>
    Array.from({ length: copies }, () => ({ id: randomUUID(), fruit, count: i + 1 }))));
}
export function shuffled(cards, pick = n => randomInt(n)) {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export class Game {
  constructor(players, settings, { pick = n => randomInt(n), now = Date.now() } = {}) {
    this.id = randomUUID();
    this.settings = settings;
    this.players = players.map((p, seat) => ({ ...p, seat, deck: [], open: [], status: 'active', hits: 0, misses: 0, eliminatedAt: null }));
    let cards = [];
    const total = settings.mode === 'original' ? 56 : settings.cards * players.length;
    while (cards.length < total) cards.push(...baseDeck());
    cards = shuffled(cards, pick).slice(0, total);
    cards.forEach((card, i) => this.players[i % players.length].deck.push(card));
    this.total = total;
    this.version = 0;
    this.phase = 'spinning';
    this.starter = pick(players.length);
    this.turn = this.starter;
    this.createdAt = now;
    this.announceAt = now + 3000;
    this.startsAt = now + 4500;
    this.deadline = this.startsAt + 10000;
    this.notice = '첫 차례 뽑는 중';
    this.results = [];
    this.draw = false;
    this.actions = new Map();
    this.eliminationWave = 0;
    this.departures = [];   // players who left mid-game: { id, nickname, version }
    this.lastRing = null;   // who hit the bell last: { id, nickname, color, ok, version } (the hand animation)
  }
  counts() {
    const result = Object.fromEntries(FRUITS.map(f => [f, 0]));
    for (const p of this.players) {
      const card = p.open.at(-1);
      if (card) result[card.fruit] += card.count;
    }
    return result;
  }
  canRing() { return Object.values(this.counts()).some(n => n === 5); }
  tick(now = Date.now()) {
    if (this.phase === 'spinning' && now >= this.announceAt) { this.phase = 'announcing'; return true; }
    if (this.phase === 'announcing' && now >= this.startsAt) {
      this.phase = 'playing'; this.notice = `${this.players[this.turn].nickname}님부터 시작`; return true;
    }
    if (this.phase === 'playing' && now >= this.deadline && this.players[this.turn]?.deck.length) {
      this.flip(this.players[this.turn].id, now); return true;
    }
    return false;
  }
  nextTurn(from, now) {
    for (let i = 1; i <= this.players.length; i++) {
      const index = (from + i) % this.players.length;
      if (this.players[index].deck.length && this.players[index].status !== 'out') {
        this.turn = index; this.deadline = now + 10000; this.clearHolds(); return;
      }
    }
    this.turn = -1;
    this.deadline = null;
    this.clearHolds();
  }
  clearHolds() { for (const p of this.players) p.holding = false; }
  // The player whose turn it is presses their deck: the top card is held up, about to be flipped (everyone sees it).
  // Letting go on the deck flips it (flip); dragging off the deck puts it back (on = false). It is only a show,
  // so it does not change the game version (a bell hit sent at the same moment still counts).
  hold(id, on) {
    const p = this.players.find(p => p.id === id);
    if (!p) return false;
    const next = on && this.phase === 'playing' && this.players[this.turn] === p && p.deck.length > 0;
    if (!!p.holding === next) return false;
    p.holding = next;
    return true;
  }
  flip(id, now = Date.now()) {
    const p = this.players[this.turn];
    if (this.phase !== 'playing' || !p || p.id !== id || !p.deck.length) throw new Error('지금은 카드를 뒤집을 수 없어요.');
    p.open.push(p.deck.shift());
    p.holding = false;
    if (!p.deck.length) p.status = 'recovering';
    this.version++;
    this.notice = `${p.nickname}님이 뒤집었어요`;
    this.nextTurn(this.turn, now);
    this.checkStalemate();
  }
  eliminate(players) {
    if (!players.length) return;
    this.eliminationWave++;
    players.forEach(p => { p.status = 'out'; p.eliminatedAt = this.eliminationWave; });
  }
  ring(id, now = Date.now()) {
    const p = this.players.find(p => p.id === id);
    if (this.phase !== 'playing' || !p || p.status === 'out') throw new Error('지금은 종을 누를 수 없어요.');
    const right = this.canRing();
    if (right) {
      const won = this.players.flatMap(p => p.open.splice(0));
      p.deck.push(...won); p.status = 'active'; p.hits++;
      this.eliminate(this.players.filter(other => other.id !== id && other.status === 'recovering' && !other.deck.length));
      this.turn = this.players.indexOf(p); this.deadline = now + 10000; this.clearHolds();
      this.notice = `${p.nickname}님 정답 · ${won.length}장 가져감`;
    } else {
      p.misses++;
      if (!p.deck.length) this.eliminate([p]);
      else {
        const index = this.players.indexOf(p);
        for (let step = 1; step < this.players.length && p.deck.length; step++) {
          const other = this.players[(index + step) % this.players.length];
          if (other.status === 'out') continue;
          other.deck.push(p.deck.shift()); other.status = 'active';
        }
        if (!p.deck.length) p.status = 'recovering';
      }
      this.notice = `${p.nickname}님 오답 · 한 장씩 나눠 줌`;
      if (this.turn < 0 || !this.players[this.turn]?.deck.length) this.nextTurn(this.turn < 0 ? this.players.indexOf(p) : this.turn, now);
    }
    this.version++;
    this.lastRing = { id: p.id, nickname: p.nickname, color: p.color ?? p.seat, ok: right, version: this.version };
    this.checkEnd();
    this.checkStalemate();
  }
  // A player left mid-game: their cards (deck and open pile) and their turn go away; the rest play on.
  // With one player (or none) left the game ends and the last one standing wins.
  removePlayer(id, now = Date.now()) {
    const index = this.players.findIndex(p => p.id === id);
    if (index < 0 || this.phase === 'finished') return false;
    const [gone] = this.players.splice(index, 1);
    this.version++;
    this.departures.push({ id: gone.id, nickname: gone.nickname, version: this.version });
    this.notice = `${gone.nickname}님이 나갔어요`;
    if (this.starter > index) this.starter--;
    else if (this.starter === index) this.starter = this.players.length ? index % this.players.length : 0;
    if (this.turn > index) this.turn--;
    else if (this.turn === index) {
      // the next player clockwise takes the turn
      if (this.phase === 'playing') this.nextTurn((index - 1 + this.players.length) % Math.max(1, this.players.length), now);
      else this.turn = this.starter;
    }
    const survivors = this.players.filter(p => p.status !== 'out');
    if (survivors.length <= 1) {
      this.notice = survivors.length ? `${gone.nickname}님이 나가 ${survivors[0].nickname}님 우승` : `${gone.nickname}님이 나가 게임 끝`;
      this.finish();
      return true;
    }
    if (this.phase === 'playing' && (this.turn < 0 || !this.players[this.turn]?.deck.length)) this.nextTurn(Math.max(0, this.turn), now);
    this.checkStalemate();
    return true;
  }
  checkEnd() {
    const survivors = this.players.filter(p => p.status !== 'out');
    if ((this.settings.ending === 'first' && this.players.some(p => p.status === 'out')) || survivors.length <= 1) this.finish();
  }
  checkStalemate() {
    if (this.phase === 'playing' && this.players.every(p => !p.deck.length) && !this.canRing()) {
      this.draw = true; this.notice = '낼 카드가 없어 무승부'; this.finish();
    }
  }
  finish() {
    this.phase = 'finished'; this.deadline = null; this.clearHolds();
    const sorted = [...this.players].sort((a, b) => {
      if (a.status !== 'out' && b.status === 'out') return -1;
      if (a.status === 'out' && b.status !== 'out') return 1;
      return a.status === 'out' ? b.eliminatedAt - a.eliminatedAt : b.deck.length - a.deck.length;
    });
    let previousKey, rank;
    this.results = sorted.map((p, i) => {
      const key = p.status === 'out' ? `out:${p.eliminatedAt}` : `live:${p.deck.length}`;
      if (key !== previousKey) rank = i + 1;
      previousKey = key;
      return { id: p.id, nickname: p.nickname, cards: p.deck.length, rank: this.draw ? 1 : rank, winner: !this.draw && rank === 1, hits: p.hits, misses: p.misses };
    });
  }
  act(id, action, actionId, version, now = Date.now()) {
    if (typeof actionId !== 'string' || actionId.length > 100 || !actionId) throw new Error('잘못된 입력 ID예요.');
    const key = `${id}:${actionId}`;
    if (this.actions.has(key)) return this.actions.get(key);
    if (version !== this.version) return { stale: true };
    if (action === 'flip') this.flip(id, now);
    else if (action === 'ring') this.ring(id, now);
    else throw new Error('지원하지 않는 동작이에요.');
    const result = { ok: true, version: this.version };
    this.actions.set(key, result);
    if (this.actions.size > 2000) this.actions.delete(this.actions.keys().next().value);
    return result;
  }
  // Card counts are private: each viewer sees only their own until the game is over. Everyone sees how thick
  // each deck looks (stack: a rough level, 3 cards a step), like on a real table.
  snapshot(viewerId = null) {
    const reveal = id => this.phase === 'finished' || id === viewerId;
    return {
      id: this.id, version: this.version, phase: this.phase, turn: this.turn, starter: this.starter,
      createdAt: this.createdAt, announceAt: this.announceAt, startsAt: this.startsAt, deadline: this.deadline,
      notice: this.notice, results: this.results, draw: this.draw, departures: this.departures, lastRing: this.lastRing,
      players: this.players.map(({ deck, open, holding, ...p }, i) => ({ ...p, cards: reveal(p.id) ? deck.length : null, stack: stackLevel(deck.length), holding: !!holding && this.phase === 'playing' && i === this.turn, openCount: open.length, top: open.at(-1) ?? null })),
    };
  }
}
