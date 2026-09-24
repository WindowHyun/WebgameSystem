'use strict';

/**
 * 더 마인드(The Mind) - 말없이 "감"만으로 모두의 카드를 작은 수부터 순서대로 내는 협동 게임.
 *
 * [규칙] 원작(볼프강 바르쉬) 규칙을 따른다.
 *   - 2~4명. 카드는 1~100. 레벨 N에서는 각자 N장을 받는다(레벨마다 새로 섞어 나눈다).
 *   - 차례가 없다. 누구든 "지금이다" 싶을 때 자기 카드 중 가장 작은 것을 가운데에 낸다.
 *     모두의 카드가 오름차순으로 나오면 그 레벨을 깬다. 숫자에 대한 소통은 금지라서
 *     이 화면에는 채팅이 없다.
 *   - 낸 카드보다 작은 카드를 누가 들고 있었으면 실수다. 목숨을 하나 잃고, 그보다 작은
 *     카드는 모두 공개하고 버린 뒤 이어 간다. 목숨이 0이 되면 진다.
 *   - 수리검: 누구든 제안하고 모두 동의하면 하나를 써서, 각자 가장 작은 카드를 한 장씩
 *     공개하고 버린다.
 *   - 시작 목숨 = 인원수, 수리검 1개. 레벨 2·5·8을 깨면 수리검, 3·6·9를 깨면 목숨
 *     (최대 목숨 5, 수리검 3). 2명 12레벨, 3명 10레벨, 4명 8레벨을 깨면 이긴다.
 *   - 집중: 레벨을 시작할 때 모두 "집중 완료"를 눌러야 시작한다. 진행 중에도 누구든
 *     "잠깐 멈춤"으로 다시 집중할 수 있다.
 *
 * [기본값] 원작에 없는 온라인 사정은 이렇게 정했다.
 *   - 거의 동시에 냈으면 서버에 먼저 도착한 쪽이 먼저 낸 것이다.
 *   - 카드는 항상 가장 작은 것부터 낸다(버튼 하나). 원작에서도 그렇게 하는 것이 전부다.
 *   - 실수한 뒤에는 모두 다시 집중한다(무엇이 버려졌는지 보고 숨을 고른다).
 *   - 레벨 도중 누가 끊기거나 보스 키로 화면을 가리면 멈춘다(집중 단계로 돌아간다).
 *     끊긴 사람이 유예(disconnectGraceMs) 안에 돌아오지 않으면 그 사람 카드는 벌칙
 *     없이 버리고 남은 사람끼리 이어 간다. 두 명 아래로 줄면 게임을 마친다.
 *   - 관리 로그에는 낸 카드와 버려진 카드만 남긴다. 나눠 준 손패는 남기지 않는다 -
 *     로그를 보는 운영자가 같이 하면 남의 카드를 미리 알게 된다.
 */

const crypto = require('crypto');
const { error: logError } = require('../logger');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
// 한 판을 뛰는 인원(최대 4명)과 별개로, 다음 판을 기다리며 구경할 자리를 둔다.
const ROOM_CAPACITY = 6;
const LEVELS_BY_COUNT = { 2: 12, 3: 10, 4: 8 };
const REWARDS = { 2: 'star', 3: 'life', 5: 'star', 6: 'life', 8: 'star', 9: 'life' };
const MAX_LIVES = 5;
const MAX_STARS = 3;

