import { randomInt, randomUUID } from 'node:crypto';

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
    this.players = players.map(p => ({ ...p, deck: [], open: [], status: 'active', hits: 0, misses: 0, eliminatedAt: null }));
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
    this.notice = '모두 준비 완료! 시작 플레이어를 뽑고 있어요.';
    this.results = [];
    this.draw = false;
    this.actions = new Map();
    this.eliminationWave = 0;
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
      this.phase = 'playing'; this.notice = `${this.players[this.turn].nickname}님부터 시작합니다!`; return true;
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
        this.turn = index; this.deadline = now + 10000; return;
      }
    }
    this.turn = -1;
    this.deadline = null;
  }
  flip(id, now = Date.now()) {
    const p = this.players[this.turn];
    if (this.phase !== 'playing' || !p || p.id !== id || !p.deck.length) throw new Error('지금은 카드를 뒤집을 수 없어요.');
    p.open.push(p.deck.shift());
    if (!p.deck.length) p.status = 'recovering';
    this.version++;
    this.notice = `${p.nickname}님이 카드를 뒤집었어요.`;
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
    if (this.canRing()) {
      const won = this.players.flatMap(p => p.open.splice(0));
      p.deck.push(...won); p.status = 'active'; p.hits++;
      this.eliminate(this.players.filter(other => other.id !== id && other.status === 'recovering' && !other.deck.length));
      this.turn = this.players.indexOf(p); this.deadline = now + 10000;
      this.notice = `${p.nickname}님 정답! ${won.length}장을 가져갔어요.`;
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
      this.notice = `${p.nickname}님 오답! 다른 플레이어에게 카드 한 장씩 지급해요.`;
      if (this.turn < 0 || !this.players[this.turn]?.deck.length) this.nextTurn(this.turn < 0 ? this.players.indexOf(p) : this.turn, now);
    }
    this.version++;
    this.checkEnd();
    this.checkStalemate();
  }
  checkEnd() {
    const survivors = this.players.filter(p => p.status !== 'out');
    if ((this.settings.ending === 'first' && this.players.some(p => p.status === 'out')) || survivors.length <= 1) this.finish();
  }
  checkStalemate() {
    if (this.phase === 'playing' && this.players.every(p => !p.deck.length) && !this.canRing()) {
      this.draw = true; this.notice = '뒤집을 카드와 정답 조건이 없어 무승부로 종료했어요.'; this.finish();
    }
  }
  finish() {
    this.phase = 'finished'; this.deadline = null;
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
  snapshot() {
    return {
      id: this.id, version: this.version, phase: this.phase, turn: this.turn, starter: this.starter,
      createdAt: this.createdAt, announceAt: this.announceAt, startsAt: this.startsAt, deadline: this.deadline,
      notice: this.notice, results: this.results, draw: this.draw,
      players: this.players.map(({ deck, open, ...p }) => ({ ...p, cards: deck.length, openCount: open.length, top: open.at(-1) ?? null })),
    };
  }
}
