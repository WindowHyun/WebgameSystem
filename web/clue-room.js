'use strict';

/**
 * 클루(Cluedo) - 저택에서 벌어진 살인 사건의 범인·흉기·장소를 추리하는 보드게임. 돈이나 칩은 걸지 않는다.
 *
 * [규칙] 원작 규칙을 따른다.
 *   - 범인 6명·흉기 6개·장소 9곳의 카드에서 한 장씩을 비밀 봉투에 넣고, 나머지 18장을 참가자에게 나눠 준다.
 *   - 자기 차례에 주사위 2개를 굴려 나온 눈의 합까지 복도 칸을 걸어 이동한다. 다른 사람의 말이 선 칸은 지나갈 수도,
 *     설 수도 없고, 문 칸이 막히면 그 문으로는 방에 들어갈 수 없다. 방에 들어가면 이동이 끝난다.
 *   - 모서리 방(주방↔연구실, 온실↔라운지)은 주사위를 굴리는 대신 비밀 통로로 건너갈 수 있다.
 *   - 방에 들어가면 그 방에서 "범인 + 흉기"를 추측한다. 추측한 범인의 말과 흉기가 그 방으로 불려 온다.
 *     추측한 사람 다음 차례부터 시계 방향으로, 세 장 중 하나라도 가진 첫 사람이 한 장을 골라 추측한 사람에게만 몰래 보여 준다.
 *     아무도 없으면 넘어간다. 다른 사람의 추측으로 불려 온 사람은 다음 차례에 주사위를 굴리지 않고 그 방에서 바로 추측할 수 있다.
 *   - 자기 차례에는 언제든 고발(범인·흉기·장소)할 수 있다. 맞히면 이기고, 틀리면 탈락한다.
 *     탈락한 사람은 더 움직이지 않지만, 그 사람의 카드는 계속 다른 사람의 추측을 반박한다.
 *
 * [기본값] 원작에 없는 온라인 사정은 이렇게 정했다.
 *   - 주사위와 카드 나누기는 서버가 한다. 카드는 본인에게만 보이고, 보여 준 카드는 추측한 사람에게만 간다.
 *     비밀 봉투의 답은 게임이 끝날 때까지 어떤 화면에도 가지 않는다.
 *   - 2~6명이 한다. 말(범인)은 무작위로 나눠 받고, 차례는 스칼렛·머스터드·화이트·그린·피콕·플럼 순이다.
 *     참가자가 맡지 않은 말도 보드에 서 있고 막는 말이 된다.
 *   - 보여 줄 카드가 한 장뿐이면 서버가 대신 보여 준다. 두 장 이상이면 가진 사람이 고른다.
 *   - 차례는 제한시간(기본 120초), 카드를 고르는 것은 45초다. 넘기면 차례는 넘어가고 카드는 서버가 첫 번째를 보여 준다.
 *     3번 연속 시간을 넘기면 게임에서 빠진다. 보스 키로 화면을 가린 사람을 기다리는 동안 제한시간은 멈춘다.
 *   - 연결이 끊긴 사람이 유예(기본 30초) 안에 돌아오지 않으면 게임에서 빠진다. 빠진 사람의 카드는 서버가 대신 보여 준다.
 *   - 남은 사람이 한 명뿐이 되면(나머지가 탈락·퇴장) 그 사람이 이긴다.
 *   - 판이 끝나면 이번 판 참가자는 다음 판도 자동으로 준비된다.
 */

const crypto = require('crypto');
const { createSafeTimeout, uniqueName } = require('./room-helpers');
const { cleanNickname } = require('./protocol');
const { createCoverPause } = require('./cover-pause');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const ROOM_CAPACITY = 10;
const DICE = 2;
const IDLE_LIMIT = 3;

// ───────────────────────────── 보드 ─────────────────────────────
// 24 x 25 칸. 방과 가운데 봉투 자리를 뺀 칸이 복도다. 방에는 문(복도 칸)을 통해서만 드나든다.

const GRID = { w: 24, h: 25 };
const CENTER = { x1: 9, y1: 8, x2: 14, y2: 15 };

