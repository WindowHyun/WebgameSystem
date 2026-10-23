'use strict';

/**
 * 야추다이스(Yacht Dice) - 주사위 5개를 굴려 12개 칸의 점수판을 채우는 게임. 돈이나 칩은 걸지 않는다.
 *
 * [규칙] 기본 Yacht 규칙을 따른다(보너스 없음, 이론상 최대 297점).
 *   - 한 차례에 주사위 5개를 최대 3번 굴린다. 처음에는 5개를 모두 굴리고, 그다음부터는 "고정"하지 않은 주사위만
 *     다시 굴린다. 마음에 드는 족보가 나오면 남은 굴림을 쓰지 않고 바로 기록해도 된다.
 *   - 매 차례 아직 안 채운 칸 하나에 점수를 기록해야 한다(건너뛸 수 없다). 족보가 안 맞으면 0점이 기록된다.
 *   - 12칸을 모두 채우면 끝난다(12라운드). 총점이 가장 높은 사람이 이기고, 같으면 공동 순위다.
 *
 *   칸              점수
 *   1 ~ 6           그 눈이 나온 주사위의 합
 *   초이스          주사위 5개의 합
 *   포 카인드       같은 눈 4개 이상일 때 그 4개의 합(5개가 같아도 4개만 센다, 최대 24)
 *   풀 하우스       같은 눈 3개 + 다른 같은 눈 2개일 때 5개의 합(5개가 모두 같으면 풀 하우스가 아니다, 최대 28)
 *   리틀 스트레이트 1-2-3-4-5이면 30점
 *   빅 스트레이트   2-3-4-5-6이면 30점
 *   야추            5개가 모두 같으면 50점
 *
 * [기본값] 원작에 없는 온라인 사정은 이렇게 정했다.
 *   - 주사위는 서버가 굴린다(브라우저가 값을 정할 수 없다). 고정한 주사위는 모두의 화면에 보인다.
 *   - 차례마다 제한시간(기본 60초)이 있고, 넘기면 서버가 자동으로 점수가 가장 높은 칸에 기록한다(첫 굴림 전이면
 *     먼저 굴린다). 점수가 같으면 쓸모가 적은 칸(야추부터)에 기록한다. 보스 키로 화면을 가린 사람의 차례는 멈춘다.
 *   - 연결이 끊긴 사람이 유예(기본 30초) 안에 돌아오지 않으면 그 사람은 게임에서 빠지고, 남은 사람끼리 이어 간다.
 *     빠진 사람의 점수판은 남지만 순위에는 넣지 않는다. 혼자 남아도 끝까지 한다.
 *   - 혼자서도 할 수 있다(1~6명). 판이 끝나면 이번 판을 뛴 사람은 다음 판도 자동으로 준비된다.
 *   - 관리 로그에는 굴린 눈과 기록한 칸을 남긴다(모두의 화면에 보이는 정보라 숨길 것이 없다).
 */

const crypto = require('crypto');
const { createSafeTimeout, uniqueName } = require('./room-helpers');
const { cleanNickname } = require('./protocol');
const { createCoverPause } = require('./cover-pause');

const MIN_PLAYERS = 1;
const MAX_PLAYERS = 6;
// 한 판을 뛰는 인원과 별개로, 다음 판을 기다리며 구경할 자리를 둔다.
const ROOM_CAPACITY = 10;
const DICE = 5;
const ROLLS = 3;

const sum = (dice) => dice.reduce((total, value) => total + value, 0);
const countOf = (dice, face) => dice.filter((value) => value === face).length;
const counts = (dice) => [1, 2, 3, 4, 5, 6].map((face) => countOf(dice, face));
const has = (dice, faces) => faces.every((face) => dice.includes(face));
const upper = (face) => (dice) => face * countOf(dice, face);

