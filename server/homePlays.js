// Tells the homepage when a game ends, for the admin page's 플레이 기록 (wodnjs.com_Web README "로그").
// Local call with the shared secret; a failure only costs that one log line, never the game.
const defaultUrl = () => process.env.HOME_PLAYS_URL
  || (process.env.HOME_AUTH_URL || 'http://127.0.0.1:8080/api/auth/me').replace(/\/api\/auth\/me$/, '/api/internal/plays');

export function createPlayReporter({ url = defaultUrl(), token = process.env.INTERNAL_TOKEN ?? '', fetchImpl = fetch } = {}) {
  if (!token) return async () => {};
  return async play => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token }, body: JSON.stringify(play), signal: AbortSignal.timeout(3000) });
        if (res.ok || res.status < 500) return;              // 4xx: retrying would not help
      } catch { /* homepage restarting: try once more */ }
      await new Promise(r => setTimeout(r, 2000));
    }
    console.error('플레이 기록 전송 실패:', play.gameId);
  };
}

// one finished table → the homepage's play record
export function playReport(room, now = Date.now()) {
  const g = room.game, s = room.settings;
  const bots = new Set(room.game.players.filter(p => p.bot).map(p => p.id));
  const winners = g.results.filter(r => r.winner).map(r => r.nickname);
  return {
    game: 'haligali', gameId: g.id, room: room.name,
    mode: [s.mode === 'original' ? '원본 56장' : `한 명당 ${s.cards}장`, s.ending === 'first' ? '첫 탈락 시 종료' : '마지막 1명까지', bots.size ? '봇 포함' : null].filter(Boolean).join(' · '),
    startedAt: Math.min(g.startsAt ?? g.createdAt, now), endedAt: now,
    result: g.draw ? '무승부' : winners.length ? `${winners.join(', ')} 승리` : null,
    reason: g.draw ? g.notice : g.players.length < 2 || g.results.length < 2 ? '상대가 모두 나감' : s.ending === 'first' ? '한 명이 카드를 모두 잃음' : '마지막 한 명이 남음',
    moves: null,
    players: g.results.map(r => ({ id: r.id, nickname: r.nickname, team: bots.has(r.id) ? '봇' : null, result: g.draw ? 'draw' : r.winner ? 'win' : 'loss', score: r.cards })),
  };
}