function createMindRoom(options) {
  const opts = options || {};
  const notify = opts.onChange || (() => {});
  const onAction = opts.onAction || (() => {});
  const act = (who, what) => { try { onAction(who, what); } catch { /* 로그 실패는 무시 */ } };
  const random = opts.random || Math.random;
  const proposalTimeoutMs = Number.isFinite(opts.proposalTimeoutMs) ? opts.proposalTimeoutMs : 30000;
  const disconnectGraceMs = Number.isFinite(opts.disconnectGraceMs) ? opts.disconnectGraceMs : 10000;
  // 타이머 콜백에서 난 예외가 프로세스까지 올라가지 않게 감싼다(web/poker-room.js 참고).
  const safeTimeout = (fn, ms) => {
    const timer = setTimeout(() => {
      try { fn(); } catch (err) { logError(`[더 마인드 진행 처리 실패] ${err && err.stack ? err.stack : err}`); }
    }, ms);
    if (timer.unref) timer.unref();
    return timer;
  };

  const players = []; // { id, token, nickname, connected, ready, focused, hand: [] }
  const history = [];
  let phase = 'lobby'; // lobby | focus | playing | result
  let roster = [];     // 이번 게임을 뛰는 사람(시작할 때 정해지고, 떠나면 줄어든다)
  let level = 0;
  let levels = 0;
  let lives = 0;
  let stars = 0;
  let pile = [];       // 이번 레벨에 낸 카드 { value, byId, by }
  let discarded = [];  // 이번 레벨에 버려진 카드 { value, owner, reason: 'mistake' | 'star' | 'left' }
  let lastEvent = null; // 화면이 크게 보여 줄 마지막 사건 { kind, text }
  let pauseReason = null;
  let starVote = null; // { id, byId, byName, agreed: Set }
  let starTimer = null;
  let result = null;   // { won, ended, level, levels, message }
  const dropTimers = new Map();

  const makeId = () => crypto.randomBytes(8).toString('hex');
  const makeToken = () => crypto.randomBytes(18).toString('hex');
  const note = (text) => { history.push({ text, timestamp: Date.now() }); if (history.length > 40) history.shift(); };
  const find = (id) => players.find((p) => p.id === id);
  const nameOf = (id) => (find(id) || {}).nickname || '(나간 참가자)';
  const inGame = (id) => (phase === 'focus' || phase === 'playing') && roster.includes(id);
  const rosterPlayers = () => roster.map(find).filter(Boolean);
  const changed = () => notify();

  function uniqueNickname(value, exceptId) {
    const used = new Set(players.filter((p) => p.id !== exceptId).map((p) => p.nickname));
    if (!used.has(value)) return value;
    // 글자(코드 포인트) 단위로 자른다. slice()는 UTF-16 단위라 이모지를 반으로 가른다.
    const head = (count) => Array.from(value).slice(0, count).join('');
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${head(20)}(${n})`;
      if (!used.has(candidate)) return candidate;
    }
    return `${head(18)}-${makeId().slice(0, 4)}`;
  }

  function shuffledDeck() {
    const cards = Array.from({ length: 100 }, (_, i) => i + 1);
    for (let i = cards.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  // ───────────────────────────── 진행 ─────────────────────────────

  function clearStarVote() {
    if (starTimer) clearTimeout(starTimer);
    starTimer = null;
    starVote = null;
  }

  /** 집중 단계로 간다(레벨 시작·실수 뒤·멈춤·끊김·화면 가림). 모두 다시 "집중 완료"를 눌러야 한다. */
  function enterFocus(reason) {
    phase = 'focus';
    pauseReason = reason;
    for (const p of rosterPlayers()) p.focused = false;
    if (starVote) { clearStarVote(); note('멈춰서 수리검 투표가 취소되었습니다.'); }
  }

  function startLevel() {
    const deck = shuffledDeck();
    for (const p of rosterPlayers()) p.hand = deck.splice(0, level).sort((a, b) => a - b);
    pile = [];
    discarded = [];
    note(`레벨 ${level}을 시작합니다. 각자 ${level}장씩 받았습니다.`);
    act('진행', `레벨 ${level}/${levels} 시작 (${roster.length}명 × ${level}장, 목숨 ${lives} · 수리검 ${stars})`);
    enterFocus(`레벨 ${level} - 모두 "집중 완료"를 누르면 시작합니다.`);
  }

  const handsEmpty = () => rosterPlayers().every((p) => p.hand.length === 0);

  function finish(won, message, ended) {
    clearStarVote();
    phase = 'result';
    pauseReason = null;
    result = { won, ended: !!ended, level, levels, message };
    for (const p of players) { p.ready = false; p.focused = false; }
    note(message);
    act('결과', message);
  }

  /**
   * 레벨을 깼다. before는 이 레벨을 끝낸 마지막 사건(실수·수리검)이다 - 실수로 남은 카드가
   * 다 버려져 끝났는데 "레벨 통과!"만 크게 보이면, 무엇이 버려졌는지 아무도 모른다.
   */
  function completeLevel(before) {
    const reward = REWARDS[level];
    let rewardText = '';
    // [이슈] 남은 카드가 떠난 사람 것뿐이라 끝난 레벨은 깬 것이 아니다. 예전에는 그대로
    // "통과"로 쳐서 보상을 받았고, 마지막 레벨이면 치르지도 않은 게임을 이긴 것이 됐다
    // (어려운 카드를 들고 나가 버리면 되는 셈이었다). 보상 없이 넘어가고, 마지막 레벨이면
    // 승패 없이 끝낸다.
    if (before && before.kind === 'left') {
      note(`레벨 ${level}은 남은 카드가 빠진 사람 것뿐이라 보상 없이 넘어갑니다.`);
      act('진행', `레벨 ${level} 보상 없이 넘어감 (남은 카드가 빠진 사람 것뿐)`);
      lastEvent = { kind: 'left', text: `${before.text} → 레벨 ${level}은 보상 없이 넘어갑니다` };
      if (level >= levels) {
        finish(false, '마지막 레벨을 끝까지 치르지 못해 승패 없이 게임을 마칩니다.', true);
        return;
      }
      level += 1;
      startLevel();
      return;
    }
    if (reward === 'star' && stars < MAX_STARS) { stars += 1; rewardText = ' 보상으로 수리검 1개를 받았습니다.'; }
    if (reward === 'life' && lives < MAX_LIVES) { lives += 1; rewardText = ' 보상으로 목숨 1개를 받았습니다.'; }
    note(`레벨 ${level} 통과!${rewardText}`);
    act('진행', `레벨 ${level} 통과${rewardText ? ` (${reward === 'star' ? '수리검' : '목숨'} +1)` : ''} → 목숨 ${lives} · 수리검 ${stars}`);
    lastEvent = before
      ? { kind: before.kind, text: `${before.text} → 레벨 ${level} 통과!${rewardText}` }
      : { kind: 'clear', text: `레벨 ${level} 통과!${rewardText}` };
    if (level >= levels) {
      finish(true, `모든 레벨(${levels})을 깼습니다. 승리!`);
      return;
    }
    level += 1;
    startLevel();
  }

  /** 레벨 도중 사람이 빠졌다(나가기·돌아오지 않음). 그 사람 카드는 벌칙 없이 버린다. */
  function removeFromGame(player, why) {
    if (!inGame(player.id)) return;
    for (const value of player.hand) discarded.push({ value, owner: player.nickname, reason: 'left' });
    const dropped = player.hand;
    player.hand = [];
    roster = roster.filter((id) => id !== player.id);
    note(`${player.nickname}님이 ${why} 게임에서 빠졌습니다.${dropped.length ? ` 들고 있던 ${dropped.join(', ')}은(는) 버립니다.` : ''}`);
    act(player.nickname, `게임에서 빠짐 (${why}${dropped.length ? `, 버린 카드 ${dropped.join(', ')}` : ''})`);
    if (roster.length < MIN_PLAYERS) {
      finish(false, '함께할 사람이 부족해 게임을 마칩니다.', true);
      return;
    }
    if (handsEmpty()) { completeLevel({ kind: 'left', text: `${player.nickname}님이 빠져 남은 카드가 없습니다` }); return; }
    enterFocus(`${player.nickname}님이 빠졌습니다. 남은 사람끼리 이어 갑니다 - 다시 집중하세요.`);
  }

  // ───────────────────────────── 참가 ─────────────────────────────

  const cancelDrop = (id) => { const timer = dropTimers.get(id); if (timer) clearTimeout(timer); dropTimers.delete(id); };

  function removeSeat(player) {
    cancelDrop(player.id);
    const index = players.indexOf(player);
    if (index >= 0) players.splice(index, 1);
    if (!players.some((p) => p.connected)) resetRoom();
  }

  function resetRoom() {
    clearStarVote();
    for (const timer of dropTimers.values()) clearTimeout(timer);
    dropTimers.clear();
    players.length = 0; history.length = 0; phase = 'lobby'; roster = [];
    level = 0; levels = 0; lives = 0; stars = 0; pile = []; discarded = []; lastEvent = null;
    pauseReason = null; result = null;
  }

  function join({ nickname, token }) {
    const clean = Array.from(String(nickname || '').trim()).slice(0, 24).join('');
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
    const player = { id: makeId(), token: makeToken(), nickname: uniqueNickname(clean), connected: true, ready: false, focused: false, hand: [] };
    players.push(player);
    const watching = phase === 'focus' || phase === 'playing';
    act(player.nickname, `입장${watching ? ' (진행 중 - 다음 게임부터)' : ''}`);
    changed();
    return { playerId: player.id, token: player.token, restored: false };
  }

  function disconnect(id) {
    const player = find(id);
    if (!player || !player.connected) return;
    player.connected = false;
    player.focused = false;
    act(player.nickname, '연결 끊김');
    if (inGame(id)) {
      const seconds = Math.max(1, Math.round(disconnectGraceMs / 1000));
      note(`${player.nickname}님의 연결이 끊겼습니다. ${seconds}초 안에 돌아오지 않으면 그 사람 카드를 빼고 이어 갑니다.`);
      enterFocus(`${player.nickname}님의 연결이 끊겨 잠시 멈췄습니다.`);
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

  // ───────────────────────────── 조작 ─────────────────────────────

  function setReady(id, ready) {
    if (phase !== 'lobby' && phase !== 'result') return '게임이 끝난 뒤에 준비할 수 있습니다.';
    const player = find(id);
    if (!player) return '참가자를 찾을 수 없습니다.';
    player.ready = !!ready;
    changed();
    return null;
  }

  function begin(id) {
    const starter = find(id);
    if (!starter || !starter.connected) return '방에 참가한 뒤 시작할 수 있습니다.';
    if (phase !== 'lobby' && phase !== 'result') return '이미 게임이 진행 중입니다.';
    const ready = players.filter((p) => p.connected && p.ready);
    if (ready.length < MIN_PLAYERS) return `준비한 참가자가 ${MIN_PLAYERS}명 이상이어야 합니다.`;
    if (ready.length > MAX_PLAYERS) return `더 마인드는 ${MAX_PLAYERS}명까지 할 수 있습니다. 준비한 사람을 ${MAX_PLAYERS}명 이하로 맞춰 주세요.`;
    roster = ready.map((p) => p.id);
    for (const p of players) { p.hand = []; p.focused = false; }
    levels = LEVELS_BY_COUNT[roster.length];
    lives = roster.length;
    stars = 1;
    level = 1;
    result = null;
    lastEvent = null;
    note(`${roster.length}명이 게임을 시작합니다. ${levels}레벨까지 깨면 승리합니다. (목숨 ${lives} · 수리검 ${stars})`);
    act(starter.nickname, `게임 시작 (${roster.length}명: ${ready.map((p) => p.nickname).join(', ')} · ${levels}레벨)`);
    startLevel();
    changed();
    return null;
  }

  /** "집중 완료"(또는 취소). 모두 집중하면 레벨이 이어진다. */
  function focus(id, value) {
    if (phase !== 'focus') return '지금은 집중 단계가 아닙니다.';
    const player = find(id);
    if (!player || !roster.includes(id)) return '이번 게임 참가자가 아닙니다.';
    player.focused = value !== false;
    const everyone = rosterPlayers();
    if (everyone.every((p) => p.connected && p.focused)) {
      phase = 'playing';
      pauseReason = null;
      note('모두 집중했습니다. 시작하세요!');
      act('진행', `모두 집중 - 레벨 ${level} 진행`);
    }
    changed();
    return null;
  }

  /** 잠깐 멈춤: 누구든 레벨 도중에 다시 집중하자고 할 수 있다. */
  function pause(id) {
    if (phase !== 'playing') return '진행 중일 때만 멈출 수 있습니다.';
    if (!roster.includes(id)) return '이번 게임 참가자가 아닙니다.';
    note(`${nameOf(id)}님이 잠깐 멈췄습니다.`);
    act(nameOf(id), '잠깐 멈춤');
    enterFocus(`${nameOf(id)}님이 잠깐 멈췄습니다. 다시 집중하세요.`);
    changed();
    return null;
  }

  /** 카드 내기: 항상 내 카드 중 가장 작은 것을 낸다. */
  function play(id) {
    if (phase === 'focus') return '모두 집중한 뒤에 낼 수 있습니다.';
    if (phase !== 'playing') return '지금은 카드를 낼 수 없습니다.';
    const player = find(id);
    if (!player || !roster.includes(id)) return '이번 게임 참가자가 아닙니다.';
    if (starVote) return '수리검 투표 중에는 카드를 낼 수 없습니다.';
    if (!player.hand.length) return '낼 카드가 없습니다.';
    const value = player.hand.shift();
    pile.push({ value, byId: id, by: player.nickname });
    act(player.nickname, `카드 ${value} 냄`);
    // 이 카드보다 작은 카드를 들고 있던 사람이 있으면 실수다.
    const lost = [];
    for (const p of rosterPlayers()) {
      const lower = p.hand.filter((card) => card < value);
      if (!lower.length) continue;
      p.hand = p.hand.filter((card) => card > value);
      for (const card of lower) discarded.push({ value: card, owner: p.nickname, reason: 'mistake' });
      lost.push(`${p.nickname} ${lower.join(', ')}`);
    }
    if (!lost.length) {
      note(`${player.nickname}님이 ${value}을(를) 냈습니다.`);
      lastEvent = { kind: 'play', text: `${player.nickname} · ${value}` };
      if (handsEmpty()) completeLevel();
      changed();
      return null;
    }
    lives -= 1;
    const lostText = lost.join(' / ');
    note(`${player.nickname}님이 ${value}을(를) 냈는데 더 작은 카드가 있었습니다(${lostText}). 목숨을 1개 잃고 그 카드들은 버립니다.`);
    act('진행', `실수: ${value}보다 작은 카드 (${lostText}) → 목숨 ${lives}`);
    lastEvent = { kind: 'mistake', text: `실수! ${value}보다 작은 카드: ${lostText}` };
    if (lives <= 0) finish(false, `목숨을 모두 잃었습니다. 레벨 ${level}에서 끝났습니다.`);
    else if (handsEmpty()) completeLevel(lastEvent);
    else enterFocus(`실수! 목숨이 ${lives}개 남았습니다. 다시 집중하세요.`);
    changed();
    return null;
  }

  function proposeStar(id) {
    if (phase !== 'playing' && phase !== 'focus') return '레벨 진행 중에만 쓸 수 있습니다.';
    if (!roster.includes(id)) return '이번 게임 참가자가 아닙니다.';
    if (stars <= 0) return '남은 수리검이 없습니다.';
    if (starVote) return '이미 수리검 투표가 진행 중입니다.';
    starVote = { id: makeId(), byId: id, byName: nameOf(id), agreed: new Set([id]) };
    note(`${nameOf(id)}님이 수리검을 쓰자고 제안했습니다. 모두 동의하면 각자 가장 작은 카드를 1장씩 버립니다.`);
    act(nameOf(id), '수리검 제안');
    starTimer = safeTimeout(() => {
      if (!starVote) return;
      clearStarVote();
      note('수리검 투표 시간이 끝나 취소되었습니다.');
      act('투표', '수리검 투표 시간 초과로 취소');
      changed();
    }, proposalTimeoutMs);
    settleStar();
    changed();
    return null;
  }

  function voteStar(id, voteId, agree) {
    if (!starVote || starVote.id !== voteId) return '종료된 투표입니다.';
    if (!roster.includes(id)) return '이번 게임 참가자가 아닙니다.';
    act(nameOf(id), `수리검 ${agree ? '찬성' : '반대'}`);
    if (!agree) {
      clearStarVote();
      note(`${nameOf(id)}님이 반대해 수리검을 쓰지 않습니다.`);
      changed();
      return null;
    }
    starVote.agreed.add(id);
    settleStar();
    changed();
    return null;
  }

  function settleStar() {
    if (!starVote || !roster.every((rid) => starVote.agreed.has(rid))) return;
    clearStarVote();
    stars -= 1;
    const shown = [];
    for (const p of rosterPlayers()) {
      if (!p.hand.length) continue;
      const card = p.hand.shift();
      discarded.push({ value: card, owner: p.nickname, reason: 'star' });
      shown.push(`${p.nickname} ${card}`);
    }
    const shownText = shown.join(' / ') || '버릴 카드 없음';
    note(`수리검을 썼습니다. 각자 가장 작은 카드를 버립니다: ${shownText}`);
    act('진행', `수리검 사용: ${shownText} → 수리검 ${stars}`);
    lastEvent = { kind: 'star', text: `수리검! ${shownText}` };
    if (handsEmpty()) completeLevel(lastEvent);
  }

  /** [보스 키] 레벨 도중 누가 화면을 가리면 멈춘다 - 가린 사람은 판을 볼 수 없다. */
  function setCovered(id, covered) {
    if (!covered || !roster.includes(id)) return;
    // [이슈] 집중 단계에서 "집중 완료"를 누른 뒤 화면을 가리면(남이 가린 경우 포함) 그 사람은
    // 집중한 것으로 남아, 나머지가 집중하는 순간 가린 사람이 판을 못 보는 채로 레벨이
    // 시작됐다. 가리면 집중을 풀고, 돌아와서 다시 누르게 한다.
    if (phase === 'focus') {
      const player = find(id);
      if (player && player.focused) {
        player.focused = false;
        note(`${player.nickname}님의 화면이 가려져 집중을 풀었습니다. 돌아와서 다시 눌러야 시작합니다.`);
        changed();
      }
      return;
    }
    if (phase !== 'playing') return;
    note(`${nameOf(id)}님의 화면이 가려져 잠시 멈췄습니다.`);
    act(nameOf(id), '화면 가림 - 잠깐 멈춤');
    enterFocus(`${nameOf(id)}님의 화면이 가려져 잠시 멈췄습니다. 돌아오면 다시 집중하세요.`);
    changed();
  }

  // ───────────────────────────── 상태 ─────────────────────────────

  function stateFor(id) {
    const me = find(id);
    const live = phase === 'focus' || phase === 'playing';
    const readyCount = players.filter((p) => p.connected && p.ready).length;
    return {
      type: 'mindState',
      phase,
      level, levels, lives, stars, maxLives: MAX_LIVES, maxStars: MAX_STARS,
      reward: live ? REWARDS[level] || null : null,
      pile: pile.slice(),
      discarded: discarded.slice(),
      lastEvent,
      pauseReason,
      result,
      history: history.slice(-12),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      readyCount,
      canStart: !!me && (phase === 'lobby' || phase === 'result') && readyCount >= MIN_PLAYERS && readyCount <= MAX_PLAYERS,
      starVote: starVote ? {
        id: starVote.id, byName: starVote.byName, agreed: starVote.agreed.size, total: roster.length,
        yourVote: starVote.agreed.has(id),
      } : null,
      you: me ? {
        id: me.id, ready: me.ready, focused: me.focused, inGame: roster.includes(me.id) && phase !== 'lobby',
        // 내 카드는 나에게만 보낸다. 남의 카드는 장수만 보낸다(판이 끝나면 공개).
        hand: me.hand.slice(),
      } : null,
      players: players.filter((p) => p.connected || (live && roster.includes(p.id))).map((p) => ({
        id: p.id, nickname: p.nickname, connected: p.connected, ready: p.ready,
        inGame: roster.includes(p.id) && phase !== 'lobby',
        focused: p.focused,
        cardCount: p.hand.length,
        hand: phase === 'result' ? p.hand.slice() : null,
      })),
    };
  }

  function dispose() {
    clearStarVote();
    for (const timer of dropTimers.values()) clearTimeout(timer);
    dropTimers.clear();
  }

  return {
    join, disconnect, leave, setReady, begin, focus, pause, play, proposeStar, voteStar, setCovered,
    stateFor, dispose,
    // 테스트에서 손패를 정하고 들여다보기 위한 것. 서버는 쓰지 않는다.
    _debug: () => ({ players, roster, phase, level, levels, lives, stars, setLevel: (value) => { level = value; } }),
    status: () => ({ phase: phase === 'focus' ? 'playing' : phase, playerCount: players.filter((p) => p.connected).length }),
  };
}

module.exports = { createMindRoom, MIN_PLAYERS, MAX_PLAYERS, LEVELS_BY_COUNT, REWARDS, MAX_LIVES, MAX_STARS };