const SUSPECTS = [
  { key: 'scarlett', label: '스칼렛 양', start: { x: 17, y: 0 } },
  { key: 'mustard', label: '머스터드 대령', start: { x: 23, y: 13 } },
  { key: 'white', label: '화이트 부인', start: { x: 8, y: 24 } },
  { key: 'green', label: '그린 목사', start: { x: 16, y: 24 } },
  { key: 'peacock', label: '피콕 부인', start: { x: 0, y: 16 } },
  { key: 'plum', label: '플럼 교수', start: { x: 0, y: 7 } },
];
const WEAPONS = [
  { key: 'candlestick', label: '촛대' },
  { key: 'dagger', label: '단검' },
  { key: 'leadPipe', label: '납 파이프' },
  { key: 'revolver', label: '권총' },
  { key: 'rope', label: '밧줄' },
  { key: 'wrench', label: '렌치' },
];
const ROOMS = [
  { key: 'kitchen', label: '주방', x1: 0, y1: 0, x2: 5, y2: 5, doors: [[4, 6]], passage: 'study' },
  { key: 'ballroom', label: '무도회장', x1: 8, y1: 0, x2: 15, y2: 6, doors: [[7, 3], [16, 3], [11, 7]] },
  { key: 'conservatory', label: '온실', x1: 18, y1: 0, x2: 23, y2: 4, doors: [[19, 5]], passage: 'lounge' },
  { key: 'dining', label: '식당', x1: 0, y1: 9, x2: 7, y2: 14, doors: [[8, 10], [3, 15]] },
  { key: 'billiard', label: '당구장', x1: 18, y1: 8, x2: 23, y2: 12, doors: [[17, 10], [20, 13]] },
  { key: 'library', label: '서재', x1: 17, y1: 15, x2: 23, y2: 19, doors: [[16, 17], [20, 14]] },
  { key: 'lounge', label: '라운지', x1: 0, y1: 19, x2: 6, y2: 24, doors: [[5, 18]], passage: 'conservatory' },
  { key: 'hall', label: '홀', x1: 9, y1: 18, x2: 14, y2: 24, doors: [[11, 17], [8, 21], [15, 21]] },
  { key: 'study', label: '연구실', x1: 17, y1: 21, x2: 23, y2: 24, doors: [[20, 20], [16, 22]], passage: 'kitchen' },
];

const SUSPECT_KEYS = SUSPECTS.map((s) => s.key);
const WEAPON_KEYS = WEAPONS.map((w) => w.key);
const ROOM_KEYS = ROOMS.map((r) => r.key);
const CARDS = [
  ...SUSPECTS.map((s) => ({ key: s.key, label: s.label, kind: 'suspect' })),
  ...WEAPONS.map((w) => ({ key: w.key, label: w.label, kind: 'weapon' })),
  ...ROOMS.map((r) => ({ key: r.key, label: r.label, kind: 'room' })),
];
const CARD_KEYS = CARDS.map((c) => c.key);
const labelOf = (key) => (CARDS.find((c) => c.key === key) || { label: key }).label;
const roomByKey = (key) => ROOMS.find((r) => r.key === key);

const cellKey = (x, y) => `${x},${y}`;
const inside = (rect, x, y) => x >= rect.x1 && x <= rect.x2 && y >= rect.y1 && y <= rect.y2;
function isCorridor(x, y) {
  if (x < 0 || y < 0 || x >= GRID.w || y >= GRID.h) return false;
  if (inside(CENTER, x, y)) return false;
  return !ROOMS.some((room) => inside(room, x, y));
}
// 문 칸 -> 그 칸에서 들어갈 수 있는 방
const DOOR_ROOMS = new Map();
for (const room of ROOMS) {
  for (const [x, y] of room.doors) {
    const key = cellKey(x, y);
    DOOR_ROOMS.set(key, [...(DOOR_ROOMS.get(key) || []), room.key]);
  }
}

/** 화면이 그릴 정적인 보드 정보. */
const MAP = {
  w: GRID.w,
  h: GRID.h,
  center: CENTER,
  rooms: ROOMS.map((r) => ({ key: r.key, label: r.label, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, doors: r.doors.map(([x, y]) => ({ x, y })), passage: r.passage || null })),
};

/**
 * from({room} 또는 {x,y})에서 steps칸 안에 갈 수 있는 곳. blocked는 다른 말이 서 있어 지나갈 수 없는 복도 칸("x,y")의 집합.
 * 방에서 문 칸으로 나가는 것과 문 칸에서 방으로 들어가는 것은 각각 한 칸이다. 처음 서 있는 곳은 결과에 넣지 않는다.
 */
