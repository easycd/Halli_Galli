import { seatGeometry, flipKeyframes, detectCollection, collectionKeyframes, NAME_COLORS } from '/table-layout.js';
const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const fruitNames = { strawberry: '딸기', banana: '바나나', lime: '라임', plum: '자두' };
const fruits = Object.keys(fruitNames);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fruit = (name, cls = '') => `<svg class="${cls}" aria-hidden="true" viewBox="0 0 100 100"><use href="/fruit.svg#${name}"></use></svg>`;
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
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.spark}</svg>`; }
const bellArt = () => '<img src="/silver-bell.svg" alt="" draggable="false">';
let state = null, stream, authMode = 'login', busy = false, connected = true, offset = 0;
let paused = localStorage.getItem('hg-paused') === 'yes';
let sound = localStorage.getItem('hg-sound') === 'yes';
let audioContext, lastNotice, toastTimer, lastRoom = null, lastPhase, composing = false, renderPending = false;
const drafts = { global: '', room: '' };
const activeFlips = new Map();
let activeCollection = null, collectionTimer;
const seenCollections = new Set();
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
async function api(path, data) {
  const response = await fetch(`/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state) { stream?.close(); state = null; render(); }
    throw new Error(result.error ?? '서버에 연결할 수 없어요.');
  }
  return result;
}
function accept(next) {
  const previousGame = state?.room?.game, nextGame = next.room?.game;
  if (previousGame?.id !== nextGame?.id) { activeFlips.clear(); activeCollection = null; clearTimeout(collectionTimer); seenCollections.clear(); }
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
        activeFlips.set(player.id, { card: player.top, startedAt: Date.now() });
      } else if (!player.top) activeFlips.delete(player.id);
    }
  }
  state = next; offset = next.serverTime - Date.now();
  const game = state.room?.game;
  if (game?.notice && game.notice !== lastNotice && ['playing', 'finished'].includes(game.phase)) {
    if (game.notice.includes('정답!')) chime();
    lastNotice = game.notice;
  }
  render();
}
function connect() {
  stream?.close(); stream = new EventSource('/api/events');
  stream.onmessage = event => { connected = true; accept(JSON.parse(event.data)); };
  stream.onopen = () => { connected = true; updateConnection(); };
  stream.onerror = () => { connected = false; updateConnection(); };
}
function updateConnection() {
  document.querySelectorAll('.connection').forEach(el => {
    el.classList.toggle('offline', !connected); el.innerHTML = `<i class="dot"></i>${connected ? '서버 연결됨' : '재연결 중 · 서버 재시작 시 다시 로그인'}`;
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
function brand() { return `<a class="brand" href="/" aria-label="할리갈리 홈"><span class="brand-mark">${icon('bell')}</span><span class="brand-name">halli<span>galli.</span></span></a>`; }
function header(auth = false) {
  return `<header class="topbar">${brand()}<nav class="top-actions" aria-label="설정"><button class="text-button" data-do="rules" aria-label="게임 방법">${icon('help')}<span>게임 방법</span></button><button class="text-button" data-do="motion" aria-label="배경 애니메이션 ${paused ? '재생' : '일시정지'}">${icon(paused ? 'play' : 'pause')}<span>${paused ? '배경 재생' : '배경 멈추기'}</span></button>${auth ? '' : `<button class="text-button" data-do="sound" aria-label="소리 ${sound ? '끄기' : '켜기'}" aria-pressed="${sound}"><span>소리 ${sound ? '켜짐' : '꺼짐'}</span>${icon('bell')}</button><div class="profile"><span class="avatar c1">${escape(state.me.nickname[0])}</span><strong>${escape(state.me.nickname)}</strong><button class="text-button" data-do="logout" aria-label="로그아웃">${icon('logout')}</button></div>`}</nav></header>`;
}
function footer(auth = false) { if (auth) return ''; return `<footer class="page-foot"><span class="runtime-badge">${state.debug ? 'DEBUG · 기록 미반영' : 'ONLINE'}</span><span class="connection"><i class="dot"></i>서버 연결됨</span></footer>`; }
function authPage() {
  return `<div class="auth-header">${header(true)}</div><main id="main" class="auth-layout"><section class="auth-visual" aria-label="할리갈리 과일 카드와 종 일러스트"><h1 class="sr-only">할리갈리 로그인</h1><img src="/login-art.svg" width="620" height="580" alt="딸기, 바나나, 라임 카드와 황금색 종으로 꾸민 할리갈리 테이블"></section><section class="glass auth-panel" aria-labelledby="auth-title"><h2 id="auth-title" class="sr-only">${authMode === 'login' ? '로그인' : '회원가입'}</h2><div class="auth-tabs" role="group" aria-label="로그인 또는 회원가입"><button class="auth-tab ${authMode === 'login' ? 'active' : ''}" data-auth="login" aria-pressed="${authMode === 'login'}">로그인</button><button class="auth-tab ${authMode === 'register' ? 'active' : ''}" data-auth="register" aria-pressed="${authMode === 'register'}">회원가입</button></div><form id="auth-form"><label for="nickname">닉네임<input id="nickname" name="nickname" required minlength="2" maxlength="12" autocomplete="username" placeholder="닉네임 입력" aria-describedby="nickname-hint"><small id="nickname-hint">한글·영문·숫자·밑줄·하이픈, 2~12자</small></label><label for="password">비밀번호<div class="password-wrap"><input id="password" name="password" type="password" required minlength="8" maxlength="128" autocomplete="${authMode === 'login' ? 'current-password' : 'new-password'}" placeholder="8자 이상 입력해주세요"><button type="button" class="password-toggle" data-do="password" aria-label="비밀번호 보기" aria-pressed="false">${icon('eye')}</button></div></label><p class="form-error" role="alert" id="auth-error"></p><button type="submit" class="button primary wide">${authMode === 'login' ? '로그인' : '회원가입'} ${icon('arrow')}</button></form></section></main><div class="app-shell">${footer(true)}</div>`;
}
function avatar(name, index = 0) { return `<span class="avatar c${index % 4}">${escape(name[0])}</span>`; }
function leaderboard() {
  const ranking = state.ranking;
  return `<section class="leaderboard glass" aria-labelledby="ranking-title"><div class="section-heading"><div class="section-title">${icon('trophy')}<h3 id="ranking-title">전체 랭킹</h3></div></div>${ranking.length ? `<div class="leaders">${ranking.slice(0, 3).map((u, i) => `<div class="leader"><span class="place">${i + 1}</span>${avatar(u.nickname, i)}<div class="details"><strong>${escape(u.nickname)}</strong><small>승률 ${Math.round(u.wins / u.played * 100)}%</small></div><span class="score">${u.wins}승</span></div>`).join('')}<div class="leader my-rank"><div class="details"><strong>나의 기록</strong><small>${state.debug ? '디버그 경기는 집계하지 않아요' : `${state.me.wins}승 · ${state.me.played}판`}</small></div></div></div>` : `<div class="rank-empty">${icon('trophy')}<div><p>랭킹 기록 없음</p></div></div>`}</section>`;
}
function chatPanel(channel) {
  const messages = channel === 'global' ? state.messages : state.room.messages;
  return `<section class="glass panel chat-panel" aria-label="${channel === 'global' ? '전체' : '룸'} 채팅"><div class="panel-header section-heading"><div class="section-title">${icon('chat')}<h3>${channel === 'global' ? '전체 채팅' : '룸 채팅'}</h3></div><span class="count">${channel === 'global' ? state.online.length : state.room.players.length}</span></div><div class="chat-body" data-chat="${channel}" role="log" aria-label="채팅 메시지">${messages.length ? messages.map(m => `<div class="chat-msg ${m.system ? 'system' : ''}"><div class="chat-meta"><strong>${escape(m.nickname)}</strong><time>${new Date(m.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></div><p>${escape(m.text)}</p></div>`).join('') : `<div class="chat-empty">${icon('chat')}<span>메시지 없음</span></div>`}</div><form class="chat-form" data-channel="${channel}"><label class="sr-only" for="chat-${channel}">메시지</label><input id="chat-${channel}" name="message" autocomplete="off" maxlength="200" placeholder="메시지를 입력하세요" value="${escape(drafts[channel])}" required><button type="submit" aria-label="메시지 보내기">${icon('send')}</button></form></section>`;
}
function presencePanel(room = false) {
  const players = room ? state.room.players : state.online;
  const game = state.room?.game;
  return `<aside class="glass panel presence" aria-label="${room ? '입장 플레이어' : '현재 접속자'}"><div class="panel-header section-heading"><div class="section-title">${icon('people')}<h3>${room ? '플레이어' : '접속자'}</h3></div><span class="count">${players.length}${room ? `/${state.room.settings.max}` : ''}</span></div><div class="player-list">${players.map((p, i) => {
    const gp = game?.players.find(g => g.id === p.id);
    const label = room ? gp ? gp.status === 'out' ? '탈락' : gp.status === 'recovering' ? '복귀 대기' : '게임중' : p.ready ? '준비 완료' : '준비중' : p.status;
    return `<div class="player-row">${avatar(p.nickname, i)}<div class="person"><strong>${escape(p.nickname)}${p.id === state.me.id ? ' <small>나</small>' : ''}</strong><small>${room ? `${i + 1}번 좌석${p.id === state.room.host ? ' · 방장' : ''}${p.bot ? ' · BOT' : p.online ? '' : ' · 연결 끊김'}` : ''}</small></div><span class="status ${label === '게임중' ? 'playing' : ''}">${escape(label)}</span></div>`;
  }).join('')}</div>${room ? `${state.debug ? `<div class="debug-note">${state.room.host === state.me.id ? `<button class="button secondary" data-do="bot" ${players.length >= state.room.settings.max || (game && game.phase !== 'finished') ? 'disabled' : ''}>${icon('plus')} 테스트 봇 추가</button>` : ''}</div>` : ''}` : ``}</aside>`;
}
const endingLabel = ending => ending === 'first' ? '첫 탈락 시 종료' : '마지막 1명까지';
function roomCard(room, i) {
  const playing = !['waiting', 'finished'].includes(room.phase), full = room.count >= room.settings.max;
  return `<article class="room-card glass"><div class="room-illustration">${fruit(fruits[i % 4])}</div><div class="room-info"><span class="pill"><i class="dot ${playing ? 'playing' : ''}"></i>${playing ? '게임중' : '대기중'}</span><h3>${escape(room.name)}</h3><div class="room-tags"><span>${room.settings.mode === 'original' ? '원본 56장' : `한 명당 ${room.settings.cards}장`}</span><span>${endingLabel(room.settings.ending)}</span></div></div><div class="room-join"><small>${room.count} / ${room.settings.max}명</small><button class="button secondary" data-join="${room.id}" ${playing || full ? 'disabled' : ''}>${playing ? '진행중' : full ? '가득 참' : '입장하기'}</button></div></article>`;
}
function lobbyPage() {
  return `<div class="app-shell">${header()}<main id="main"><div class="welcome-row"><div><h1>로비</h1></div><span class="pill"><i class="dot"></i>${state.online.length}명이 함께하고 있어요</span></div>${leaderboard()}<div class="lobby-grid">${chatPanel('global')}<section class="center-content"><div class="section-heading room-heading"><div class="section-title"><h2>열려 있는 테이블</h2><span class="pill">${state.rooms.length}</span></div><button class="button primary" data-do="create">${icon('plus')} 방 만들기</button></div><div class="room-list">${state.rooms.length ? state.rooms.map(roomCard).join('') : `<div class="glass empty-rooms"><div class="table-art">${fruit('strawberry')}${fruit('banana')}${fruit('lime')}</div><p>생성된 방 없음</p><button class="button secondary" data-do="create">방 만들기 ${icon('arrow')}</button></div>`}</div></section>${presencePanel()}</div></main>${footer()}</div>`;
}
function stackStyle(count) {
  const layers = Math.min(12, Math.ceil(Math.max(0, count) / 3));
  const shadows = [];
  for (let i = 1; i < layers; i++) {
    shadows.push(`0 ${i * 1.5}px 0 -.5px #fffdf8`, `0 ${i * 1.5 + .7}px 0 -.5px #b7b5ab`);
  }
  shadows.push(`0 ${layers * 1.5 + 4}px 9px #001f1666`);
  return `--pile-shadow:${count ? shadows.join(',') : 'none'};--layers:${layers}`;
}
function cardFace(card) {
  if (!card) return '';
  const placements = { 1: [[50,50]], 2: [[27,24],[73,76]], 3: [[25,20],[50,50],[75,80]], 4: [[25,23],[75,23],[25,77],[75,77]], 5: [[25,20],[75,20],[50,50],[25,80],[75,80]] };
  return `<div class="card-fruits n${card.count}">${placements[card.count].map(([x,y]) => `<span style="--fruit-x:${x}%;--fruit-y:${y}%">${fruit(card.fruit)}</span>`).join('')}</div>`;
}
function seats() {
  const r = state.room, g = r.game, players = g?.players ?? r.players;
  return players.map((p, i) => {
    const geometry = seatGeometry(i, players.length);
    const { x, y, dx, dy, rotation } = geometry;
    const card = p.top, mine = p.id === state.me.id;
    const count = g ? p.cards : r.settings.mode === 'original' ? Math.floor(56 / players.length) + (i < 56 % players.length ? 1 : 0) : r.settings.cards;
    const canFlip = mine && g?.phase === 'playing' && g.turn === i && count > 0;
    const tag = mine ? 'button' : 'div';
    return `<div class="seat ${mine ? 'mine' : ''} ${g?.phase === 'playing' && g.turn === i ? 'current' : ''} ${p.status === 'out' ? 'out' : ''} ${activeCollection?.winnerId === p.id ? 'collection-winner' : ''}" style="--x:${x}%;--y:${y}%;--radial-x:${dx};--radial-y:${dy};--seat-rotation:${rotation}deg;--name-bg:${NAME_COLORS[i % NAME_COLORS.length]};--label-factor:${Math.abs(dy)};--mobile-label-y:${dy < -.5 ? '-82px' : `calc(${Math.abs(dy)} * 27px + 31px)`}" data-seat="${p.id}" data-dx="${dx}" data-dy="${dy}" data-rotation="${rotation}"><div class="seat-piles"><${tag} class="hidden-deck card-stack ${count ? 'card-back' : 'empty-deck'}" style="${stackStyle(count)}" ${mine ? `type="button" data-do="flip" ${canFlip ? '' : 'disabled'} aria-label="내 비공개 카드 ${count}장${canFlip ? ', 눌러서 뒤집기' : ''}"` : `role="img" aria-label="${escape(p.nickname)} 비공개 카드 ${count}장"`}><span class="deck-pattern" aria-hidden="true"></span><span class="deck-count">${count}</span></${tag}><div class="playing-card ${card ? 'card-front card-stack' : 'empty-pile'}" style="${stackStyle(p.openCount ?? 0)}" role="img" aria-label="${card ? `${escape(p.nickname)}: ${fruitNames[card.fruit]} ${card.count}개, 공개 더미 ${p.openCount}장` : '공개 카드 없음'}">${cardFace(card)}</div>${flipMarkup(p.id)}</div><div class="seat-name">${i + 1}. ${escape(p.nickname)}${mine ? ' <span class="me">나</span>' : ''}</div><div class="seat-status">${g ? p.status === 'out' ? '탈락' : p.status === 'recovering' ? '종으로 복귀 가능' : `${p.cards}장` : p.ready ? '준비 완료' : '준비중'}</div></div>`;
  }).join('');
}
function flipMarkup(playerId) {
  const flip = activeFlips.get(playerId);
  if (!flip || Date.now() - flip.startedAt > 520) return '';
  return `<div class="flip-flight" data-flip="${playerId}" aria-hidden="true"><div class="flip-face flip-back card-back"><span class="deck-pattern"></span></div><div class="flip-face flip-front">${cardFace(flip.card)}</div></div>`;
}
function playCardFlips() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const element of document.querySelectorAll('.flip-flight')) {
    const seat = element.closest('.seat'), flip = activeFlips.get(element.dataset.flip);
    if (!flip) continue;
    const elapsed = Date.now() - flip.startedAt;
    const offset = parseFloat(getComputedStyle(seat).getPropertyValue('--pile-offset'));
    const frames = flipKeyframes({ dx: Number(seat.dataset.dx), dy: Number(seat.dataset.dy), rotation: Number(seat.dataset.rotation) }, offset);
    const animation = element.animate(frames, { duration: 520, delay: -elapsed, easing: 'cubic-bezier(.35,.05,.3,1)', fill: 'both' });
    animation.finished.then(() => {
      if (activeFlips.get(element.dataset.flip) === flip) activeFlips.delete(element.dataset.flip);
      element.remove();
    }).catch(() => {});
  }
}
function collectionMarkup() {
  const event = activeCollection;
  if (!event || Date.now() - event.startedAt >= 1500) return '';
  return `<div class="collection-layer" data-collection="${event.id}" aria-hidden="true"><div class="collection-ring"></div><div class="collection-banner">${escape(event.winnerName)} <strong>+${event.total}장</strong></div>${event.piles.map((pile, index) => `<div class="collection-packet" data-source="${pile.index}" data-order="${index}"><div class="collection-stack-sheets" style="${stackStyle(pile.count)}"></div><div class="collection-card collection-front">${cardFace(pile.top)}</div><div class="collection-card collection-back card-back"><span class="deck-pattern"></span></div></div>`).join('')}</div>`;
}
function playCollections() {
  clearTimeout(collectionTimer);
  const event = activeCollection, layer = document.querySelector('.collection-layer');
  if (!event || !layer) return;
  const elapsed = Date.now() - event.startedAt;
  const table = document.querySelector('.game-table'), size = table.getBoundingClientRect().width;
  const offset = parseFloat(getComputedStyle(document.querySelector('.seat')).getPropertyValue('--pile-offset'));
  const winner = seatGeometry(event.winnerIndex, event.playerCount);
  for (const packet of layer.querySelectorAll('.collection-packet')) {
    const source = seatGeometry(Number(packet.dataset.source), event.playerCount);
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
  if (!g) return `<div class="waiting-overlay"><h2>게임 준비</h2><p>모두 준비를 마치면 게임이 시작돼요.<br>${r.players.length < 2 ? '친구를 초대하거나 테스트 봇을 추가해보세요.' : `${r.players.filter(p => p.ready).length} / ${r.players.length}명 준비 완료`}</p><span class="pill">${endingLabel(r.settings.ending)}</span></div>`;
  if (g.phase === 'spinning') return `<div class="waiting-overlay"><span class="eyebrow">WHO GOES FIRST?</span><h2>첫 주인공을 뽑아요!</h2><div class="wheel-pointer">▼</div><div class="wheel" style="--stop:${1440 - (g.starter * 360 / g.players.length)}deg;animation-delay:-${Math.max(0, Date.now() + offset - g.createdAt)}ms;background:conic-gradient(${g.players.map((p, i) => `${['#f1c6a3', '#d7dfb3', '#e2c9d9', '#f1dda0'][i % 4]} ${i * 360 / g.players.length}deg ${(i + 1) * 360 / g.players.length}deg`).join(',')})">${g.players.map((p, i) => `<span style="--angle:${i * 360 / g.players.length}deg">${escape(p.nickname)}</span>`).join('')}</div><p>선택된 플레이어부터 시계방향으로!</p></div>`;
  return '';
}
function resultsOverlay() {
  const g = state.room.game;
  if (g?.phase !== 'finished' || (activeCollection && Date.now() - activeCollection.startedAt < 1500)) return '';
  return `<div class="results-overlay"><section class="results-panel" aria-label="게임 결과"><span class="eyebrow">${g.draw ? 'A FRIENDLY DRAW' : 'THAT WAS A GOOD GAME'}</span><h2>${g.draw ? '이번 판은 무승부예요' : `${escape(g.results.filter(p => p.winner).map(p => p.nickname).join(', '))}님 우승!`}</h2><p>${g.draw ? escape(g.notice) : '좋은 한 판이었어요. 한 번 더 할까요?'}</p><div class="result-list">${g.results.map(p => `<div class="result-row"><span>${p.rank}</span><strong>${escape(p.nickname)}</strong><small>정답 ${p.hits} · 오답 ${p.misses}</small><span>${p.cards}장</span></div>`).join('')}</div><p>${state.debug ? '디버그 경기 · 랭킹에 반영되지 않아요' : '경기 결과가 저장되었어요'}</p><button class="button primary wide" data-do="ready">다시 준비하기 ${icon('arrow')}</button><button class="text-button" data-do="leave">로비로 돌아가기</button></section></div>`;
}
function gamePage() {
  const r = state.room, g = r.game, me = g?.players.find(p => p.id === state.me.id), waiting = !g;
  const canRing = g?.phase === 'playing' && me.status !== 'out';
  return `<div class="app-shell">${header()}<main id="main"><div class="room-top"><div><h1>${escape(r.name)}</h1><div class="room-tags"><span>${r.settings.mode === 'original' ? '원본 56장' : `한 명당 ${r.settings.cards}장`}</span><span>${endingLabel(r.settings.ending)}</span><span>${r.players.length}/${r.settings.max}명</span></div></div><button class="button secondary" data-do="leave">나가기 ${icon('logout')}</button></div><div class="game-layout">${chatPanel('room')}<section class="glass game-center" aria-label="게임판"><div class="table-meta"><div class="in-game-ranks"><span class="eyebrow">이번 판 순위</span><div class="rank-chips">${g ? [...g.players].sort((a,b) => b.cards-a.cards).map((p, i, list) => `<span class="rank-chip">${list.findIndex(q => q.cards === p.cards) + 1}. ${escape(p.nickname)}<strong>${p.cards}</strong></span>`).join('') : '<span>게임이 시작되면 표시돼요</span>'}</div></div><div class="game-status">${g?.phase === 'playing' ? `<span class="pill"><i class="dot"></i>${g.turn >= 0 ? `${escape(g.players[g.turn].nickname)}님 차례` : '종 판정 대기'}</span><br><span id="turn-timer"></span>` : '<span class="pill">준비 시간</span>'}</div></div><div class="game-table"><div class="table-ring"></div>${seats()}${collectionMarkup()}<button class="bell-control" data-do="ring" ${canRing ? '' : 'disabled'} aria-label="종 누르기, 스페이스 키">${bellArt()}</button></div>${waitingOverlay()}${g?.phase === 'announcing' ? `<div class="start-popup" role="status">${escape(g.players[g.starter].nickname)}님부터 시작합니다!</div>` : ''}<p class="notice-bar" role="status">${escape(g?.notice ?? '모두 준비가 되면 시작 플레이어를 뽑아요.')}</p><div class="game-controls"><div class="my-cards">내 카드 <strong>${me?.cards ?? '—'}</strong>${me ? '장' : ''}</div><div class="controls-right"><button class="button secondary" data-do="rules" aria-label="게임 방법">${icon('help')}</button>${waiting ? `<button class="button primary ready-action ${r.players.find(p => p.id === state.me.id).ready ? 'is-ready' : ''}" data-do="ready" aria-pressed="${r.players.find(p => p.id === state.me.id).ready}">${r.players.find(p => p.id === state.me.id).ready ? '준비 취소' : '준비 완료'}</button>` : ''}</div></div>${resultsOverlay()}</section>${presencePanel(true)}</div></main>${footer()}</div>`;
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
  updateConnection(); updateTimer(); playCardFlips(); playCollections();
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
function updateTimer() {
  const el = $('#turn-timer'), deadline = state?.room?.game?.deadline;
  if (el) el.textContent = deadline ? `${Math.max(0, Math.ceil((deadline - Date.now() - offset) / 1000))}초 후 자동 뒤집기` : '뒤집을 카드가 없어 종을 기다려요';
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
  const authTab = event.target.closest('[data-auth]');
  if (authTab) { authMode = authTab.dataset.auth; render(); return; }
  const close = event.target.closest('[data-close]'); if (close) { close.closest('dialog').close(); return; }
  const join = event.target.closest('[data-join]'); if (join) { await command('join', { roomId: join.dataset.join }); return; }
  const button = event.target.closest('[data-do]'); if (!button || button.disabled) return;
  switch (button.dataset.do) {
    case 'rules': $('#rules-dialog').showModal(); break;
    case 'create': $('#create-dialog').showModal(); break;
    case 'motion': paused = !paused; localStorage.setItem('hg-paused', paused ? 'yes' : 'no'); render(); break;
    case 'sound': sound = !sound; localStorage.setItem('hg-sound', sound ? 'yes' : 'no'); if (sound) chime(); render(); break;
    case 'password': { const input = $('#password'); const show = input.type === 'password'; input.type = show ? 'text' : 'password'; button.setAttribute('aria-pressed', String(show)); button.setAttribute('aria-label', show ? '비밀번호 숨기기' : '비밀번호 보기'); break; }
    case 'bot': await command('bot'); break;
    case 'ready': await command('ready', { ready: state.room.game?.phase === 'finished' || !state.room.players.find(p => p.id === state.me.id).ready }); break;
    case 'flip': await action('flip'); break;
    case 'ring': await action('ring'); break;
    case 'leave': if (state.room.game && state.room.game.phase !== 'finished') $('#leave-dialog').showModal(); else await command('leave'); break;
    case 'logout':
      if (state.room?.game && state.room.game.phase !== 'finished') { toast('진행 중인 방을 나간 후 로그아웃해주세요.'); break; }
      try { await api('logout', {}); stream?.close(); state = null; render(); } catch (e) { toast(e.message); } break;
  }
});
$('#confirm-leave').addEventListener('click', async () => { $('#leave-dialog').close(); await command('leave'); });
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
  if (form.id === 'auth-form') {
    const submit = $('button[type=submit]', form); submit.disabled = true; submit.textContent = '잠시만 기다려주세요…';
    try { const result = await api(authMode, Object.fromEntries(new FormData(form))); accept(result); connect(); }
    catch (e) { $('#auth-error').textContent = e.message; submit.disabled = false; submit.textContent = authMode === 'login' ? '로그인' : '회원가입'; }
  } else if (form.id === 'create-form') {
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
document.addEventListener('keydown', event => {
  if (event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.target.closest('input,textarea,select,button,[contenteditable="true"]') || document.querySelector('dialog[open]')) return;
  if (state?.room?.game?.phase !== 'playing') return;
  if (event.code === 'Space') { event.preventDefault(); action('ring'); }
  if (event.code === 'Enter' && state.room.game.players[state.room.game.turn]?.id === state.me.id) { event.preventDefault(); action('flip'); }
});
background();
render();
try { const initial = await api('state'); accept(initial); connect(); } catch { /* first visit */ }
