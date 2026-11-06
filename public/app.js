import { seatGeometry, flipKeyframes, liftKeyframes, labelTurn, stackLevel, detectCollection, collectionKeyframes, NAME_COLORS } from './table-layout.js';
const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const fruitNames = { strawberry: '딸기', banana: '바나나', lime: '라임', plum: '자두' };
const fruits = Object.keys(fruitNames);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fruit = (name, cls = '') => `<svg class="${cls}" aria-hidden="true" viewBox="0 0 100 100"><use href="./fruit.svg#${name}"></use></svg>`;
const paths = {
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5"/>',
  arrow: '<path d="m7 17 10-10M7 7h10v10"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H4l-3 3V11a10 10 0 0 1 20 0ZM7 10h10M7 14h6"/>',
  trophy: '<path d="M8 3h8v5a4 4 0 0 1-8 0V3ZM8 5H4v3a4 4 0 0 0 4 4M16 5h4v3a4 4 0 0 1-4 4M12 12v7M8 21h8M9 19h6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3c-1 0-1 1-1 2M12 17h.01"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  logout: '<path d="M9 4H4v16h5M13 8l4 4-4 4M9 12h12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  spark: '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.spark}</svg>`; }
const bellArt = () => '<img src="./silver-bell.svg" alt="" draggable="false">';
let state = null, stream, gate = 'checking', busy = false, connected = true, offset = 0;
let paused = localStorage.getItem('hg-paused') === 'yes';
let sound = localStorage.getItem('hg-sound') === 'yes';
let audioContext, lastNotice, toastTimer, lastRoom = null, lastPhase, composing = false, renderPending = false;
const drafts = { global: '', room: '' };
const activeFlips = new Map();
let activeCollection = null, collectionTimer;
const seenCollections = new Set();
const seenDepartures = new Set();
let activeRing = null, seenRing = null;   // the hand on the bell
// Holding my deck: the top card stays lifted until I let go on the deck (flip) or drag off it (put back).
let myHold = null;            // { startedAt, pointerId, rect, sent } while I press my deck
const lifts = new Map();      // playerId → { startedAt, down } : a held card going up, or (down) going back
const LIFT_MS = 170;
let celebrated = null;   // the game I last showed winner fireworks for
function background() {
  $('#background').innerHTML = Array.from({ length: 12 }, (_, i) => {
    const seed = crypto.getRandomValues(new Uint32Array(3));
    return `<div class="floating-fruit" style="left:${seed[0] % 100}%;top:${seed[1] % 100}%;width:${55 + seed[2] % 65}px;height:${55 + seed[2] % 65}px;--duration:${(12 + i % 6) / 3}s;--delay:-${i * 2 / 3}s;--rotation:${i * 37}deg">${fruit(fruits[i % 4])}</div>`;
  }).join('');
  document.body.classList.toggle('paused', paused);
}
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}
// Login is on the homepage (wodnjs.com). Signed-out visitors go there and come back here afterwards.
const HOME = '/';
function homeLogin() {
  stream?.close(); state = null;
  location.assign(`${HOME}?login=1&next=${encodeURIComponent(location.pathname + location.search)}`);
}
async function api(path, data) {
  const response = await fetch(`./api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) homeLogin();
    const error = new Error(result.error ?? '서버에 연결할 수 없어요.'); error.status = response.status;
    throw error;
  }
  return result;
}
// at most one automatic reload per new build, so a stubborn cache can never make the page reload over and over
function reloadOnce(build) {
  try { if (sessionStorage.getItem('hg-reloaded') === build) return false; sessionStorage.setItem('hg-reloaded', build); } catch { return false; }
  return true;
}
function accept(next) {
  // the server now hands out newer screen files than this page was loaded with: load them (the game itself lives on the server)
  if (state?.build && next.build && state.build !== next.build && reloadOnce(next.build)) { stream?.close(); location.reload(); return; }
  const previousGame = state?.room?.game, nextGame = next.room?.game;
  if (previousGame?.id !== nextGame?.id) {
    activeFlips.clear(); activeCollection = null; clearTimeout(collectionTimer); seenCollections.clear();
    // departures from before this page saw the game (reload, reconnect) need no pop-up
    seenDepartures.clear(); nextGame?.departures?.forEach(d => seenDepartures.add(`${nextGame.id}:${d.version}`));
  }
  // a new bell hit (not one from before this page saw the game): show that player's hand on the bell
  const ring = nextGame?.lastRing;
  if (ring && previousGame?.id === nextGame.id && !matchMedia('(prefers-reduced-motion: reduce)').matches && seenRing !== `${nextGame.id}:${ring.version}`) activeRing = { ...ring, startedAt: Date.now() };
  if (ring) seenRing = `${nextGame.id}:${ring.version}`;
  const collection = detectCollection(previousGame, nextGame);
  if (collection && !seenCollections.has(collection.id) && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    seenCollections.add(collection.id);
    if (seenCollections.size > 128) seenCollections.delete(seenCollections.values().next().value);
    activeCollection = { ...collection, startedAt: Date.now() }; activeFlips.clear();
  }
  if (previousGame && nextGame?.id === previousGame.id && nextGame.phase === 'playing') {
    for (const player of nextGame.players) {
      const previous = previousGame.players.find(p => p.id === player.id);
      if (player.top && previous && player.top.id !== previous.top?.id && player.openCount === previous.openCount + 1) {
        // keep showing the old top card until the flying card lands, so the new card is never seen early
        // a card that was held up flies on from there
        const lifted = player.id === next.me?.id ? !!myHold : !!previous.holding;
        activeFlips.set(player.id, { card: player.top, before: previous.top, beforeCount: previous.openCount, startedAt: Date.now(), lifted });
        lifts.delete(player.id);
        if (player.id === next.me?.id) myHold = null;
      } else {
        if (!player.top) activeFlips.delete(player.id);
        // someone else picked their card up, or put it back
        if (player.id !== next.me?.id && !!player.holding !== !!previous.holding) liftStart(player.id, !player.holding);
      }
    }
  }
  // my turn is over (a bell, the timer, the game ended) while I was still pressing: the card goes back
  if (myHold && !(nextGame?.phase === 'playing' && nextGame.players[nextGame.turn]?.id === next.me?.id)) { myHold = null; liftStart(next.me.id, true); }
  const departed = (nextGame?.departures ?? []).filter(d => d.id !== next.me?.id && !seenDepartures.has(`${nextGame.id}:${d.version}`));
  state = next; offset = next.serverTime - Date.now();
  const game = state.room?.game;
  if (game?.notice && game.notice !== lastNotice && ['playing', 'finished'].includes(game.phase)) {
    if (game.notice.includes('정답 ·')) chime();
    lastNotice = game.notice;
  }
  render();
  for (const d of departed) { seenDepartures.add(`${game.id}:${d.version}`); showDeparture(d, game); }
  // I won: fireworks (once per game, only when I saw the game end here, not after a reload)
  if (game?.phase === 'finished' && previousGame?.id === game.id && previousGame.phase !== 'finished' && celebrated !== game.id
    && game.results.some(r => r.winner && r.id === state.me.id)) {
    celebrated = game.id;
    const wait = activeCollection ? Math.max(0, 1500 - (Date.now() - activeCollection.startedAt)) : 0;
    setTimeout(() => celebrate(game.id), wait);
  }
}
// ── winner fireworks ──
function celebrate(gameId) {
  if (state?.room?.game?.id !== gameId) return;
  const dialog = $('#left-dialog');
  if (dialog.open) { dialog.addEventListener('close', () => celebrate(gameId), { once: true }); return; }
  const layer = document.createElement('div');
  layer.className = 'fireworks'; layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = '<canvas></canvas><div class="win-banner">우승!</div>';
  document.body.append(layer);
  const done = () => layer.remove();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setTimeout(done, 2600); return; }
  const canvas = layer.querySelector('canvas'), ctx = canvas.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
  const size = () => { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; };
  size(); addEventListener('resize', size);
  const colors = [...NAME_COLORS, '#ffe390', '#ff6f5e', '#ffffff'];
  const sparks = [], start = performance.now(), DURATION = 3800;
  let nextBurst = 0, last = start;
  const burst = () => {
    const x = innerWidth * (.18 + Math.random() * .64), y = innerHeight * (.15 + Math.random() * .4);
    const color = colors[Math.floor(Math.random() * colors.length)], n = 46 + Math.floor(Math.random() * 24), speed = 2.2 + Math.random() * 1.8;
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + Math.random() * .2, v = speed * (.55 + Math.random() * .45);
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: .011 + Math.random() * .009, color: Math.random() < .2 ? '#ffffff' : color });
    }
  };
  const frame = now => {
    if (!layer.isConnected) return removeEventListener('resize', size);
    const t = now - start, step = Math.min(3, (now - last) / 16.7); last = now;
    if (t < DURATION - 900 && t >= nextBurst) { burst(); if (Math.random() < .35) burst(); nextBurst = t + 260 + Math.random() * 260; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.x += p.vx * step; p.y += p.vy * step; p.vy += .045 * step; p.vx *= .985 ** step; p.vy *= .985 ** step; p.life -= p.decay * step;
      if (p.life <= 0) { sparks.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, p.life * 1.4); ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.8 + p.life * 2.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (t < DURATION || sparks.length) requestAnimationFrame(frame);
    else { removeEventListener('resize', size); done(); }
  };
  requestAnimationFrame(frame);
}
// Someone left mid-game: say so; when only one player is left, say who won.
function showDeparture(d, game) {
  const dialog = $('#left-dialog');
  const winner = game.phase === 'finished' && !game.draw ? game.results.find(r => r.winner) : null;
  $('#left-title').textContent = `${d.nickname}님이 게임에서 나갔어요`;
  $('#left-body').textContent = game.phase === 'finished'
    ? winner ? `혼자 남아 게임이 끝났어요. ${winner.nickname}님 우승` : '게임이 끝났어요.'
    : '그 사람 카드와 차례는 빠졌어요.';
  if (!dialog.open) dialog.showModal();
}
function connect() {
  stream?.close(); stream = new EventSource('./api/events');
  stream.onmessage = event => { connected = true; accept(JSON.parse(event.data)); };
  stream.addEventListener('signedOut', () => homeLogin());
  stream.onopen = () => { connected = true; updateConnection(); };
  stream.onerror = () => { connected = false; updateConnection(); };
}
function updateConnection() {
  document.querySelectorAll('.connection').forEach(el => {
    el.classList.toggle('offline', !connected); el.innerHTML = `<i class="dot"></i>${connected ? '서버 연결됨' : '재연결 중'}`;
  });
}
function chime() {
  if (!sound) return;
  try {
    audioContext ??= new AudioContext(); audioContext.resume();
    [880, 1320].forEach((freq, i) => {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain(), now = audioContext.currentTime + i * .045;
      oscillator.type = 'sine'; oscillator.frequency.value = freq;
      gain.gain.setValueAtTime(.09, now); gain.gain.exponentialRampToValueAtTime(.001, now + .5);
      oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(now); oscillator.stop(now + .5);
    });
  } catch { /* Audio is optional. */ }
}
// 왼쪽 위: 홈페이지(JAEWON 메인)로 돌아가기
let leaveToHome = false;
function leaveLabels(title, button) { $('#leave-title').textContent = title; $('#confirm-leave').textContent = button; }
function siteHome() { return `<a class="icon-button site-home" href="${HOME}" data-do="site-home" aria-label="홈페이지로 돌아가기" title="홈페이지로">${icon('home')}</a>`; }
function brand() { return `<a class="brand" href="./" aria-label="할리갈리 홈"><span class="brand-mark">${icon('bell')}</span><span class="brand-name">halli<span>galli.</span></span></a>`; }
function header(auth = false) {
  return `<header class="topbar"><div class="header-left">${siteHome()}${brand()}</div><nav class="top-actions" aria-label="설정"><button class="text-button" data-do="rules" aria-label="게임 방법">${icon('help')}<span>게임 방법</span></button><button class="text-button" data-do="motion" aria-label="배경 애니메이션 ${paused ? '재생' : '일시정지'}">${icon(paused ? 'play' : 'pause')}<span>${paused ? '배경 재생' : '배경 멈추기'}</span></button>${auth ? '' : `<button class="text-button" data-do="sound" aria-label="소리 ${sound ? '끄기' : '켜기'}" aria-pressed="${sound}"><span>소리 ${sound ? '켜짐' : '꺼짐'}</span>${icon('bell')}</button><div class="profile"><span class="avatar c1">${escape(state.me.nickname[0])}</span><strong>${escape(state.me.nickname)}</strong><button class="text-button" data-do="logout" aria-label="로그아웃">${icon('logout')}</button></div>`}</nav></header>`;
}
function footer(auth = false) { if (auth) return ''; return `<footer class="page-foot"><span class="runtime-badge">${state.debug ? 'DEBUG · 기록 미반영' : 'ONLINE'}</span><span class="connection"><i class="dot"></i>서버 연결됨</span></footer>`; }
function authPage() {
  const text = gate === 'offline'
    ? { title: '로그인 서버에 연결할 수 없어요', body: '잠시 후 다시 시도해주세요.', button: `<button type="button" class="button primary wide" data-do="retry">다시 시도 ${icon('arrow')}</button>` }
    : gate === 'signedout'
      ? { title: '로그인이 필요해요', body: '할리갈리는 wodnjs.com 홈페이지 계정으로 들어와요.', button: `<button type="button" class="button primary wide" data-do="home-login">홈페이지에서 로그인 ${icon('arrow')}</button>` }
      : { title: '로그인 확인 중…', body: '잠시만 기다려주세요.', button: '' };
  return `<div class="auth-header">${header(true)}</div><main id="main" class="auth-layout"><section class="auth-visual" aria-label="할리갈리 과일 카드와 종 일러스트"><h1 class="sr-only">할리갈리</h1><img src="./login-art.svg" width="620" height="580" alt="딸기, 바나나, 라임 카드와 황금색 종으로 꾸민 할리갈리 테이블"></section><section class="glass auth-panel" aria-labelledby="auth-title" aria-live="polite"><h2 id="auth-title">${text.title}</h2><p>${text.body}</p><div class="auth-actions">${text.button}</div></section></main><div class="app-shell">${footer(true)}</div>`;
}
function avatar(name, index = 0, color) { return `<span class="avatar c${index % 4}"${Number.isInteger(color) ? ` style="background:${NAME_COLORS[color % NAME_COLORS.length]};color:#3a3126"` : ''}>${escape(name[0])}</span>`; }
function leaderboard() {
  const ranking = state.ranking;
  return `<section class="leaderboard glass" aria-labelledby="ranking-title"><div class="section-heading"><div class="section-title">${icon('trophy')}<h3 id="ranking-title">전체 랭킹</h3></div></div>${ranking.length ? `<div class="leaders">${ranking.slice(0, 3).map((u, i) => `<div class="leader"><span class="place">${i + 1}</span>${avatar(u.nickname, i)}<div class="details"><strong>${escape(u.nickname)}</strong><small>승률 ${Math.round(u.wins / u.played * 100)}%</small></div><span class="score">${u.wins}승</span></div>`).join('')}<div class="leader my-rank"><div class="details"><strong>나의 기록</strong><small>${state.debug ? '디버그 경기는 집계하지 않아요' : `${state.me.wins}승 · ${state.me.played}판`}</small></div></div></div>` : `<div class="rank-empty">${icon('trophy')}<div><p>랭킹 기록 없음</p></div></div>`}</section>`;
}
function chatPanel(channel) {
  const messages = channel === 'global' ? state.messages : state.room.messages;
  return `<section class="glass panel chat-panel" aria-label="${channel === 'global' ? '전체' : '룸'} 채팅"><div class="panel-header section-heading"><div class="section-title">${icon('chat')}<h3>${channel === 'global' ? '전체 채팅' : '룸 채팅'}</h3></div><span class="count">${channel === 'global' ? state.online.length : state.room.players.length}</span></div><div class="chat-body" data-chat="${channel}" role="log" aria-label="채팅 메시지">${messages.length ? messages.map(m => `<div class="chat-msg ${m.system ? 'system' : ''}${Number.isInteger(m.color) ? ' colored' : ''}"${Number.isInteger(m.color) ? ` style="--name-bg:${NAME_COLORS[m.color % NAME_COLORS.length]}"` : ''}><div class="chat-meta"><strong>${escape(m.nickname)}</strong><time>${new Date(m.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></div><p>${escape(m.text)}</p></div>`).join('') : `<div class="chat-empty">${icon('chat')}<span>메시지 없음</span></div>`}</div><form class="chat-form" data-channel="${channel}"><label class="sr-only" for="chat-${channel}">메시지</label><input id="chat-${channel}" name="message" autocomplete="off" maxlength="200" placeholder="메시지를 입력하세요" value="${escape(drafts[channel])}" required><button type="submit" aria-label="메시지 보내기">${icon('send')}</button></form></section>`;
}
function presencePanel(room = false) {
  const players = room ? state.room.players : state.online;
  const game = state.room?.game;
  return `<aside class="glass panel presence" aria-label="${room ? '입장 플레이어' : '현재 접속자'}"><div class="panel-header section-heading"><div class="section-title">${icon('people')}<h3>${room ? '플레이어' : '접속자'}</h3></div><span class="count">${players.length}${room ? `/${state.room.settings.max}` : ''}</span></div><div class="player-list">${players.map((p, i) => {
    const gp = game?.players.find(g => g.id === p.id);
    const label = room ? gp ? gp.status === 'out' ? '탈락' : gp.status === 'recovering' ? '복귀 대기' : '게임중' : p.ready ? '준비 완료' : '준비중' : p.status;
    return `<div class="player-row">${avatar(p.nickname, i, room ? p.color : undefined)}<div class="person"><strong>${escape(p.nickname)}${p.id === state.me.id ? ' <small>나</small>' : ''}</strong><small>${room ? `${i + 1}번 좌석${p.id === state.room.host ? ' · 방장' : ''}${p.bot ? ' · BOT' : p.online ? '' : ' · 연결 끊김'}` : ''}</small></div><span class="status ${label === '게임중' ? 'playing' : ''}">${escape(label)}</span></div>`;
  }).join('')}</div>${room ? `${state.debug ? `<div class="debug-note">${state.room.host === state.me.id ? `<button class="button secondary" data-do="bot" ${players.length >= state.room.settings.max || (game && game.phase !== 'finished') ? 'disabled' : ''}>${icon('plus')} 테스트 봇 추가</button>` : ''}</div>` : ''}` : ``}</aside>`;
}
const endingLabel = ending => ending === 'first' ? '첫 탈락 시 종료' : '마지막 1명까지';
function roomCard(room, i) {
  const playing = !['waiting', 'finished'].includes(room.phase), full = room.count >= room.settings.max;
  return `<article class="room-card glass"><div class="room-illustration">${fruit(fruits[i % 4])}</div><div class="room-info"><span class="pill"><i class="dot ${playing ? 'playing' : ''}"></i>${playing ? '게임중' : '대기중'}</span><h3>${escape(room.name)}</h3><div class="room-tags"><span>${room.settings.mode === 'original' ? '원본 56장' : `한 명당 ${room.settings.cards}장`}</span><span>${endingLabel(room.settings.ending)}</span></div></div><div class="room-join"><small>${room.count} / ${room.settings.max}명</small><button class="button secondary" data-join="${room.id}" ${playing || full ? 'disabled' : ''}>${playing ? '진행중' : full ? '가득 참' : '입장하기'}</button></div></article>`;
}
function lobbyPage() {
  return `<div class="app-shell">${header()}<main id="main"><div class="welcome-row"><div><h1>로비</h1></div><span class="pill"><i class="dot"></i>접속 ${state.online.length}명</span></div>${leaderboard()}<div class="lobby-grid">${chatPanel('global')}<section class="center-content"><div class="section-heading room-heading"><div class="section-title"><h2>열려 있는 테이블</h2><span class="pill">${state.rooms.length}</span></div><button class="button primary" data-do="create">${icon('plus')} 방 만들기</button></div><div class="room-list">${state.rooms.length ? state.rooms.map(roomCard).join('') : `<div class="glass empty-rooms"><div class="table-art">${fruit('strawberry')}${fruit('banana')}${fruit('lime')}</div><p>생성된 방 없음</p><button class="button secondary" data-do="create">방 만들기 ${icon('arrow')}</button></div>`}</div></section>${presencePanel()}</div></main>${footer()}</div>`;
}
// A pile is drawn as a stack of card edges: more cards, a thicker stack (--sheet is the edge step, smaller on phones).
function stackStyle(count) { return layerStyle(stackLevel(count)); }
function layerStyle(layers) {
  const shadows = [];
  for (let i = 1; i < layers; i++) {
    shadows.push(`0 calc(var(--sheet) * ${i}) 0 -.5px #fffdf8`, `0 calc(var(--sheet) * ${i} + .7px) 0 -.5px #a9a79d`);
  }
  shadows.push(`0 calc(var(--sheet) * ${layers} + 4px) 9px #001f1666`);
  return `--pile-shadow:${layers ? shadows.join(',') : 'none'};--layers:${layers}`;
}
function cardFace(card) {
  if (!card) return '';
  const placements = { 1: [[50,50]], 2: [[27,24],[73,76]], 3: [[25,20],[50,50],[75,80]], 4: [[25,23],[75,23],[25,77],[75,77]], 5: [[25,20],[75,20],[50,50],[25,80],[75,80]] };
  return `<div class="card-fruits n${card.count}">${placements[card.count].map(([x,y]) => `<span style="--fruit-x:${x}%;--fruit-y:${y}%">${fruit(card.fruit)}</span>`).join('')}</div>`;
}
// Seats are turned so that my seat is always at 6 o'clock; the order stays clockwise.
function seatIndex(players) {
  const mine = Math.max(0, players.findIndex(p => p.id === state.me.id));
  return i => (i - mine + players.length) % players.length;
}
function pileMarkup(p, top = p.top, openCount = p.openCount ?? 0) {
  return `<div class="playing-card ${top ? 'card-front card-stack' : 'empty-pile'}" style="${stackStyle(openCount)}" role="img" aria-label="${top ? `${escape(p.nickname)}: ${fruitNames[top.fruit]} ${top.count}개, 공개 더미 ${openCount}장` : '공개 카드 없음'}">${cardFace(top)}</div>`;
}
function seats() {
  const r = state.room, g = r.game, players = g?.players ?? r.players, visual = seatIndex(players);
  return players.map((p, i) => {
    const geometry = seatGeometry(visual(i), players.length);
    const { x, y, dx, dy, rotation } = geometry;
    const seat = p.seat ?? i, color = p.color ?? seat, mine = p.id === state.me.id;
    const dealt = r.settings.mode === 'original' ? Math.floor(56 / players.length) + (i < 56 % players.length ? 1 : 0) : r.settings.cards;
    const count = !mine ? null : g ? p.cards : dealt;
    const layers = mine ? stackLevel(count) : g ? p.stack ?? 0 : stackLevel(dealt);   // others: only how thick it looks
    const hasCards = layers > 0;
    const current = g?.phase === 'playing' && g.turn === i;
    const canFlip = mine && current && count > 0;
    const tag = mine ? 'button' : 'div';
    const flip = activeFlips.get(p.id), flying = flip && Date.now() - flip.startedAt < 520;
    const tagStatus = !g ? p.ready ? '준비 완료' : '준비중' : p.status === 'out' ? '탈락' : p.status === 'recovering' && !mine ? '종으로 복귀 가능' : '';
    const status = g && mine && p.status !== 'out' ? `내 카드 <strong>${count}</strong>장` : '';
    const label = labelTurn(rotation);
    return `<div class="seat ${mine ? 'mine' : ''} ${current ? 'current' : ''} ${p.status === 'out' ? 'out' : ''} ${activeCollection?.winnerId === p.id ? 'collection-winner' : ''}" style="--x:${x}%;--y:${y}%;--radial-x:${dx};--radial-y:${dy};--seat-rotation:${rotation}deg;--name-bg:${NAME_COLORS[color % NAME_COLORS.length]};--label-angle:${label.angle}deg" data-seat="${p.id}" data-x="${x}" data-y="${y}" data-dx="${dx}" data-dy="${dy}" data-rotation="${rotation}"><div class="seat-piles"><${tag} class="hidden-deck card-stack ${hasCards ? 'card-back' : 'empty-deck'}" style="${layerStyle(layers)}" ${mine ? `type="button" data-do="flip" ${canFlip ? '' : 'disabled'} aria-label="내 비공개 카드 ${count}장${canFlip ? ', 누르고 있다가 떼면 뒤집기' : ''}"` : `role="img" aria-label="${escape(p.nickname)} 비공개 카드"`}><span class="deck-pattern" aria-hidden="true"></span></${tag}>${liftMarkup(p, mine)}${flying ? pileMarkup(p, flip.before, flip.beforeCount) : pileMarkup(p)}${flipMarkup(p.id)}</div><div class="seat-label${label.out < 0 ? ' flipped' : ''}"><div class="seat-name">${current ? '<span class="turn-tag">차례</span>' : ''}${seat + 1}. ${escape(p.nickname)}${mine ? ' <span class="me">나</span>' : ''}${tagStatus ? ` <span class="tag-status">${tagStatus}</span>` : ''}</div>${status ? `<div class="seat-status">${status}</div>` : ''}</div></div>`;
  }).join('');
}
// The hand of whoever hit the bell first, in their colour: it slaps down on the bell, then fades away.
const HAND_MS = 1100;
const HAND_SHAPES = '<rect x="40" y="108" width="50" height="62" rx="12"/><rect x="8" y="66" width="19" height="54" rx="9.5" transform="rotate(-34 22 112)"/><rect x="29" y="22" width="18" height="66" rx="9" transform="rotate(-9 38 84)"/><rect x="49" y="10" width="19" height="76" rx="9.5"/><rect x="69" y="16" width="18" height="70" rx="9" transform="rotate(7 78 84)"/><rect x="88" y="36" width="15" height="54" rx="7.5" transform="rotate(16 95 88)"/><rect x="26" y="60" width="78" height="70" rx="26"/>';
// a whole hand seen from above (nails, knuckles, thumb, wrist and cuff); fingers point at the bell
const handSvg = color => `<svg viewBox="-12 0 132 176" aria-hidden="true"><g fill="${color}" stroke="#3b2f22" stroke-width="7" stroke-linejoin="round">${HAND_SHAPES}</g><g fill="${color}">${HAND_SHAPES}</g><g fill="#ffffff8c"><rect x="32.5" y="25" width="11" height="13" rx="5" transform="rotate(-9 38 84)"/><rect x="53" y="13" width="11" height="13" rx="5"/><rect x="72.5" y="19" width="11" height="13" rx="5" transform="rotate(7 78 84)"/><rect x="90.5" y="39" width="10" height="11" rx="4.5" transform="rotate(16 95 88)"/><rect x="10.5" y="69" width="11" height="12" rx="5" transform="rotate(-34 22 112)"/></g><path d="M33 70q5 3 10 0M53 68q5 3 10 0M72 70q5 3 10 0M90 76q4 3 8 0" fill="none" stroke="#3b2f2259" stroke-width="2.4" stroke-linecap="round"/><rect x="36" y="150" width="58" height="24" rx="7" fill="#fffaf0" stroke="#3b2f22" stroke-width="3.5"/></svg>`;
function ringMarkup() {
  const r = activeRing;
  if (!r || Date.now() - r.startedAt >= HAND_MS) return '';
  return `<div class="hand-hit${r.ok ? '' : ' is-wrong'}" data-ring="${r.version}" data-player="${escape(r.id)}" aria-hidden="true">${handSvg(NAME_COLORS[(r.color ?? 0) % NAME_COLORS.length])}</div>`;
}
function playRing() {
  const el = document.querySelector('.hand-hit'), r = activeRing;
  if (!el || !r) return;
  const elapsed = Date.now() - r.startedAt;
  // the hand comes in from the hitter's side of the table (fingers toward the middle)
  const seat = document.querySelector(`.seat[data-seat="${CSS.escape(r.id)}"]`);
  const dx = seat ? +seat.dataset.dx : 0, dy = seat ? +seat.dataset.dy : 1, turn = seat ? +seat.dataset.rotation : 0;
  const at = (out, scale) => `translate(-50%,-50%) translate(${dx * out}px,${dy * out}px) rotate(${turn}deg) scale(${scale})`;
  el.animate([
    { transform: at(150, 1.35), opacity: 0, offset: 0 },
    { transform: at(26, 1.06), opacity: 1, offset: .2 },
    { transform: at(18, .94), opacity: 1, offset: .28 },
    { transform: at(20, 1), opacity: 1, offset: .55 },
    { transform: at(20, 1.02), opacity: 0, offset: 1 },
  ], { duration: HAND_MS, delay: -elapsed, easing: 'cubic-bezier(.25,.8,.3,1)', fill: 'both' });
  const bell = document.querySelector('.bell-control');
  if (bell && elapsed < 420) bell.animate([{ scale: 1 }, { scale: 1, offset: .45 }, { scale: .9, offset: .6 }, { scale: 1 }], { duration: 420, delay: -elapsed });
  setTimeout(() => { if (activeRing === r) { activeRing = null; document.querySelector(`.hand-hit[data-ring="${r.version}"]`)?.remove(); } }, Math.max(0, HAND_MS - elapsed));
}
// Arrow from the bell to whoever's turn it is.
let lastTurnAngle = null;
function turnArrow() {
  const g = state.room.game;
  if (g?.phase !== 'playing' || g.turn < 0 || !g.players[g.turn]) { lastTurnAngle = null; return ''; }
  const angle = 90 + seatIndex(g.players)(g.turn) * 360 / g.players.length;
  return `<div class="turn-arrow" style="--turn-angle:${angle}deg" data-angle="${angle}" aria-hidden="true"><span></span></div>`;
}
function playTurnArrow() {
  const el = document.querySelector('.turn-arrow'); if (!el) return;
  const angle = Number(el.dataset.angle);
  if (lastTurnAngle !== null && lastTurnAngle !== angle && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const turn = (angle - lastTurnAngle + 360) % 360;   // turns go clockwise
    el.animate([{ rotate: `${angle - turn}deg` }, { rotate: `${angle}deg` }], { duration: 320, easing: 'cubic-bezier(.3,.7,.3,1)' });
  }
  lastTurnAngle = angle;
}
// The held top card (mine while I press my deck; others' from the server), and one going back down.
function liftMarkup(p, mine) {
  const lift = lifts.get(p.id);
  const held = mine ? !!myHold : !!p.holding;
  if (held) return `<div class="lift-card card-back" data-lift="${escape(p.id)}" aria-hidden="true"><span class="deck-pattern"></span></div>`;
  if (lift?.down && Date.now() - lift.startedAt < LIFT_MS) return `<div class="lift-card card-back is-down" data-lift="${escape(p.id)}" aria-hidden="true"><span class="deck-pattern"></span></div>`;
  return '';
}
function playLifts() {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const el of document.querySelectorAll('.lift-card')) {
    const id = el.dataset.lift, lift = lifts.get(id), seat = el.closest('.seat');
    if (!lift || still) continue;
    const elapsed = Date.now() - lift.startedAt;
    if (elapsed >= LIFT_MS) { if (lift.down) el.remove(); continue; }
    const style = getComputedStyle(seat);
    const frames = liftKeyframes({ dx: +seat.dataset.dx, dy: +seat.dataset.dy, rotation: +seat.dataset.rotation }, parseFloat(style.getPropertyValue('--pile-offset')), parseFloat(style.getPropertyValue('--deck-scale')));
    const animation = el.animate(lift.down ? frames.reverse() : frames, { duration: LIFT_MS, delay: -elapsed, easing: lift.down ? 'cubic-bezier(.4,0,.7,.4)' : 'cubic-bezier(.2,.8,.3,1)', fill: 'both' });
    if (lift.down) animation.finished.then(() => el.remove()).catch(() => {});
  }
}
function liftStart(id, down) { lifts.set(id, { startedAt: Date.now(), down }); }
function flipMarkup(playerId) {
  const flip = activeFlips.get(playerId);
  if (!flip || Date.now() - flip.startedAt > 520) return '';
  return `<div class="flip-flight" data-flip="${playerId}" aria-hidden="true"><div class="flip-face flip-back card-back"><span class="deck-pattern"></span></div><div class="flip-face flip-front">${cardFace(flip.card)}</div></div>`;
}
function playCardFlips() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { activeFlips.clear(); return; }
  for (const element of document.querySelectorAll('.flip-flight')) {
    const seat = element.closest('.seat'), id = element.dataset.flip, flip = activeFlips.get(id);
    if (!flip) continue;
    const elapsed = Date.now() - flip.startedAt;
    const style = getComputedStyle(seat), offset = parseFloat(style.getPropertyValue('--pile-offset'));
    const frames = flipKeyframes({ dx: Number(seat.dataset.dx), dy: Number(seat.dataset.dy), rotation: Number(seat.dataset.rotation) }, offset, flip.lifted, parseFloat(style.getPropertyValue('--deck-scale')));
    const animation = element.animate(frames, { duration: 520, delay: -elapsed, easing: 'cubic-bezier(.35,.05,.3,1)', fill: 'both' });
    animation.finished.then(() => {
      // (a page redraw during the flight leaves an older copy of this flight off the page; it can finish first)
      if (activeFlips.get(id) === flip) activeFlips.delete(id);
      if (!element.isConnected) return;
      // the card has landed: now the pile shows it
      const player = state?.room?.game?.players.find(p => p.id === id), pile = seat.querySelector('.playing-card');
      if (!activeFlips.has(id) && player && pile) pile.outerHTML = pileMarkup(player);
      element.remove();
    }).catch(() => {});
  }
}
function collectionMarkup() {
  const event = activeCollection;
  if (!event || Date.now() - event.startedAt >= 1500) return '';
  return `<div class="collection-layer" data-collection="${event.id}" aria-hidden="true"><div class="collection-ring"></div><div class="collection-banner">${escape(event.winnerName)} <strong>+${event.total}장</strong></div>${event.piles.map((pile, index) => `<div class="collection-packet" data-source="${pile.index}" data-player="${escape(pile.playerId)}" data-order="${index}"><div class="collection-stack-sheets" style="${stackStyle(pile.count)}"></div><div class="collection-card collection-front">${cardFace(pile.top)}</div><div class="collection-card collection-back card-back"><span class="deck-pattern"></span></div></div>`).join('')}</div>`;
}
function playCollections() {
  clearTimeout(collectionTimer);
  const event = activeCollection, layer = document.querySelector('.collection-layer');
  if (!event || !layer) return;
  const elapsed = Date.now() - event.startedAt;
  // offsetWidth: the table's own size (it is scaled to fit the screen with a transform)
  const table = document.querySelector('.game-table'), size = table.offsetWidth;
  const offset = parseFloat(getComputedStyle(document.querySelector('.seat')).getPropertyValue('--pile-offset'));
  // where each seat sits on screen (seats are turned so mine is at the bottom)
  const at = id => { const el = document.querySelector(`.seat[data-seat="${CSS.escape(id)}"]`); return el && { x: +el.dataset.x, y: +el.dataset.y, dx: +el.dataset.dx, dy: +el.dataset.dy, rotation: +el.dataset.rotation }; };
  const winner = at(event.winnerId) ?? seatGeometry(event.winnerIndex, event.playerCount);
  for (const packet of layer.querySelectorAll('.collection-packet')) {
    const source = at(packet.dataset.player) ?? seatGeometry(Number(packet.dataset.source), event.playerCount);
    const duration = 1100, stagger = Number(packet.dataset.order) * 36;
    if (elapsed >= duration + stagger) { packet.remove(); continue; }
    const animation = packet.animate(collectionKeyframes(source, winner, size, offset), { duration, delay: stagger - elapsed, easing: 'cubic-bezier(.32,.02,.24,1)', fill: 'both' });
    animation.finished.then(() => packet.remove()).catch(() => {});
  }
  layer.querySelector('.collection-ring').animate([
    { transform: 'translate(-50%,-50%) scale(.5)', opacity: .85 },
    { transform: 'translate(-50%,-50%) scale(1.8)', opacity: 0 },
  ], { duration: 700, delay: -elapsed, fill: 'both', easing: 'ease-out' });
  const banner = layer.querySelector('.collection-banner');
  banner.animate([
    { opacity: 0, transform: 'translate(-50%,10px)' },
    { opacity: 1, transform: 'translate(-50%,0)', offset: .15 },
    { opacity: 1, transform: 'translate(-50%,0)', offset: .8 },
    { opacity: 0, transform: 'translate(-50%,-8px)' },
  ], { duration: 1500, delay: -elapsed, fill: 'both' });
  collectionTimer = setTimeout(() => {
    if (activeCollection !== event) return;
    activeCollection = null; layer.remove();
    document.querySelectorAll('.collection-winner').forEach(el => el.classList.remove('collection-winner'));
    if (state?.room?.game?.phase === 'finished') render();
  }, Math.max(0, 1500 - elapsed));
}
function waitingOverlay() {
  const r = state.room, g = r.game;
  if (!g) return `<div class="waiting-overlay"><h2>게임 준비</h2><p>${r.players.length < 2 ? '2명부터 시작할 수 있어요' : `준비 ${r.players.filter(p => p.ready).length} / ${r.players.length}`}</p><span class="pill">${endingLabel(r.settings.ending)}</span></div>`;
  if (g.phase === 'spinning') {
    // each slice has the player's own colour (the same as their name tag), the name sits in the middle of the slice,
    // and the wheel stops with the middle of the starter's slice under the pointer
    const slice = 360 / g.players.length;
    const colors = g.players.map((p, i) => NAME_COLORS[(p.color ?? p.seat ?? i) % NAME_COLORS.length]);
    return `<div class="waiting-overlay"><h2>첫 차례</h2><div class="wheel-pointer">▼</div><div class="wheel${g.players.length <= 4 ? ' few' : ''}" style="--stop:${1440 - (g.starter + .5) * slice}deg;animation-delay:-${Math.max(0, Date.now() + offset - g.createdAt)}ms;background:conic-gradient(${colors.map((c, i) => `${c} ${i * slice}deg ${(i + 1) * slice}deg`).join(',')})">${g.players.length > 1 ? g.players.map((p, i) => `<i class="wheel-line" style="--angle:${i * slice}deg"></i>`).join('') : ''}${g.players.map((p, i) => `<span style="--angle:${(i + .5) * slice}deg">${escape(p.nickname)}</span>`).join('')}</div></div>`;
  }
  return '';
}
function resultsOverlay() {
  const g = state.room.game;
  if (g?.phase !== 'finished' || (activeCollection && Date.now() - activeCollection.startedAt < 1500)) return '';
  return `<div class="results-overlay"><section class="results-panel" aria-label="게임 결과"><h2>${g.draw ? '이번 판은 무승부예요' : `${escape(g.results.filter(p => p.winner).map(p => p.nickname).join(', '))}님 우승!`}</h2>${g.draw ? `<p>${escape(g.notice)}</p>` : ''}<div class="result-list">${g.results.map(p => `<div class="result-row"><span>${p.rank}</span><strong>${escape(p.nickname)}</strong><small>정답 ${p.hits} · 오답 ${p.misses}</small><span>${p.cards}장</span></div>`).join('')}</div><p>${state.debug ? '디버그 · 기록 안 함' : '기록 저장됨'}</p><button class="button primary wide" data-do="ready">다시 하기 ${icon('arrow')}</button><button class="text-button" data-do="leave">로비로</button></section></div>`;
}
function gamePage() {
  const r = state.room, g = r.game, me = g?.players.find(p => p.id === state.me.id), waiting = !g;
  const canRing = g?.phase === 'playing' && me && me.status !== 'out';
  return `<div class="app-shell">${header()}<main id="main"><div class="room-top"><div><h1>${escape(r.name)}</h1><div class="room-tags"><span>${r.settings.mode === 'original' ? '원본 56장' : `한 명당 ${r.settings.cards}장`}</span><span>${endingLabel(r.settings.ending)}</span><span>${r.players.length}/${r.settings.max}명</span></div></div><button class="button secondary" data-do="leave">나가기 ${icon('logout')}</button></div><div class="game-layout">${chatPanel('room')}<section class="glass game-center" aria-label="게임판"><div class="table-meta"><div class="game-status">${g?.phase === 'playing' ? `<span class="pill"><i class="dot"></i>${g.turn >= 0 ? `${g.players[g.turn].id === state.me.id ? '내' : `${escape(g.players[g.turn].nickname)}님`} 차례` : '종 판정 대기'}</span><br><span id="turn-timer"></span>` : '<span class="pill">준비 시간</span>'}</div></div><div class="table-stage"><div class="game-table"><div class="table-ring"></div>${turnArrow()}${seats()}${collectionMarkup()}${ringMarkup()}<button class="bell-control" data-do="ring" ${canRing ? '' : 'disabled'} aria-label="종 누르기, 스페이스 키">${bellArt()}</button></div></div>${waitingOverlay()}${g?.phase === 'announcing' ? `<div class="start-popup" role="status">${escape(g.players[g.starter].nickname)}님부터</div>` : ''}<div class="game-controls"><p class="notice-bar" role="status">${escape(g?.notice ?? '모두 준비하면 시작해요')}</p><div class="controls-right"><button class="button secondary" data-do="rules" aria-label="게임 방법">${icon('help')}</button>${waiting ? `<button class="button primary ready-action ${r.players.find(p => p.id === state.me.id).ready ? 'is-ready' : ''}" data-do="ready" aria-pressed="${r.players.find(p => p.id === state.me.id).ready}">${r.players.find(p => p.id === state.me.id).ready ? '준비 취소' : '준비 완료'}</button>` : ''}</div></div>${resultsOverlay()}</section>${presencePanel(true)}</div></main>${footer()}</div>`;
}
function render() {
  if (composing) { renderPending = true; return; }
  renderPending = false;
  const focused = document.activeElement, focusedId = focused?.id;
  const selection = focused instanceof HTMLInputElement ? [focused.selectionStart, focused.selectionEnd] : null;
  const scrolls = {};
  document.querySelectorAll('[data-chat]').forEach(el => scrolls[el.dataset.chat] = { top: el.scrollTop, bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 60 });
  document.body.classList.toggle('in-game', !!state?.room);
  document.body.classList.toggle('paused', paused);
  app.innerHTML = state ? state.room ? gamePage() : lobbyPage() : authPage();
  fitTable(); updateConnection(); updateTimer(); playCardFlips(); playLifts(); playCollections(); playTurnArrow(); playRing();
  document.querySelectorAll('[data-chat]').forEach(el => { const old = scrolls[el.dataset.chat]; el.scrollTop = old && !old.bottom ? old.top : el.scrollHeight; });
  if (focusedId && document.getElementById(focusedId)) {
    const target = document.getElementById(focusedId); target.focus({ preventScroll: true });
    if (selection && target.type !== 'number') try { target.setSelectionRange(...selection); } catch { /* unsupported input type */ }
  }
  const roomId = state?.room?.id ?? null, phase = state?.room?.game?.phase;
  if (roomId !== lastRoom || (phase === 'finished' && lastPhase !== phase)) {
    $('#main')?.setAttribute('tabindex', '-1'); $('#main')?.focus({ preventScroll: true });
  }
  lastRoom = roomId; lastPhase = phase;
}
// The table keeps one shape at every screen size: the game area fills the window height (big screens get a big
// table, small screens a small one) and the table is scaled as a whole so nothing changes proportion.
const STAGE = { desk: 760, phone: 340 };
function fitTable() {
  const layout = $('.game-layout'), root = document.documentElement;
  if (!layout) return;
  const phone = matchMedia('(max-width:650px)').matches;
  if (!phone) root.style.setProperty('--fit-h', `${Math.max(420, Math.floor(innerHeight - (layout.getBoundingClientRect().top + scrollY) - 18))}px`);
  const stage = $('.table-stage'); if (!stage) return;
  const k = phone ? stage.clientWidth / STAGE.phone : Math.min(stage.clientWidth / (STAGE.desk - 20), stage.clientHeight / (STAGE.desk + 12));
  root.style.setProperty('--k', String(Math.max(.3, Math.min(1.5, k)).toFixed(4)));
}
addEventListener('resize', () => { if (state?.room) fitTable(); });
function updateTimer() {
  const el = $('#turn-timer'), deadline = state?.room?.game?.deadline;
  if (el) el.textContent = deadline ? `자동 뒤집기 ${Math.max(0, Math.ceil((deadline - Date.now() - offset) / 1000))}초` : '뒤집을 카드 없음';
}
setInterval(updateTimer, 250);
async function command(path, data = {}) {
  if (busy) return;
  busy = true;
  try { const next = await api(path, data); accept(next); }
  catch (e) { toast(e.message); }
  finally { busy = false; }
}
function action(type) {
  const g = state?.room?.game;
  if (!g || !connected) { if (!connected) toast('서버에 다시 연결되면 입력할 수 있어요.'); return; }
  return command('action', { gameId: g.id, action: type, actionId: crypto.randomUUID(), version: g.version });
}
document.addEventListener('click', async event => {
  const close = event.target.closest('[data-close]'); if (close) { close.closest('dialog').close(); return; }
  const join = event.target.closest('[data-join]'); if (join) { await command('join', { roomId: join.dataset.join }); return; }
  const button = event.target.closest('[data-do]'); if (!button || button.disabled) return;
  switch (button.dataset.do) {
    case 'rules': $('#rules-dialog').showModal(); break;
    case 'create': $('#create-dialog').showModal(); break;
    case 'motion': paused = !paused; localStorage.setItem('hg-paused', paused ? 'yes' : 'no'); render(); break;
    case 'sound': sound = !sound; localStorage.setItem('hg-sound', sound ? 'yes' : 'no'); if (sound) chime(); render(); break;
    case 'retry': start(); break;
    case 'home-login': homeLogin(); break;
    case 'bot': await command('bot'); break;
    case 'ready': await command('ready', { ready: state.room.game?.phase === 'finished' || !state.room.players.find(p => p.id === state.me.id).ready }); break;
    case 'flip': if (event.detail === 0) await action('flip'); break;   // keyboard; mouse and touch go through press-and-release below
    case 'ring': await action('ring'); break;
    case 'site-home': // 게임 중이면 한 번 묻고, 아니면 그냥 링크대로 이동
      if (state?.room?.game && state.room.game.phase !== 'finished') { event.preventDefault(); leaveToHome = true; leaveLabels('홈페이지로 나갈까요?', '홈페이지로'); $('#leave-dialog').showModal(); }
      break;
    case 'leave': if (state.room.game && state.room.game.phase !== 'finished') $('#leave-dialog').showModal(); else await command('leave'); break;
    case 'logout':
      if (state.room?.game && state.room.game.phase !== 'finished') { toast('진행 중인 방을 나간 후 로그아웃해주세요.'); break; }
      try {
        const response = await fetch(`${HOME}api/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!response.ok && response.status !== 401) throw new Error('로그아웃하지 못했어요. 잠시 후 다시 시도해주세요.');
        stream?.close(); state = null; location.assign(HOME);
      } catch (e) { toast(e.message.startsWith('로그아웃') ? e.message : '로그아웃하지 못했어요. 잠시 후 다시 시도해주세요.'); } break;
  }
});
$('#confirm-leave').addEventListener('click', async () => { const toHome = leaveToHome; $('#leave-dialog').close(); await command('leave'); if (toHome) location.assign(HOME); });
$('#leave-dialog').addEventListener('close', () => { leaveToHome = false; leaveLabels('테이블을 나갈까요?', '나가기'); });
document.addEventListener('input', event => { const input = event.target; if (input.closest('.chat-form')) drafts[input.closest('form').dataset.channel] = input.value; });
document.addEventListener('compositionstart', () => { composing = true; });
document.addEventListener('compositionend', event => {
  composing = false;
  const form = event.target.closest('.chat-form');
  if (form) drafts[form.dataset.channel] = event.target.value;
  if (renderPending) render();
});
$('#create-form').elements.mode.addEventListener('change', event => { $('#cards-field').hidden = event.target.value !== 'custom'; });
document.addEventListener('submit', async event => {
  const form = event.target; event.preventDefault();
  if (form.id === 'create-form') {
    const submit = $('button[type=submit]', form); submit.disabled = true;
    const raw = Object.fromEntries(new FormData(form));
    try {
      const next = await api('rooms', { ...raw, max: Number(raw.max), cards: Number(raw.cards) });
      $('#create-dialog').close(); accept(next); form.reset(); $('#cards-field').hidden = true; $('.form-error', form).textContent = '';
    } catch (e) { $('.form-error', form).textContent = e.message; }
    finally { submit.disabled = false; }
  } else if (form.matches('.chat-form')) {
    const channel = form.dataset.channel, input = $('input', form), text = input.value.trim(); if (!text) return;
    const submit = $('button', form); submit.disabled = true;
    try { const next = await api('chat', { channel, text }); drafts[channel] = ''; accept(next); $(`#chat-${channel}`)?.focus(); }
    catch (e) { toast(e.message); submit.disabled = false; }
  }
});
// ── press and hold my deck ──
// Pressing lifts my top card (everyone sees it lifted); letting go on the deck flips it; moving off the deck while
// pressing puts it back. So a player can pretend to flip and catch someone hitting the bell too early.
function sendHold(on) {
  const g = state?.room?.game;
  if (g) api('hold', { gameId: g.id, on }).catch(() => {});
}
function dropHold() {
  if (!myHold) return;
  const sent = myHold.sent; myHold = null;
  liftStart(state.me.id, true); render();
  if (sent) sendHold(false);
}
document.addEventListener('pointerdown', event => {
  const deck = event.target.closest('.seat.mine .hidden-deck');
  if (!deck || deck.disabled || myHold || event.button !== 0 || !event.isPrimary) return;
  event.preventDefault();   // no text selection or drag image; focus stays where it was
  const box = deck.getBoundingClientRect(), pad = 10;
  myHold = { startedAt: Date.now(), pointerId: event.pointerId, rect: { left: box.left - pad, right: box.right + pad, top: box.top - pad, bottom: box.bottom + pad }, sent: connected };
  liftStart(state.me.id, false); render();
  if (connected) sendHold(true);
});
const insideHold = event => { const r = myHold.rect; return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom; };
document.addEventListener('pointermove', event => {
  if (myHold && !myHold.releasing && event.pointerId === myHold.pointerId && !insideHold(event)) dropHold();
});
document.addEventListener('pointerup', async event => {
  if (!myHold || myHold.releasing || event.pointerId !== myHold.pointerId) return;
  if (!insideHold(event)) return dropHold();
  const hold = myHold; hold.releasing = true;
  await action('flip');
  // the flip did not go through (not my turn any more, offline, too fast): the card goes back
  if (myHold === hold) dropHold();
});
document.addEventListener('pointercancel', event => { if (myHold && !myHold.releasing && event.pointerId === myHold.pointerId) dropHold(); });
document.addEventListener('contextmenu', event => { if (event.target.closest('.seat.mine .hidden-deck')) event.preventDefault(); });
document.addEventListener('keydown', event => {
  if (event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.target.closest('input,textarea,select,button,[contenteditable="true"]') || document.querySelector('dialog[open]')) return;
  if (state?.room?.game?.phase !== 'playing') return;
  if (event.code === 'Space') { event.preventDefault(); action('ring'); }
  if (event.code === 'Enter' && state.room.game.players[state.room.game.turn]?.id === state.me.id) { event.preventDefault(); action('flip'); }
});
background();
render();
async function start() {
  gate = 'checking'; render();
  try { const initial = await api('state'); accept(initial); connect(); }
  catch (e) { gate = e.status === 401 ? 'signedout' : 'offline'; render(); }
}
start();