function computeReach(from, steps, blocked) {
  const stuck = blocked || new Set();
  const start = from.room ? `r:${from.room}` : cellKey(from.x, from.y);
  const dist = new Map([[start, 0]]);
  const queue = [start];
  const neighbors = (node) => {
    if (node.startsWith('r:')) return roomByKey(node.slice(2)).doors.map(([x, y]) => cellKey(x, y));
    const [x, y] = node.split(',').map(Number);
    const next = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].filter(([nx, ny]) => isCorridor(nx, ny)).map(([nx, ny]) => cellKey(nx, ny));
    for (const room of DOOR_ROOMS.get(node) || []) next.push(`r:${room}`);
    return next;
  };
  while (queue.length) {
    const node = queue.shift();
    const d = dist.get(node);
    if (d >= steps) continue;
    for (const next of neighbors(node)) {
      if (dist.has(next) || stuck.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  const cells = [];
  const rooms = [];
  for (const node of dist.keys()) {
    if (node === start) continue;
    if (node.startsWith('r:')) rooms.push(node.slice(2));
    else { const [x, y] = node.split(',').map(Number); cells.push({ x, y }); }
  }
  return { cells, rooms };
}

function createClueRoom(options) {
  const opts = options || {};
  const notify = opts.onChange || (() => {});
  const onAction = opts.onAction || (() => {});
  const act = (who, what) => { try { onAction(who, what); } catch { /* 로그 실패는 무시 */ } };
  const random = opts.random || Math.random;
  const turnTimeoutMs = Number.isFinite(opts.turnTimeoutMs) ? opts.turnTimeoutMs : 120000;
  const disproveTimeoutMs = Number.isFinite(opts.disproveTimeoutMs) ? opts.disproveTimeoutMs : 45000;
  const disconnectGraceMs = Number.isFinite(opts.disconnectGraceMs) ? opts.disconnectGraceMs : 30000;
  const safeTimeout = createSafeTimeout('클루');

  const players = []; // { id, token, nickname, connected, ready }
  const history = [];
  let phase = 'lobby'; // lobby | playing | result
  let seats = [];      // 이번 판 참가자(차례 순서) { id, nickname, suspect, hand, seen, eliminated, left, idle, summoned }
  let turn = 0;
  let step = 'start';  // start(굴리기 전) | move(굴린 뒤 이동) | suggest(방에 들어와 추측 전) | disprove(카드를 기다림) | end(추측 뒤)
  let dice = null;     // [a, b] 또는 null
  let moveLeft = 0;
  let solution = null; // { suspect, weapon, room } - 게임이 끝날 때까지 밖으로 나가지 않는다
  let positions = {};  // 범인 key -> { x, y } | { room }
  let weaponRooms = {}; // 흉기 key -> 방 key
  let pending = null;  // { suggesterId, suspect, weapon, room, disproverId, options, passed }
  let lastSuggestion = null; // 모두에게 보이는 마지막 추측
  let suggestionSeq = 0;
  let result = null;
  const dropTimers = new Map();

  const makeId = () => crypto.randomBytes(8).toString('hex');
  const makeToken = () => crypto.randomBytes(18).toString('hex');
  const note = (text) => { history.push({ text, timestamp: Date.now() }); if (history.length > 40) history.shift(); };
  const find = (id) => players.find((p) => p.id === id);
  const seatOf = (id) => seats.find((s) => s.id === id);
  const nameOf = (id) => (find(id) || seatOf(id) || {}).nickname || '(나간 참가자)';
  const currentSeat = () => (phase === 'playing' ? seats[turn] || null : null);
  const inGame = (id) => { const seat = seatOf(id); return phase === 'playing' && !!seat && !seat.left; };
  const active = () => seats.filter((s) => !s.eliminated && !s.left);
  const roomOf = (seat) => positions[seat.suspect].room || null;
  const shuffle = (list) => {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.min(i, Math.floor(random() * (i + 1)));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const pick = (list) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

  // [보스 키] 지금 기다리는 사람(카드를 고를 사람 또는 차례인 사람)이 화면을 가리고 있으면 제한시간을 멈춘다.
  const waitingOn = () => (phase !== 'playing' ? null : step === 'disprove' && pending ? pending.disproverId : (currentSeat() || {}).id || null);
  const pause = createCoverPause({
    setTimer: safeTimeout, clearTimer: clearTimeout, unref: true, maxPauseMs: opts.maxCoverPauseMs,
    isWaitingOn: (id) => waitingOn() === id && !!find(id) && find(id).connected,
    onExpire: () => changed(),
  });
  const clock = pause.timer;

  function changed() {
    const turned = pause.sync();
    if (turned && turned.paused) act(turned.paused.map(nameOf).join(', '), '화면 가림 - 제한시간 멈춤');
    else if (turned) act('진행', `제한시간 다시 흐름 (${Math.round(turned.resumedAfterMs / 1000)}초 멈춤${turned.expired ? ', 멈출 수 있는 최대 시간 초과' : ''})`);
    notify();
  }

  const uniqueNickname = (value, exceptId) => uniqueName(new Set(players.filter((p) => p.id !== exceptId).map((p) => p.nickname)), value, makeId);

  // ───────────────────────────── 진행 ─────────────────────────────

  function armTimer() {
    clock.clear();
    const id = waitingOn();
    if (!id) return;
    const ms = step === 'disprove' ? disproveTimeoutMs : turnTimeoutMs;
    if (ms <= 0) return;
    clock.start(() => autoPlay(id), ms);
  }

  /** 다른 말이 서 있는 복도 칸(내 말은 빼고). */
  function blockedFor(seat) {
    const set = new Set();
    for (const [key, at] of Object.entries(positions)) {
      if (key !== seat.suspect && at.x !== undefined) set.add(cellKey(at.x, at.y));
    }
    return set;
  }
  const reachOf = (seat) => computeReach(positions[seat.suspect], moveLeft, blockedFor(seat));

  function finish(winnerSeat, reason) {
    clock.clear();
    pending = null;
    step = 'start';
    dice = null;
    moveLeft = 0;
    const solved = { suspect: solution.suspect, weapon: solution.weapon, room: solution.room };
    const solutionText = `${labelOf(solved.suspect)}, ${labelOf(solved.weapon)}, ${labelOf(solved.room)}`;
    let message;
    if (winnerSeat && reason === 'accusation') message = `${nameOf(winnerSeat.id)}님이 정확히 맞혔습니다! 범인은 ${solutionText}.`;
    else if (winnerSeat) message = `${nameOf(winnerSeat.id)}님만 남아 승리했습니다. 정답은 ${solutionText}.`;
    else message = `맞힌 사람이 없습니다. 정답은 ${solutionText}.`;
    phase = 'result';
    result = { winnerId: winnerSeat ? winnerSeat.id : null, winner: winnerSeat ? nameOf(winnerSeat.id) : null, reason: reason || 'none', solution: solved, message };
    // 이번 판을 뛴 사람(빠진 사람 제외)은 다음 판도 자동으로 준비된다. 빠지려면 준비를 취소한다.
    for (const p of players) p.ready = !!seatOf(p.id) && !seatOf(p.id).left;
    note(message);
    act('결과', message);
  }

  /** 남은 사람이 한 명이면 그 사람이 이기고, 아무도 없으면 승자 없이 끝난다. 끝났으면 true. */
  function settleIfDecided() {
    const left = active();
    if (left.length === 0) { finish(null, 'none'); return true; }
    if (left.length === 1) { finish(left[0], 'lastStanding'); return true; }
    return false;
  }

  function advance() {
    pending = null;
    dice = null;
    moveLeft = 0;
    step = 'start';
    for (let n = 1; n <= seats.length; n += 1) {
      const index = (turn + n) % seats.length;
      if (!seats[index].eliminated && !seats[index].left) {
        turn = index;
        const seat = seats[index];
        note(`${seat.nickname}님(${labelOf(seat.suspect)})의 차례입니다.`);
        armTimer();
        return;
      }
    }
    finish(null, 'none');
  }

  /** 보여 주기가 끝났다: 추측한 사람에게만 카드를 남기고 추측 뒤 단계로 넘어간다. */
  function revealCard(disproverSeat, card) {
    const asker = seatOf(pending.suggesterId);
    asker.seen.push({ card, byId: disproverSeat.id, by: nameOf(disproverSeat.id), suspect: pending.suspect, weapon: pending.weapon, room: pending.room });
    lastSuggestion.shownBy = disproverSeat.id;
    note(`${nameOf(disproverSeat.id)}님이 ${nameOf(asker.id)}님에게 카드를 보여 주었습니다.`);
    act(nameOf(disproverSeat.id), `카드 보여 줌 ${labelOf(card)} → ${nameOf(asker.id)}`);
    pending = null;
    step = 'end';
    armTimer();
  }

  /** 추측한 사람 다음부터 시계 방향으로 반박할 사람을 찾는다. 사람이 고를 일이 생기면 기다린다. */
  function resolveSuggestion() {
    const asker = seatOf(pending.suggesterId);
    const named = [pending.suspect, pending.weapon, pending.room];
    const from = seats.indexOf(asker);
    const passed = [];
    for (let n = 1; n < seats.length; n += 1) {
      const seat = seats[(from + n) % seats.length];
      const matches = seat.hand.filter((card) => named.includes(card));
      if (!matches.length) { passed.push(seat.id); continue; }
      pending.passed = passed;
      lastSuggestion.passed = passed.slice();
      if (matches.length === 1 || seat.left) { revealCard(seat, matches[0]); return; }
      pending.disproverId = seat.id;
      pending.options = matches;
      step = 'disprove';
      note(`${nameOf(seat.id)}님이 보여 줄 카드를 고르는 중입니다.`);
      armTimer();
      return;
    }
    lastSuggestion.passed = passed;
    lastSuggestion.shownBy = null;
    note('아무도 보여 줄 카드가 없었습니다.');
    pending = null;
    step = 'end';
    armTimer();
  }

  /** 제한시간이 지났다. 카드를 기다리던 중이면 첫 번째 카드를 보여 주고, 아니면 차례를 넘긴다. */
  function autoPlay(id) {
    const seat = seatOf(id);
    if (!seat || waitingOn() !== id) return;
    seat.idle += 1;
    act(nameOf(id), `시간 초과 (${seat.idle}/${IDLE_LIMIT})`);
    if (step === 'disprove') {
      note(`${nameOf(id)}님의 시간이 지나 카드를 대신 보여 주었습니다.`);
      revealCard(seat, pending.options[0]);
    } else {
      note(`${nameOf(id)}님의 시간이 지나 차례를 넘깁니다.`);
      advance();
    }
    if (phase === 'playing' && seat.idle >= IDLE_LIMIT && !seat.left) {
      note(`${nameOf(id)}님이 ${IDLE_LIMIT}번 연속 시간을 넘겨 게임에서 빠집니다.`);
      removeFromGame(find(id) || { id, nickname: seat.nickname }, `${IDLE_LIMIT}번 연속 시간을 넘겨`, true);
    }
    changed();
  }

  /** 게임 도중 사람이 빠졌다(나가기·돌아오지 않음·계속 시간 초과). quiet이면 안내 글은 이미 남겼다. */
  function removeFromGame(player, why, quiet) {
    const seat = seatOf(player.id);
    if (phase !== 'playing' || !seat || seat.left) return;
    const wasTurn = currentSeat() === seat;
    const wasDisprover = step === 'disprove' && pending && pending.disproverId === seat.id;
    seat.left = true;
    if (!quiet) note(`${player.nickname}님이 ${why} 게임에서 빠졌습니다.`);
    act(player.nickname, `게임에서 빠짐 (${why})`);
    if (settleIfDecided()) return;
    if (wasTurn) { advance(); return; }
    if (wasDisprover) {
      // 빠진 사람의 카드는 서버가 대신 보여 준다.
      const options = pending.options;
      revealCard(seat, options[0]);
    }
  }

  // ───────────────────────────── 참가 ─────────────────────────────

  const cancelDrop = (id) => { const timer = dropTimers.get(id); if (timer) clearTimeout(timer); dropTimers.delete(id); };

  function removeSeat(player) {
    cancelDrop(player.id);
    pause.forget(player.id);
    const index = players.indexOf(player);
    if (index >= 0) players.splice(index, 1);
    if (!players.some((p) => p.connected)) resetRoom();
  }

  function resetRoom() {
    for (const timer of dropTimers.values()) clearTimeout(timer);
    dropTimers.clear();
    pause.reset();
    players.length = 0; history.length = 0; seats = []; turn = 0; phase = 'lobby'; result = null;
    step = 'start'; dice = null; moveLeft = 0; solution = null; positions = {}; weaponRooms = {}; pending = null; lastSuggestion = null;
  }

  function join({ nickname, token }) {
    const clean = cleanNickname(nickname);
    if (!clean) return { error: '닉네임을 입력해 주세요.' };
    const restored = token ? players.find((p) => p.token === token) : null;
    if (restored) {
      cancelDrop(restored.id);
      restored.connected = true;
      restored.nickname = uniqueNickname(clean, restored.id);
      act(restored.nickname, '재접속');
      changed();
      return { playerId: restored.id, token: restored.token, restored: true };
    }
    if (players.length >= ROOM_CAPACITY) return { error: `방이 가득 찼습니다. (최대 ${ROOM_CAPACITY}명)` };
    const player = { id: makeId(), token: makeToken(), nickname: uniqueNickname(clean), connected: true, ready: false };
    players.push(player);
    act(player.nickname, `입장${phase === 'playing' ? ' (진행 중 - 다음 게임부터)' : ''}`);
    changed();
    return { playerId: player.id, token: player.token, restored: false };
  }

  function disconnect(id) {
    const player = find(id);
    if (!player || !player.connected) return;
    player.connected = false;
    pause.forget(id);
    act(player.nickname, '연결 끊김');
    if (inGame(id)) {
      const seconds = Math.max(1, Math.round(disconnectGraceMs / 1000));
      note(`${player.nickname}님의 연결이 끊겼습니다. ${seconds}초 안에 돌아오지 않으면 게임에서 빠집니다.`);
    }
    if (!players.some((p) => p.connected)) { resetRoom(); changed(); return; }
    const timer = safeTimeout(() => {
      dropTimers.delete(id);
      const still = find(id);
      if (!still || still.connected) return;
      act(still.nickname, '자리 정리 (돌아오지 않음)');
      removeFromGame(still, '돌아오지 않아');
      removeSeat(still);
      changed();
    }, Math.max(0, disconnectGraceMs));
    dropTimers.set(id, timer);
    changed();
  }

  function leave(id) {
    const player = find(id);
    if (!player) return;
    act(player.nickname, '나감');
    removeFromGame(player, '방을 나가');
    removeSeat(player);
    changed();
  }

  /** [보스 키] 이 사람의 화면이 가려졌는지/돌아왔는지. 화면이 알려 준다(public/cover.js). */
  function setCovered(id, covered) {
    if (!find(id)) return;
    pause.set(id, covered === true);
    changed();
  }

  // ───────────────────────────── 조작 ─────────────────────────────

  /** 접속자 목록(/order). 칩이 없는 게임이라 닉네임·접속·준비·이번 판 참여만 낸다. */
  function rosterList() {
    return players.map((p) => ({ id: p.id, nickname: p.nickname, connected: p.connected, chips: null, ready: !!p.ready, inRound: inGame(p.id) }));
  }

  function setReady(id, ready) {
    if (phase === 'playing') return '게임이 끝난 뒤에 준비할 수 있습니다.';
    const player = find(id);
    if (!player) return '참가자를 찾을 수 없습니다.';
    player.ready = !!ready;
    changed();
    return null;
  }

  const readyPlayers = () => players.filter((p) => p.connected && p.ready);

  function begin(id) {
    const starter = find(id);
    if (!starter || !starter.connected) return '방에 참가한 뒤 시작할 수 있습니다.';
    if (phase === 'playing') return '이미 게임이 진행 중입니다.';
    const going = readyPlayers();
    if (going.length < MIN_PLAYERS) return `준비한 참가자가 ${MIN_PLAYERS}명 이상이어야 합니다. 준비를 눌러 주세요.`;
    if (going.length > MAX_PLAYERS) return `클루는 ${MAX_PLAYERS}명까지 할 수 있습니다. 준비한 사람을 ${MAX_PLAYERS}명 이하로 맞춰 주세요.`;

    // 말은 무작위로 나눠 받고, 차례는 스칼렛부터 정해진 순서로 돈다.
    const characters = shuffle(SUSPECT_KEYS).slice(0, going.length).sort((a, b) => SUSPECT_KEYS.indexOf(a) - SUSPECT_KEYS.indexOf(b));
    const people = shuffle(going);
    seats = characters.map((suspect, index) => ({
      id: people[index].id, nickname: people[index].nickname, suspect, hand: [], seen: [], eliminated: false, left: false, idle: 0, summoned: false,
    }));
    solution = { suspect: pick(SUSPECT_KEYS), weapon: pick(WEAPON_KEYS), room: pick(ROOM_KEYS) };
    const rest = shuffle(CARD_KEYS.filter((key) => key !== solution.suspect && key !== solution.weapon && key !== solution.room));
    rest.forEach((card, index) => seats[index % seats.length].hand.push(card));
    for (const seat of seats) seat.hand.sort((a, b) => CARD_KEYS.indexOf(a) - CARD_KEYS.indexOf(b));
    positions = Object.fromEntries(SUSPECTS.map((s) => [s.key, { x: s.start.x, y: s.start.y }]));
    // 흉기는 서로 다른 방에 한 개씩 놓는다.
    const spots = shuffle(ROOM_KEYS).slice(0, WEAPON_KEYS.length);
    weaponRooms = Object.fromEntries(WEAPON_KEYS.map((weapon, index) => [weapon, spots[index]]));
    turn = 0;
    step = 'start';
    dice = null;
    moveLeft = 0;
    pending = null;
    lastSuggestion = null;
    result = null;
    phase = 'playing';
    for (const p of players) p.ready = false;
    note(`${going.length}명이 게임을 시작합니다. (${seats.map((s) => `${s.nickname}=${labelOf(s.suspect)}`).join(', ')})`);
    act(starter.nickname, `게임 시작 (${going.length}명: ${seats.map((s) => `${s.nickname}=${labelOf(s.suspect)}`).join(', ')})`);
    // 정답 봉투는 관리 로그에도 남기지 않는다.
    note(`${seats[0].nickname}님(${labelOf(seats[0].suspect)})의 차례입니다.`);
    armTimer();
    changed();
    return null;
  }

  /** 지금 차례인 사람의 요청인가. 맞으면 그 자리를 주고, 아니면 거절 이유를 문자열로 준다. */
  function turnOf(id) {
    if (phase !== 'playing') return '진행 중인 게임이 없습니다.';
    const seat = currentSeat();
    if (!seat || seat.id !== id) return '내 차례가 아닙니다.';
    if (step === 'disprove') return '다른 사람이 카드를 고르는 중입니다.';
    seat.idle = 0;
    return seat;
  }

  function roll(id) {
    const seat = turnOf(id);
    if (typeof seat === 'string') return seat;
    if (step !== 'start') return '이번 차례에는 이미 주사위를 굴렸습니다.';
    dice = [1 + Math.min(5, Math.floor(random() * 6)), 1 + Math.min(5, Math.floor(random() * 6))];
    moveLeft = dice[0] + dice[1];
    seat.summoned = false;
    step = 'move';
    note(`${seat.nickname}님이 주사위를 굴려 ${dice[0]} + ${dice[1]} = ${moveLeft}이(가) 나왔습니다.`);
    act(seat.nickname, `주사위 ${dice[0]} + ${dice[1]} = ${moveLeft}`);
    armTimer();
    changed();
    return null;
  }

  function passage(id) {
    const seat = turnOf(id);
    if (typeof seat === 'string') return seat;
    if (step !== 'start') return '비밀 통로는 주사위를 굴리기 전에만 쓸 수 있습니다.';
    const from = roomOf(seat);
    const room = from ? roomByKey(from) : null;
    if (!room || !room.passage) return '비밀 통로가 있는 모서리 방에 있어야 합니다.';
    positions[seat.suspect] = { room: room.passage };
    seat.summoned = false;
    step = 'suggest';
    note(`${seat.nickname}님이 비밀 통로로 ${labelOf(from)}에서 ${labelOf(room.passage)}(으)로 건너갔습니다.`);
    act(seat.nickname, `비밀 통로 ${labelOf(from)} → ${labelOf(room.passage)}`);
    armTimer();
    changed();
    return null;
  }

  /** target: { room } 또는 { x, y }. 굴린 눈 안에서 갈 수 있는 곳이어야 한다. */
  function move(id, target) {
    const seat = turnOf(id);
    if (typeof seat === 'string') return seat;
    if (step !== 'move') return step === 'start' ? '먼저 주사위를 굴려 주세요.' : '이번 차례에는 이미 움직였습니다.';
    if (!target || typeof target !== 'object') return '갈 곳을 골라 주세요.';
    const reach = reachOf(seat);
    if (typeof target.room === 'string') {
      if (!reach.rooms.includes(target.room)) return '그 방까지는 갈 수 없습니다. (거리가 멀거나 문이 막혀 있습니다)';
      positions[seat.suspect] = { room: target.room };
      moveLeft = 0;
      step = 'suggest';
      note(`${seat.nickname}님이 ${labelOf(target.room)}(으)로 들어갔습니다.`);
      act(seat.nickname, `이동 → ${labelOf(target.room)}`);
    } else {
      if (!Number.isInteger(target.x) || !Number.isInteger(target.y) || !reach.cells.some((c) => c.x === target.x && c.y === target.y)) return '그 칸까지는 갈 수 없습니다.';
      positions[seat.suspect] = { x: target.x, y: target.y };
      moveLeft = 0;
      step = 'end';
      act(seat.nickname, `이동 → (${target.x}, ${target.y})`);
    }
    armTimer();
    changed();
    return null;
  }

  function suggest(id, suspect, weapon) {
    const seat = turnOf(id);
    if (typeof seat === 'string') return seat;
    const room = roomOf(seat);
    const canAtStart = step === 'start' && seat.summoned && !!room;
    if (step !== 'suggest' && !canAtStart) return room ? '이번 차례에는 추측할 수 없습니다. (방에 들어왔을 때 한 번만 할 수 있습니다)' : '추측은 방 안에서만 할 수 있습니다.';
    if (!SUSPECT_KEYS.includes(suspect)) return '알 수 없는 범인입니다.';
    if (!WEAPON_KEYS.includes(weapon)) return '알 수 없는 흉기입니다.';
    seat.summoned = false;
    // 추측한 범인의 말과 흉기가 그 방으로 불려 온다. 말이 참가자의 것이면 그 사람은 다음 차례에 바로 추측할 수 있다.
    const movedFrom = positions[suspect].room;
    positions[suspect] = { room };
    weaponRooms[weapon] = room;
    const owner = seats.find((s) => s.suspect === suspect);
    if (owner && owner !== seat && movedFrom !== room) owner.summoned = true;
    suggestionSeq += 1;
    lastSuggestion = { seq: suggestionSeq, byId: seat.id, suspect, weapon, room, shownBy: null, passed: [] };
    pending = { suggesterId: seat.id, suspect, weapon, room, disproverId: null, options: [], passed: [] };
    note(`${seat.nickname}님의 추측: ${labelOf(suspect)}, ${labelOf(weapon)}, ${labelOf(room)}`);
    act(seat.nickname, `추측 ${labelOf(suspect)} / ${labelOf(weapon)} / ${labelOf(room)}`);
    resolveSuggestion();
    changed();
    return null;
  }

  function show(id, card) {
    if (phase !== 'playing' || step !== 'disprove' || !pending) return '지금은 카드를 보여 줄 차례가 아닙니다.';
    if (pending.disproverId !== id) return '지금은 내가 카드를 보여 줄 차례가 아닙니다.';
    if (typeof card !== 'string' || !pending.options.includes(card)) return '보여 줄 수 있는 카드가 아닙니다. (추측에 나온 카드 중에서 골라 주세요)';
    const seat = seatOf(id);
    seat.idle = 0;
    revealCard(seat, card);
    changed();
    return null;
  }

  function accuse(id, suspect, weapon, room) {
    const seat = turnOf(id);
    if (typeof seat === 'string') return seat;
    if (!SUSPECT_KEYS.includes(suspect)) return '알 수 없는 범인입니다.';
    if (!WEAPON_KEYS.includes(weapon)) return '알 수 없는 흉기입니다.';
    if (!ROOM_KEYS.includes(room)) return '알 수 없는 장소입니다.';
    const text = `${labelOf(suspect)}, ${labelOf(weapon)}, ${labelOf(room)}`;
    if (suspect === solution.suspect && weapon === solution.weapon && room === solution.room) {
      act(seat.nickname, `고발 성공 ${text}`);
      finish(seat, 'accusation');
      changed();
      return null;
    }
    seat.eliminated = true;
    note(`${seat.nickname}님이 ${text}(으)로 고발했지만 틀렸습니다. 탈락합니다.`);
    act(seat.nickname, `고발 실패 ${text}`);
    if (!settleIfDecided()) advance();
    changed();
    return null;
  }

  function endTurn(id) {
    const seat = turnOf(id);
    if (typeof seat === 'string') return seat;
    seat.summoned = false;
    advance();
    changed();
    return null;
  }

  // ───────────────────────────── 상태 ─────────────────────────────

  function stateFor(id) {
    const me = find(id);
    const seat = seatOf(id);
    const turnSeat = currentSeat();
    const mine = !!me && !!turnSeat && turnSeat.id === id && step !== 'disprove';
    const atRoom = seat ? roomOf(seat) : null;
    const here = atRoom ? roomByKey(atRoom) : null;
    const youDisprove = !!pending && step === 'disprove' && pending.disproverId === id;
    const readyCount = readyPlayers().length;
    return {
      type: 'clueState',
      phase,
      step,
      serverTime: Date.now(),
      map: MAP,
      suspects: SUSPECTS.map((s) => ({ key: s.key, label: s.label })),
      weapons: WEAPONS,
      rooms: ROOMS.map((r) => ({ key: r.key, label: r.label })),
      positions,
      weaponRooms,
      dice,
      moveLeft,
      turnId: turnSeat ? turnSeat.id : null,
      waitingId: waitingOn(),
      turnEndsAt: phase === 'playing' ? clock.endsAt() : null,
      paused: pause.pausedAt() !== null,
      pausedAt: pause.pausedAt(),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      readyCount,
      canStart: !!me && phase !== 'playing' && readyCount >= MIN_PLAYERS && readyCount <= MAX_PLAYERS,
      // 정답은 게임이 끝난 뒤에만 낸다.
      result,
      lastSuggestion,
      history: history.slice(-14),
      you: me ? {
        id: me.id,
        ready: me.ready,
        inGame: !!seat && !seat.left && phase === 'playing',
        suspect: seat ? seat.suspect : null,
        eliminated: !!seat && seat.eliminated,
        myTurn: mine,
        hand: seat ? seat.hand.slice() : [],
        seen: seat ? seat.seen.map((s) => ({ card: s.card, by: s.by, byId: s.byId, suspect: s.suspect, weapon: s.weapon, room: s.room })) : [],
        canRoll: mine && step === 'start',
        canPassage: mine && step === 'start' && !!here && !!here.passage,
        passageTo: mine && here ? here.passage || null : null,
        canSuggest: mine && !!atRoom && (step === 'suggest' || (step === 'start' && seat.summoned)),
        canAccuse: mine,
        canEnd: mine,
        reach: mine && step === 'move' ? reachOf(seat) : null,
        disprove: youDisprove ? { options: pending.options.slice(), suspect: pending.suspect, weapon: pending.weapon, room: pending.room, byId: pending.suggesterId } : null,
      } : null,
      // 차례 순서대로. 손에 든 카드는 장수만 보이고, 정답 카드는 어디에도 없다.
      board: seats.map((s) => ({
        id: s.id,
        nickname: nameOf(s.id),
        suspect: s.suspect,
        eliminated: s.eliminated,
        left: s.left,
        connected: !!find(s.id) && find(s.id).connected,
        cards: s.hand.length,
      })),
      players: players.filter((p) => p.connected || inGame(p.id)).map((p) => ({
        id: p.id, nickname: p.nickname, connected: p.connected, ready: p.ready, inGame: inGame(p.id),
      })),
    };
  }

  function dispose() {
    for (const timer of dropTimers.values()) clearTimeout(timer);
    dropTimers.clear();
    pause.dispose();
  }

  return {
    join, disconnect, leave, setCovered, setReady, begin, roll, passage, move, suggest, show, accuse, endTurn, rosterList, stateFor, dispose,
    // 테스트에서 상태를 정하고 들여다보기 위한 것. 서버는 쓰지 않는다.
    _debug: () => ({
      players, seats, phase, turn, step, dice, moveLeft, solution, positions, weaponRooms, pending,
      setDice: (next) => { dice = next.slice(); moveLeft = dice[0] + dice[1]; },
      setSolution: (next) => { solution = { ...next }; },
      setPosition: (suspect, at) => { positions[suspect] = at; },
      setHand: (seatId, hand) => { seatOf(seatId).hand = hand.slice(); },
    }),
    status: () => ({ phase, playerCount: players.filter((p) => p.connected).length }),
  };
}

module.exports = {
  createClueRoom, computeReach, isCorridor, MAP, SUSPECTS, WEAPONS, ROOMS, CARDS, MIN_PLAYERS, MAX_PLAYERS, DICE, GRID,
};