/** key 순서가 곧 점수판의 칸 순서다. score는 주사위(5개)로 그 칸에 얼마를 기록하는지. dump는 버릴 칸을 고르는 우선순위(작을수록 먼저). */
const CATEGORIES = [
  { key: 'ones', label: '1', hint: '1의 눈 합계', score: upper(1), dump: 5 },
  { key: 'twos', label: '2', hint: '2의 눈 합계', score: upper(2), dump: 6 },
  { key: 'threes', label: '3', hint: '3의 눈 합계', score: upper(3), dump: 7 },
  { key: 'fours', label: '4', hint: '4의 눈 합계', score: upper(4), dump: 8 },
  { key: 'fives', label: '5', hint: '5의 눈 합계', score: upper(5), dump: 9 },
  { key: 'sixes', label: '6', hint: '6의 눈 합계', score: upper(6), dump: 10 },
  { key: 'choice', label: '초이스', hint: '주사위 5개의 합', score: sum, dump: 11 },
  {
    key: 'fourKind', label: '포 카인드', hint: '같은 눈 4개 이상이면 그 4개의 합', dump: 3,
    score: (dice) => { const face = counts(dice).findIndex((n) => n >= 4) + 1; return face ? face * 4 : 0; },
  },
  {
    key: 'fullHouse', label: '풀 하우스', hint: '3개 + 2개이면 5개의 합', dump: 4,
    score: (dice) => { const c = counts(dice).filter(Boolean).sort(); return c.length === 2 && c[0] === 2 && c[1] === 3 ? sum(dice) : 0; },
  },
  { key: 'littleStraight', label: '리틀 스트레이트', hint: '1-2-3-4-5이면 30점', score: (dice) => (has(dice, [1, 2, 3, 4, 5]) ? 30 : 0), dump: 2 },
  { key: 'bigStraight', label: '빅 스트레이트', hint: '2-3-4-5-6이면 30점', score: (dice) => (has(dice, [2, 3, 4, 5, 6]) ? 30 : 0), dump: 1 },
  { key: 'yacht', label: '야추', hint: '5개가 모두 같으면 50점', score: (dice) => (counts(dice).some((n) => n === DICE) ? 50 : 0), dump: 0 },
];
const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
const ROUNDS = CATEGORIES.length;
const MAX_SCORE = 297; // 이론상 최대 (1~6에서 105 + 초이스 30 + 포 카인드 24 + 풀 하우스 28 + 스트레이트 60 + 야추 50)

/** 주사위(5개)로 그 칸에 기록할 점수. 알 수 없는 칸이면 null. */
function scoreOf(key, dice) {
  const category = CATEGORIES.find((c) => c.key === key);
  if (!category || !Array.isArray(dice) || dice.length !== DICE) return null;
  return category.score(dice);
}

function blankSheet() {
  return Object.fromEntries(CATEGORY_KEYS.map((key) => [key, null]));
}
const totalOf = (sheet) => CATEGORY_KEYS.reduce((total, key) => total + (sheet[key] || 0), 0);
const filled = (sheet) => CATEGORY_KEYS.filter((key) => sheet[key] !== null).length;

function createYachtRoom(options) {
  const opts = options || {};
  const notify = opts.onChange || (() => {});
  const onAction = opts.onAction || (() => {});
  const act = (who, what) => { try { onAction(who, what); } catch { /* 로그 실패는 무시 */ } };
  const random = opts.random || Math.random;
  const turnTimeoutMs = Number.isFinite(opts.turnTimeoutMs) ? opts.turnTimeoutMs : 60000;
  const disconnectGraceMs = Number.isFinite(opts.disconnectGraceMs) ? opts.disconnectGraceMs : 30000;
  // 타이머 콜백에서 난 예외가 프로세스까지 올라가지 않게 감싼다.
  const safeTimeout = createSafeTimeout('야추다이스');

  const players = []; // { id, token, nickname, connected, ready }
  const history = [];
  let phase = 'lobby'; // lobby | playing | result
  let seats = [];      // 이번 판 참가자 { id, nickname, sheet, left }. 빠진 사람도 점수판은 남는다.
  let turn = 0;        // seats 안에서 지금 차례인 사람의 자리
  let dice = Array(DICE).fill(0);
  let held = Array(DICE).fill(false);
  let rollsLeft = ROLLS;
  let result = null;   // { ranking: [{ id, nickname, total, rank }], winners: [닉네임], message }
  const dropTimers = new Map();

  const makeId = () => crypto.randomBytes(8).toString('hex');
  const makeToken = () => crypto.randomBytes(18).toString('hex');
  const note = (text) => { history.push({ text, timestamp: Date.now() }); if (history.length > 40) history.shift(); };
  const find = (id) => players.find((p) => p.id === id);
  const seatOf = (id) => seats.find((s) => s.id === id);
  const nameOf = (id) => (find(id) || seatOf(id) || {}).nickname || '(나간 참가자)';
  const currentSeat = () => (phase === 'playing' ? seats[turn] || null : null);
  const inGame = (id) => { const seat = seatOf(id); return phase === 'playing' && !!seat && !seat.left; };
  const rolled = () => rollsLeft < ROLLS;

  // [보스 키] 차례인 사람이 화면을 가리고 있으면 그 사람의 제한시간을 멈춘다(web/cover-pause.js).
  const pause = createCoverPause({
    setTimer: safeTimeout, clearTimer: clearTimeout, unref: true, maxPauseMs: opts.maxCoverPauseMs,
    isWaitingOn: (id) => { const seat = currentSeat(); return !!seat && seat.id === id && !!find(id) && find(id).connected; },
    onExpire: () => changed(),
  });
  const clock = pause.timer;

  /** 상태를 알리기 직전마다 멈춤 여부를 맞춘다. 차례가 넘어가는 것도 여기서 반영된다. */
  function changed() {
    const turned = pause.sync();
    if (turned && turned.paused) act(turned.paused.map(nameOf).join(', '), '화면 가림 - 제한시간 멈춤');
    else if (turned) act('진행', `제한시간 다시 흐름 (${Math.round(turned.resumedAfterMs / 1000)}초 멈춤${turned.expired ? ', 멈출 수 있는 최대 시간 초과' : ''})`);
    notify();
  }

  const uniqueNickname = (value, exceptId) => uniqueName(new Set(players.filter((p) => p.id !== exceptId).map((p) => p.nickname)), value, makeId);

  // ───────────────────────────── 진행 ─────────────────────────────

  function armTurnTimer() {
    clock.clear();
    const seat = currentSeat();
    if (!seat || turnTimeoutMs <= 0) return;
    clock.start(() => autoPlay(seat.id), turnTimeoutMs);
  }

  /** 지금 차례를 새로 시작한다(주사위·고정·굴림 횟수를 비운다). */
  function startTurn() {
    dice = Array(DICE).fill(0);
    held = Array(DICE).fill(false);
    rollsLeft = ROLLS;
    armTurnTimer();
  }

  /** 점수판이 다 안 찼고 아직 있는 사람 중 지금 자리 다음 사람. 없으면 -1(게임 끝). */
  function nextTurnIndex(from) {
    for (let step = 1; step <= seats.length; step += 1) {
      const index = (from + step) % seats.length;
      const seat = seats[index];
      if (!seat.left && filled(seat.sheet) < ROUNDS) return index;
    }
    return -1;
  }

  function advance() {
    const next = nextTurnIndex(turn);
    if (next < 0) { finish(); return; }
    turn = next;
    startTurn();
  }

  function finish() {
    clock.clear();
    const stayed = seats.filter((s) => !s.left);
    const ranked = stayed
      .map((s) => ({ id: s.id, nickname: nameOf(s.id), total: totalOf(s.sheet) }))
      .sort((a, b) => b.total - a.total);
    // 같은 점수는 같은 순위(1, 1, 3)
    ranked.forEach((entry, index) => { entry.rank = index > 0 && entry.total === ranked[index - 1].total ? ranked[index - 1].rank : index + 1; });
    const winners = ranked.filter((entry) => entry.rank === 1).map((entry) => entry.nickname);
    let message;
    if (!ranked.length) message = '함께하던 사람이 모두 빠져 게임을 마칩니다.';
    else if (ranked.length === 1) message = `게임 끝! ${ranked[0].nickname}님의 점수는 ${ranked[0].total}점입니다.`;
    else if (winners.length > 1) message = `게임 끝! ${winners.join(', ')}님이 ${ranked[0].total}점으로 공동 1위입니다.`;
    else message = `게임 끝! ${winners[0]}님이 ${ranked[0].total}점으로 우승했습니다.`;
    phase = 'result';
    result = { ranking: ranked, winners, message };
    dice = Array(DICE).fill(0);
    held = Array(DICE).fill(false);
    rollsLeft = ROLLS;
    // 이번 판을 뛴 사람은 다음 판도 자동으로 준비된다. 빠지려면 준비를 취소한다.
    for (const p of players) p.ready = !!seatOf(p.id) && !seatOf(p.id).left;
    note(message);
    act('결과', `${message} (${ranked.map((e) => `${e.nickname} ${e.total}점`).join(', ')})`);
  }

  /** 지금 차례인 사람의 점수판 한 칸에 기록하고 다음 차례로 넘어간다. */
  function commit(seat, key) {
    const points = scoreOf(key, dice);
    seat.sheet[key] = points;
    const label = CATEGORIES.find((c) => c.key === key).label;
    note(`${nameOf(seat.id)}님이 ${label}에 ${points}점을 기록했습니다. (${dice.join(' ')})`);
    act(nameOf(seat.id), `기록 ${label} ${points}점 (${dice.join(' ')}) → 합계 ${totalOf(seat.sheet)}점`);
    advance();
  }

  /** 제한시간이 지났다: 첫 굴림 전이면 굴리고, 점수가 가장 높은 칸(같으면 쓸모가 적은 칸)에 기록한다. */
  function autoPlay(id) {
    const seat = currentSeat();
    if (!seat || seat.id !== id) return;
    if (!rolled()) rollDice();
    const open = CATEGORIES.filter((c) => seat.sheet[c.key] === null)
      .map((c) => ({ key: c.key, points: c.score(dice), dump: c.dump }))
      .sort((a, b) => b.points - a.points || a.dump - b.dump);
    act(nameOf(id), '시간 초과 - 자동 기록');
    note(`${nameOf(id)}님의 시간이 지나 자동으로 기록했습니다.`);
    commit(seat, open[0].key);
    changed();
  }

  /** 주사위를 굴린다(고정하지 않은 것만. 첫 굴림이면 모두). 굴림 횟수를 하나 쓴다. */
  function rollDice() {
    const first = rollsLeft === ROLLS;
    for (let i = 0; i < DICE; i += 1) {
      if (first || !held[i]) dice[i] = 1 + Math.min(5, Math.floor(random() * 6));
    }
    rollsLeft -= 1;
    if (rollsLeft === 0) held = Array(DICE).fill(false);
  }

  /** 게임 도중 사람이 빠졌다(나가기·돌아오지 않음). */
  function removeFromGame(player, why) {
    const seat = seatOf(player.id);
    if (phase !== 'playing' || !seat || seat.left) return;
    const wasTurn = currentSeat() === seat;
    seat.left = true;
    note(`${player.nickname}님이 ${why} 게임에서 빠졌습니다.`);
    act(player.nickname, `게임에서 빠짐 (${why}, 점수 ${totalOf(seat.sheet)}점)`);
    if (!seats.some((s) => !s.left)) { finish(); return; }
    if (wasTurn) advance();
    else if (seats.every((s) => s.left || filled(s.sheet) >= ROUNDS)) finish();
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
    dice = Array(DICE).fill(0); held = Array(DICE).fill(false); rollsLeft = ROLLS;
  }

  function join({ nickname, token }) {
    const clean = cleanNickname(nickname); // 글자 단위로 자른다(web/protocol.js)
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
    if (going.length > MAX_PLAYERS) return `야추다이스는 ${MAX_PLAYERS}명까지 할 수 있습니다. 준비한 사람을 ${MAX_PLAYERS}명 이하로 맞춰 주세요.`;
    seats = going.map((p) => ({ id: p.id, nickname: p.nickname, sheet: blankSheet(), left: false }));
    turn = 0;
    result = null;
    phase = 'playing';
    for (const p of players) p.ready = false;
    note(`${going.length}명이 게임을 시작합니다. (${going.map((p) => p.nickname).join(', ')})`);
    act(starter.nickname, `게임 시작 (${going.length}명: ${going.map((p) => p.nickname).join(', ')})`);
    startTurn();
    changed();
    return null;
  }

  /** 지금 차례인 사람의 요청인가. 아니면 거절 이유. */
  function myTurn(id) {
    if (phase !== 'playing') return '진행 중인 게임이 없습니다.';
    const seat = currentSeat();
    if (!seat || seat.id !== id) return '내 차례가 아닙니다.';
    return null;
  }

  function roll(id) {
    const problem = myTurn(id);
    if (problem) return problem;
    if (rollsLeft <= 0) return '이번 차례에 굴릴 수 있는 횟수를 모두 썼습니다. 점수를 기록해 주세요.';
    if (rolled() && held.every(Boolean)) return '다시 굴릴 주사위가 없습니다. 고정을 풀거나 점수를 기록해 주세요.';
    const kept = rolled() ? held.map((h, i) => (h ? i + 1 : null)).filter(Boolean) : [];
    rollDice();
    act(nameOf(id), `굴림 ${ROLLS - rollsLeft}/${ROLLS}: ${dice.join(' ')}${kept.length ? ` (${kept.join(',')}번째 주사위 고정)` : ''}`);
    changed();
    return null;
  }

  /** 다시 굴리지 않고 남길 주사위를 정한다(5개 각각 true/false). 모두의 화면에 보인다. */
  function hold(id, next) {
    const problem = myTurn(id);
    if (problem) return problem;
    if (!rolled()) return '먼저 주사위를 굴려 주세요.';
    if (rollsLeft <= 0) return '굴릴 수 있는 횟수를 모두 썼습니다. 점수를 기록해 주세요.';
    if (!Array.isArray(next) || next.length !== DICE || !next.every((v) => typeof v === 'boolean')) return '고정할 주사위를 확인해 주세요.';
    held = next.slice();
    changed();
    return null;
  }

  function score(id, key) {
    const problem = myTurn(id);
    if (problem) return problem;
    if (!rolled()) return '먼저 주사위를 굴려 주세요.';
    if (typeof key !== 'string' || !CATEGORY_KEYS.includes(key)) return '알 수 없는 칸입니다.';
    const seat = currentSeat();
    if (seat.sheet[key] !== null) return '이미 기록한 칸입니다.';
    commit(seat, key);
    changed();
    return null;
  }

  // ───────────────────────────── 상태 ─────────────────────────────

  function stateFor(id) {
    const me = find(id);
    const seat = seatOf(id);
    const turnSeat = currentSeat();
    const mine = !!me && !!turnSeat && turnSeat.id === id;
    const readyCount = readyPlayers().length;
    const inGameNow = !!seat && !seat.left && phase === 'playing';
    // 내 차례에 굴린 뒤에만, 비어 있는 칸마다 지금 주사위로 얼마를 기록하는지 알려 준다.
    const options = mine && rolled() ? Object.fromEntries(CATEGORIES.filter((c) => seat.sheet[c.key] === null).map((c) => [c.key, c.score(dice)])) : null;
    return {
      type: 'yachtState',
      phase,
      serverTime: Date.now(),
      categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, hint: c.hint })),
      rounds: ROUNDS,
      maxScore: MAX_SCORE,
      round: turnSeat ? filled(turnSeat.sheet) + 1 : 0,
      turnId: turnSeat ? turnSeat.id : null,
      dice: dice.slice(),
      held: held.slice(),
      rollsLeft,
      rolls: ROLLS,
      rolled: rolled(),
      turnEndsAt: phase === 'playing' ? clock.endsAt() : null,
      // 차례인 사람이 화면을 가려 제한시간이 멈춰 있는가(web/cover-pause.js)
      paused: pause.pausedAt() !== null,
      pausedAt: pause.pausedAt(),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      readyCount,
      canStart: !!me && phase !== 'playing' && readyCount >= MIN_PLAYERS && readyCount <= MAX_PLAYERS,
      result,
      history: history.slice(-12),
      you: me ? {
        id: me.id,
        ready: me.ready,
        inGame: inGameNow,
        myTurn: mine,
        canRoll: mine && rollsLeft > 0 && !(rolled() && held.every(Boolean)),
        canScore: mine && rolled(),
        options,
      } : null,
      // 점수판은 모두에게 보이는 정보다. 빠진 사람의 칸도 남긴다.
      board: seats.map((s) => ({
        id: s.id,
        nickname: nameOf(s.id),
        left: s.left,
        connected: !!find(s.id) && find(s.id).connected,
        sheet: Object.assign({}, s.sheet),
        total: totalOf(s.sheet),
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
    join, disconnect, leave, setCovered, setReady, begin, roll, hold, score, rosterList, stateFor, dispose,
    // 테스트에서 주사위를 정하고 들여다보기 위한 것. 서버는 쓰지 않는다.
    _debug: () => ({ players, seats, phase, turn, rollsLeft, dice, held, setDice: (next) => { dice = next.slice(); } }),
    status: () => ({ phase, playerCount: players.filter((p) => p.connected).length }),
  };
}

module.exports = { createYachtRoom, scoreOf, CATEGORIES, MIN_PLAYERS, MAX_PLAYERS, ROUNDS, ROLLS, DICE, MAX_SCORE };
