'use strict';

const crypto = require('crypto');
const { error: logError } = require('../logger');

const INITIAL_CHIPS = 1000000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;

/**
 * 손패 점수. 에이스는 1로도 11로도 세고, 21을 넘지 않는 한 11로 올려 잡는다.
 *
 * 예전에는 무조건 1이어서 A♠+K♥가 11점이었다. 그래서 이 게임에는 내추럴 21이 아예
 * 존재할 수 없었고, 에이스를 든 사람은 반드시 더 뽑아야 했다 - 화면은 rank 1을 "A"로
 * 보여 주고 있었으므로 표시와 계산이 어긋나 있었다.
 * (에이스를 둘 이상 11로 올리면 반드시 21을 넘으므로 올릴 수 있는 것은 하나뿐이다)
 */
function scoreHand(hand) {
  let sum = 0;
  let aces = 0;
  for (const card of hand) {
    sum += card.rank > 10 ? 10 : card.rank;
    if (card.rank === 1) aces += 1;
  }
  if (aces > 0 && sum + 10 <= 21) sum += 10;
  return sum;
}

function createBlackjackRoom(options) {
  const changed = options.onChange || (() => {});
  const players = [];
  const history = [];
  let phase = 'lobby';
  let hostId = null;
  let baseBet = 100;
  let baseBetProposal = null;
  let pot = 0;
  let deck = [];
  let contenders = [];
  let turn = 0;
  let currentBet = 0;
  // 다음 레이즈가 최소한 올려야 하는 금액(web/poker-room.js의 minRaise와 같은 규칙).
  let minRaise = 100;
  let allInCap = null;
  let acted = new Set();
  let result = null;
  let actionTimer = null;
  let proposalTimer = null;
  const dropTimers = new Map();
  // 포커 방과 같은 이유로 나간 사람의 칩을 토큰에 묶어 둔다(web/poker-room.js의 chipBank 참고).
  const chipBank = new Map(); // token -> chips
  const actionTimeoutMs = Number.isFinite(options.actionTimeoutMs) ? options.actionTimeoutMs : 30000;
  const proposalTimeoutMs = Number.isFinite(options.proposalTimeoutMs) ? options.proposalTimeoutMs : 30000;
  const disconnectGraceMs = Number.isFinite(options.disconnectGraceMs) ? options.disconnectGraceMs : 10000;

  const makeId = () => crypto.randomBytes(8).toString('hex');
  const makeToken = () => crypto.randomBytes(18).toString('hex');
  const note = (text) => { history.push({ text, timestamp: Date.now() }); if (history.length > 40) history.shift(); };
  /**
   * 에이스는 1로도 11로도 센다. 21을 넘지 않는 한 11로 올려 잡는다.
   * 예전에는 무조건 1이어서 A♠+K♥가 11점이었고, 그래서 이 게임에는 내추럴 21이
   * 아예 존재할 수 없었다 - 에이스를 든 사람은 반드시 더 뽑아야 했고 대개 터졌다.
   * 화면은 rank 1을 "A"로 보여 주고 있었으므로 표시와 계산이 어긋나 있었다.
   * (에이스를 둘 이상 11로 올리면 반드시 21을 넘으므로 올릴 수 있는 것은 하나뿐이다)
   */
  const score = scoreHand;
  const inRound = () => contenders.map((id) => players.find((p) => p.id === id)).filter(Boolean);
  const bettingPlayers = () => inRound().filter((p) => !p.isFolded);
  const currentBetPlayer = () => bettingPlayers()[turn % Math.max(bettingPlayers().length, 1)];
  // 포커 방과 같은 이유로 타이머 콜백을 직접 감싼다(web/poker-room.js의 safeTimeout 참고).
  const safeTimeout = (fn, ms) => setTimeout(() => {
    try { fn(); } catch (err) { logError(`[블랙잭 진행 처리 실패] ${err && err.stack ? err.stack : err}`); }
  }, ms);
  const clearActionTimer = () => { if (actionTimer) clearTimeout(actionTimer); actionTimer = null; };
  const clearProposalTimer = () => { if (proposalTimer) clearTimeout(proposalTimer); proposalTimer = null; };
  const cancelDrop = (playerId) => { const timer = dropTimers.get(playerId); if (timer) clearTimeout(timer); dropTimers.delete(playerId); };
  function scheduleDrop(playerId) {
    cancelDrop(playerId);
    const timer = safeTimeout(() => {
      dropTimers.delete(playerId);
      const index = players.findIndex((p) => p.id === playerId && !p.connected);
      if (index < 0) return;
      // 올인하고 결과를 기다리는 사람은 판이 끝날 때까지 자리를 남긴다(web/poker-room.js 참고).
      if (phase === 'betting' && contenders.includes(playerId) && players[index].isAllIn) { scheduleDrop(playerId); return; }
      chipBank.set(players[index].token, players[index].chips);
      players.splice(index, 1);
      contenders = contenders.filter((id) => id !== playerId);
      changed();
    }, Math.max(0, disconnectGraceMs));
    if (timer.unref) timer.unref();
    dropTimers.set(playerId, timer);
  }
  function rebaseBettingTurn(previousTurnId, departedId) {
    const list = bettingPlayers();
    if (!list.length) { turn = 0; return; }
    const preserved = list.findIndex((player) => player.id === previousTurnId);
    if (preserved >= 0) { turn = preserved; return; }
    const departedIndex = contenders.indexOf(departedId);
    for (let offset = 1; offset <= contenders.length; offset += 1) {
      const candidateId = contenders[(departedIndex + offset) % contenders.length];
      const next = list.findIndex((player) => player.id === candidateId);
      if (next >= 0) { turn = next; return; }
    }
    turn = 0;
  }

  /** 남은 사람이 모두 행동했고 금액도 맞췄는가. 그렇다면 이 배팅은 끝났다. */
  function bettingDone() {
    return bettingPlayers().every((p) => acted.has(p.id) && (p.roundBet === currentBet || p.isAllIn));
  }
  /** 차례가 올인한 사람에게 가면 건너뛴다(web/poker-room.js의 skipAllInTurn 참고). */
  function skipAllInTurn() {
    const list = bettingPlayers();
    for (let step = 0; step < list.length; step += 1) {
      const index = (turn + step) % list.length;
      if (!list[index].isAllIn) { turn = index; return; }
    }
  }
  /**
   * 배팅 중에 누가 빠진 뒤 판을 이어 간다. 이미 배팅이 끝났으면 쇼다운으로 간다 -
   * 차례만 넘기면 올인한 사람에게 차례가 가서 자동 폴드된다(web/poker-room.js 참고).
   */
  function continueAfterDeparture(previousTurnId, departedId) {
    const left = bettingPlayers();
    if (left.length === 1) { settle(left[0]); return; }
    if (left.length === 0) return;
    if (bettingDone()) { showdown(); return; }
    rebaseBettingTurn(previousTurnId, departedId);
    skipAllInTurn();
    armActionTimer();
  }

  function rebasePlayingTurn(previousTurnId, departedId) {
    const round = inRound();
    const eligible = round.filter((player) => !player.isStanding && !player.isFolded);
    if (!eligible.length) { beginBetting(); return; }
    const preserved = round.findIndex((player) => player.id === previousTurnId && !player.isStanding && !player.isFolded);
    if (preserved >= 0) { turn = preserved; armActionTimer(); return; }
    const departedIndex = contenders.indexOf(departedId);
    for (let offset = 1; offset <= contenders.length; offset += 1) {
      const candidateId = contenders[(departedIndex + offset) % contenders.length];
      const next = round.findIndex((player) => player.id === candidateId && !player.isStanding && !player.isFolded);
      if (next >= 0) { turn = next; armActionTimer(); return; }
    }
  }
  function uniqueNickname(value, excludeId) {
    const used = new Set(players.filter((p) => p.id !== excludeId).map((p) => p.nickname));
    if (!used.has(value)) return value;
    for (let number = 2; number < 1000; number += 1) {
      const suffix = `(${number})`; const candidate = value.slice(0, 24 - suffix.length) + suffix;
      if (!used.has(candidate)) return candidate;
    }
    return value.slice(0, 20) + '-' + makeId().slice(0, 3);
  }
  function armActionTimer() {
    clearActionTimer();
    if (actionTimeoutMs <= 0) return;
    if (phase === 'playing') {
      const player = currentPlayingPlayer();
      if (player) actionTimer = safeTimeout(() => stand(player.id, true), actionTimeoutMs);
    } else if (phase === 'betting') {
      const player = currentBetPlayer();
      if (player) actionTimer = safeTimeout(() => fold(player.id, true), actionTimeoutMs);
    }
    if (actionTimer && actionTimer.unref) actionTimer.unref();
  }

  function freshDeck() {
    const cards = [];
    for (const suit of ['♠', '♥', '♦', '♣']) for (let rank = 1; rank <= 13; rank += 1) cards.push({ rank, suit });
    for (let i = cards.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  function draw(player) {
    const card = deck.pop();
    if (!card) return null;
    player.hand.push(card);
    player.score = score(player.hand);
    if (player.score > 21) player.isBusted = true;
    return card;
  }

  function resetIfEmpty() {
    if (players.some((p) => p.connected)) return;
    clearActionTimer(); clearProposalTimer();
    for (const timer of dropTimers.values()) clearTimeout(timer);
    dropTimers.clear();
    chipBank.clear(); // 아무도 없는 방은 새 방이다. 칩도 처음부터 다시 시작한다.
    players.length = 0; history.length = 0; phase = 'lobby'; hostId = null; baseBet = 100;
    baseBetProposal = null; pot = 0; deck = []; contenders = []; turn = 0; currentBet = 0; minRaise = 100;
    allInCap = null; acted = new Set(); result = null;
  }

  function join({ nickname, token: oldToken }) {
    const clean = String(nickname || '').trim().slice(0, 24);
    if (!clean) return { error: '닉네임을 입력해 주세요.' };
    // 이전 소켓의 close보다 재연결이 먼저 도착해도 같은 토큰은 같은 자리로 복구한다.
    const restored = players.find((p) => p.token === oldToken);
    if (restored) {
      cancelDrop(restored.id);
      restored.connected = true; restored.nickname = uniqueNickname(clean, restored.id); changed();
      return { playerId: restored.id, token: restored.token, restored: true };
    }
    if (players.length >= MAX_PLAYERS) return { error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` };
    const waiting = phase === 'playing' || phase === 'betting';
    // 같은 토큰으로 돌아왔다면 나갈 때 들고 있던 칩을 그대로 돌려준다.
    const kept = chipBank.get(oldToken);
    if (oldToken) chipBank.delete(oldToken);
    const player = { id: makeId(), token: makeToken(), nickname: uniqueNickname(clean), chips: kept === undefined ? INITIAL_CHIPS : kept, connected: true, ready: false, hand: [], tieCards: [], score: 0, isBusted: false, isStanding: waiting, isFolded: waiting, isAllIn: false, roundBet: 0 };
    players.push(player);
    if (!hostId) hostId = player.id;
    changed();
    return { playerId: player.id, token: player.token, restored: false };
  }

  function forceFold(player) {
    if (!contenders.includes(player.id) || player.isFolded) return;
    player.isFolded = true;
    if (phase === 'playing') player.isStanding = true;
    note(`${player.nickname}님의 연결이 끊겨 제외되었습니다.`);
  }

  function disconnect(playerId) {
    const player = players.find((p) => p.id === playerId);
    if (!player) return;
    const previousTurnId = phase === 'playing' ? (currentPlayingPlayer() || {}).id : phase === 'betting' ? (currentBetPlayer() || {}).id : null;
    player.connected = false;
    if (baseBetProposal) { clearProposalTimer(); baseBetProposal = null; note('참가 인원이 바뀌어 기본 배팅금 투표가 취소되었습니다.'); }
    // 올인한 사람은 끊겨도 폴드하지 않는다. 더 정할 것이 없고, 폴드시키면 잠깐 끊긴
    // 것만으로 이미 건 칩을 전부 잃는다(web/poker-room.js의 disconnect 참고).
    const waitingAllIn = phase === 'betting' && player.isAllIn;
    if ((phase === 'playing' || phase === 'betting') && !waitingAllIn) forceFold(player);
    if (hostId === playerId) hostId = (players.find((p) => p.connected) || {}).id || null;
    if (phase === 'playing') rebasePlayingTurn(previousTurnId, playerId);
    // 올인하고 기다리던 사람이 끊긴 것은 판의 흐름을 바꾸지 않는다. 여기서 이어 가기를
    // 부르면 지금 차례인 사람의 제한시간만 괜히 처음부터 다시 걸린다.
    else if (phase === 'betting' && !waitingAllIn) continueAfterDeparture(previousTurnId, playerId);
    if (players.some((p) => p.connected)) scheduleDrop(playerId);
    else resetIfEmpty();
    changed();
  }

  function leave(playerId) {
    const player = players.find((p) => p.id === playerId);
    if (!player) return;
    cancelDrop(playerId);
    const previousTurnId = phase === 'playing' ? (currentPlayingPlayer() || {}).id : phase === 'betting' ? (currentBetPlayer() || {}).id : null;
    player.connected = false; forceFold(player);
    chipBank.set(player.token, player.chips);
    players.splice(players.indexOf(player), 1);
    if (baseBetProposal) { clearProposalTimer(); baseBetProposal = null; note('참가 인원이 바뀌어 기본 배팅금 투표가 취소되었습니다.'); }
    if (hostId === playerId) hostId = (players.find((p) => p.connected) || {}).id || null;
    if (phase === 'playing') rebasePlayingTurn(previousTurnId, playerId);
    else if (phase === 'betting') continueAfterDeparture(previousTurnId, playerId);
    resetIfEmpty(); changed();
  }

  function setReady(playerId, ready) {
    if (phase !== 'lobby' && phase !== 'result') return '대기 중에만 준비 상태를 바꿀 수 있습니다.';
    const player = players.find((p) => p.id === playerId);
    if (!player) return '참가자를 찾을 수 없습니다.';
    player.ready = !!ready; changed(); return null;
  }

  function proposeBaseBet(playerId, amount) {
    if (phase !== 'lobby' && phase !== 'result') return '게임 중에는 변경할 수 없습니다.';
    if (baseBetProposal) return '이미 기본 배팅금 투표가 진행 중입니다.';
    const player = players.find((p) => p.id === playerId && p.connected);
    const value = Number(amount);
    if (!player) return '참가자를 찾을 수 없습니다.';
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0 || value > INITIAL_CHIPS) return '기본 배팅금은 100원 단위로 설정해 주세요.';
    if (players.filter((p) => p.connected).length === 1) {
      baseBet = value; note(`기본 배팅금이 ${value.toLocaleString()}원으로 변경되었습니다.`); changed(); return null;
    }
    baseBetProposal = { id: makeId(), proposerId: playerId, proposerName: player.nickname, amount: value, votes: new Map() };
    note(`${player.nickname}님이 기본 배팅금 ${value.toLocaleString()}원을 제안했습니다.`);
    proposalTimer = safeTimeout(() => {
      if (!baseBetProposal) return;
      note('기본 배팅금 투표 시간이 끝나 변경이 취소되었습니다.'); baseBetProposal = null; proposalTimer = null; changed();
    }, proposalTimeoutMs);
    if (proposalTimer.unref) proposalTimer.unref();
    changed(); return null;
  }

  function voteBaseBet(playerId, proposalId, agree) {
    if (phase !== 'lobby' && phase !== 'result') return '게임 중에는 투표할 수 없습니다.';
    if (!baseBetProposal || baseBetProposal.id !== proposalId) return '종료된 투표입니다.';
    if (playerId === baseBetProposal.proposerId) return '제안자는 투표 대상이 아닙니다.';
    if (!players.some((p) => p.id === playerId && p.connected)) return '참가자를 찾을 수 없습니다.';
    if (baseBetProposal.votes.has(playerId)) return '이미 투표했습니다.';
    baseBetProposal.votes.set(playerId, !!agree);
    const voters = players.filter((p) => p.connected && p.id !== baseBetProposal.proposerId);
    const required = Math.ceil(voters.length / 2);
    const agreed = [...baseBetProposal.votes.values()].filter(Boolean).length;
    const remaining = voters.length - baseBetProposal.votes.size;
    if (agreed >= required) {
      baseBet = baseBetProposal.amount; note(`찬성 ${agreed}명으로 기본 배팅금이 ${baseBet.toLocaleString()}원으로 변경되었습니다.`); clearProposalTimer(); baseBetProposal = null;
    } else if (agreed + remaining < required || remaining === 0) {
      note(`찬성 ${agreed}명으로 변경이 거절되었습니다. 다시 설정해 주세요.`); clearProposalTimer(); baseBetProposal = null;
    }
    changed(); return null;
  }

  // 방장 독점 해제. 이유는 web/poker-room.js의 begin() 주석 참고 - 자리를 비운 방장이
  // 남은 사람 전원의 다음 판을 막아 버리는 문제가 있었다.
  function begin(playerId) {
    if (!players.some((p) => p.id === playerId && p.connected)) return '방에 참가한 뒤 시작할 수 있습니다.';
    if (phase !== 'lobby' && phase !== 'result') return '이미 게임이 진행 중입니다.';
    if (baseBetProposal) return '기본 배팅금 투표가 끝난 뒤 시작해 주세요.';
    const ready = players.filter((p) => p.connected && p.ready && p.chips > 0);
    if (ready.length < MIN_PLAYERS) return '준비한 참가자가 2명 이상이어야 합니다.';
    phase = 'playing'; result = null; pot = 0; deck = freshDeck(); contenders = ready.map((p) => p.id); turn = 0;
    for (const player of players) {
      player.hand = []; player.tieCards = []; player.score = 0; player.isBusted = false; player.isStanding = false;
      player.isFolded = !contenders.includes(player.id); player.isAllIn = false; player.roundBet = 0;
      if (contenders.includes(player.id)) { draw(player); draw(player); }
    }
    note('카드 두 장씩 배분했습니다. 차례대로 히트 또는 스탠드를 선택하세요.');
    advancePlaying(true); changed(); return null;
  }

  function currentPlayingPlayer() {
    if (phase !== 'playing') return null;
    const round = inRound();
    for (let offset = 0; offset < round.length; offset += 1) {
      const player = round[(turn + offset) % round.length];
      if (!player.isStanding && !player.isFolded) return player;
    }
    return null;
  }

  function advancePlaying(keepTurn) {
    if (phase !== 'playing') return;
    const round = inRound();
    if (!keepTurn) turn = (turn + 1) % Math.max(round.length, 1);
    const next = currentPlayingPlayer();
    if (next) { turn = round.findIndex((p) => p.id === next.id); armActionTimer(); return; }
    beginBetting();
  }

  function hit(playerId) {
    const player = currentPlayingPlayer();
    if (!player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    if (!draw(player)) {
      player.isStanding = true; note(`${player.nickname}님은 남은 카드가 없어 자동 스탠드되었습니다.`); advancePlaying(false); changed(); return null;
    }
    // 21을 넘었는지는 기록에 남기지 않는다. 기록은 모두가 보므로, 여기에 적으면 서버가
    // 점수와 21 초과 여부를 가려 준 것이 소용없어지고 블러핑이 성립하지 않는다.
    // 본인은 자기 상태(점수·21 초과 표시)로 안다.
    note(`${player.nickname}님이 히트했습니다.`);
    armActionTimer(); changed(); return null;
  }

  function stand(playerId, timedOut) {
    const player = currentPlayingPlayer();
    if (!player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    player.isStanding = true; note(timedOut ? `${player.nickname}님의 제한시간이 지나 자동 스탠드되었습니다.` : `${player.nickname}님이 스탠드했습니다.`); advancePlaying(false); changed(); return null;
  }

  function beginBetting() {
    const survivors = inRound().filter((p) => !p.isFolded);
    if (survivors.length === 0) { refundAndFinish('진행 가능한 참가자가 없어 이번 판을 종료합니다.'); return; }
    if (survivors.length === 1) { settle(survivors[0]); return; }
    phase = 'betting'; turn = 0; currentBet = baseBet; minRaise = baseBet; allInCap = null; acted = new Set();
    note('카드 선택이 끝났습니다. 배팅을 시작합니다.');
    armActionTimer();
  }

  function pay(player, amount) { player.chips -= amount; player.roundBet += amount; pot += amount; }
  function advanceBet() {
    const list = bettingPlayers();
    if (list.length <= 1) { settle(list[0]); return; }
    const player = currentBetPlayer();
    const idx = list.findIndex((p) => p.id === player.id);
    // 올인한 사람은 건너뛴다. 그러지 않으면 더 낼 것도 없는 사람 앞에서 제한시간이
    // 흘러 자동 폴드되고, 이미 낸 칩을 그대로 잃는다.
    for (let step = 1; step <= list.length; step += 1) {
      const next = list[(idx + step) % list.length];
      if (!next.isAllIn) { turn = list.indexOf(next); return; }
    }
    turn = (idx + 1) % list.length; // 전원 올인 - 배팅 종료 판정이 처리한다
  }

  function call(playerId) {
    const player = currentBetPlayer();
    if (phase !== 'betting' || !player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    const needed = Math.max(0, currentBet - player.roundBet);
    if (player.chips < needed) return '콜할 칩이 부족합니다. 올인을 선택하세요.';
    pay(player, needed); acted.add(playerId); note(`${player.nickname}님이 ${needed.toLocaleString()}원을 콜했습니다.`);
    if (bettingDone()) { showdown(); return null; }
    advanceBet(); armActionTimer(); changed(); return null;
  }

  function raise(playerId, amount) {
    const player = currentBetPlayer();
    if (phase !== 'betting' || !player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    if (allInCap !== null) return '올인 이후에는 레이즈할 수 없습니다.';
    const value = Number(amount); const needed = currentBet - player.roundBet + value;
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0) return '레이즈는 100원 단위로 입력해 주세요.';
    // [규칙] 레이즈 폭은 직전 레이즈 폭 이상(web/poker-room.js의 raise() 주석 참고).
    if (value < minRaise) return `레이즈는 직전 레이즈 금액인 ${minRaise.toLocaleString()}원 이상이어야 합니다.`;
    if (needed >= player.chips) return '레이즈 후 칩이 남아야 합니다. 전액은 올인을 사용하세요.';
    pay(player, needed); currentBet += value; minRaise = value; acted = new Set([playerId]); advanceBet();
    note(`${player.nickname}님이 ${value.toLocaleString()}원을 레이즈했습니다.`); armActionTimer(); changed(); return null;
  }

  /**
   * 올인. 상대가 먼저 올인했어도 그보다 적은 칩으로 올인할 수 있다.
   * 규칙과 이유는 web/poker-room.js의 allin() 주석 참고 - 올인이 여럿이면 가장 적은
   * 금액이 이 판의 상한이 되고, 넘치는 몫은 주인에게 돌려준다.
   */
  function allin(playerId) {
    const player = currentBetPlayer();
    if (phase !== 'betting' || !player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    if (player.chips <= 0) return '올인할 칩이 없습니다.';
    // 상대가 받을 수 없는 몫은 걸지 않는다. 이유는 poker-room.js의 같은 자리 주석 참고.
    const rivals = bettingPlayers().filter((other) => other.id !== playerId);
    const reachable = rivals.length
      ? Math.max(...rivals.map((other) => other.roundBet + other.chips)) : Infinity;
    const cap = Math.max(player.roundBet, Math.min(player.roundBet + player.chips, reachable));
    pay(player, cap - player.roundBet);
    allInCap = allInCap === null ? cap : Math.min(allInCap, cap);
    currentBet = allInCap;
    for (const other of bettingPlayers()) {
      if (other.roundBet <= allInCap) continue;
      const refund = other.roundBet - allInCap;
      other.roundBet -= refund; other.chips += refund; pot -= refund;
    }
    // 환불까지 끝난 뒤에야 정말 다 걸었는지가 정해진다.
    player.isAllIn = player.chips === 0;
    acted.add(playerId);
    note(player.isAllIn
      ? `${player.nickname}님이 ${allInCap.toLocaleString()}원에 올인했습니다.`
      : `${player.nickname}님이 상대가 받을 수 있는 최대인 ${allInCap.toLocaleString()}원을 걸었습니다.`);
    // 남은 사람이 모두 행동했고 금액도 맞췄다면 여기서 배팅이 끝난다(call()과 같은 판정).
    if (bettingDone()) { showdown(); return null; }
    advanceBet(); armActionTimer(); changed(); return null;
  }

  function fold(playerId, timedOut) {
    const player = currentBetPlayer();
    if (phase !== 'betting' || !player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    player.isFolded = true; note(timedOut ? `${player.nickname}님의 제한시간이 지나 자동 폴드되었습니다.` : `${player.nickname}님이 폴드했습니다.`);
    if (bettingPlayers().length === 1) { settle(bettingPlayers()[0]); return null; }
    // 남은 사람들이 이미 다 행동했고 금액도 맞췄다면 이 배팅은 끝난 것이다(call()과 같은
    // 판정). 이게 없으면 마지막 차례인 사람이 폴드했을 때 차례가 처음으로 돌아가,
    // 이미 콜을 맞춘 사람이 또 내야 하는 상황이 된다.
    if (bettingDone()) { showdown(); return null; }
    turn %= bettingPlayers().length; skipAllInTurn(); armActionTimer(); changed(); return null;
  }

  function showdown() {
    let candidates = bettingPlayers().filter((p) => p.score <= 21);
    if (!candidates.length) { refundAndFinish('모든 참가자가 21을 초과해 배팅금을 돌려드립니다.'); return; }
    const bestScore = Math.max(...candidates.map((p) => p.score));
    candidates = candidates.filter((p) => p.score === bestScore);
    const mostCards = Math.max(...candidates.map((p) => p.hand.length));
    candidates = candidates.filter((p) => p.hand.length === mostCards);
    let safety = 20;
    while (candidates.length > 1 && deck.length >= candidates.length && safety-- > 0) {
      note(`동점자 ${candidates.length}명이 재대결 카드 한 장씩 뽑습니다.`);
      const drawn = candidates.map((player) => { const card = deck.pop(); player.tieCards.push(card); return { player, value: card.rank > 10 ? 10 : card.rank }; });
      const bestTieCard = Math.max(...drawn.map((entry) => entry.value));
      candidates = drawn.filter((entry) => entry.value === bestTieCard).map((entry) => entry.player);
    }
    if (candidates.length === 1) settle(candidates[0]);
    else refundAndFinish('동점을 가리지 못해 배팅금을 돌려드립니다.');
  }

  function settle(winner) {
    if (!winner) return;
    clearActionTimer();
    const amount = pot; winner.chips += pot; pot = 0; phase = 'result';
    result = { winnerId: winner.id, nickname: winner.nickname, amount, noWinner: false };
    note(`${winner.nickname}님이 ${winner.score}점으로 팟 ${amount.toLocaleString()}원을 획득했습니다.`);
    players.forEach((p) => { p.ready = false; p.isAllIn = false; p.roundBet = 0; }); changed();
  }

  function refundAndFinish(message) {
    clearActionTimer();
    for (const player of players) { player.chips += player.roundBet; player.roundBet = 0; player.ready = false; player.isAllIn = false; }
    pot = 0; phase = 'result'; result = { noWinner: true, message }; note(message); changed();
  }

  function donate(fromId, toId, amount) {
    if (phase !== 'lobby' && phase !== 'result') return '기부는 대기 중에만 할 수 있습니다.';
    const from = players.find((p) => p.id === fromId); const to = players.find((p) => p.id === toId); const value = Number(amount);
    if (!from || !to || from === to) return '기부 대상을 확인해 주세요.';
    if (to.chips >= baseBet) return '현재 칩이 부족한 참가자에게만 기부할 수 있습니다.';
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0 || from.chips < value) return '기부 금액과 보유 칩을 확인해 주세요.';
    from.chips -= value; to.chips += value; note(`${from.nickname}님이 ${to.nickname}님에게 ${value.toLocaleString()}원을 기부했습니다.`); changed(); return null;
  }

  function stateFor(playerId) {
    const me = players.find((p) => p.id === playerId);
    const playingTurn = currentPlayingPlayer();
    const bettingTurn = currentBetPlayer();
    return {
      type: 'blackjackState', phase, hostId, baseBet, pot, currentBet, minRaise, allInCap, result,
      turnPlayerId: phase === 'playing' ? playingTurn && playingTurn.id : phase === 'betting' ? bettingTurn && bettingTurn.id : null,
      you: me ? { id: me.id, chips: me.chips, ready: me.ready, inRound: contenders.includes(me.id) } : null,
      canStart: !!me && (phase === 'lobby' || phase === 'result') && players.filter((p) => p.connected && p.ready && p.chips > 0).length >= MIN_PLAYERS,
      // 시작 버튼이 왜 꺼져 있는지 화면이 그대로 말해 줄 수 있게 서버가 사유를 내려 준다.
      readyCount: players.filter((p) => p.connected && p.ready && p.chips > 0).length,
      minPlayers: MIN_PLAYERS,
      baseBetProposal: baseBetProposal ? { id: baseBetProposal.id, proposerName: baseBetProposal.proposerName, amount: baseBetProposal.amount, agreed: [...baseBetProposal.votes.values()].filter(Boolean).length, voted: baseBetProposal.votes.size, total: players.filter((p) => p.connected && p.id !== baseBetProposal.proposerId).length, yourVote: playerId === baseBetProposal.proposerId || baseBetProposal.votes.has(playerId) } : null,
      history: history.slice(-12),
      // 끊긴 채로 판을 계속 겨루는 사람(올인하고 기다리는 사람)은 목록에 남긴다.
      players: players.filter((p) => p.connected || (phase !== 'lobby' && contenders.includes(p.id) && !p.isFolded)).map((p) => {
        // 라운드가 끝나면 폴드했던 사람의 카드도 공개한다 - 더 숨길 이유가 없다.
        const reveal = phase === 'result' ? true : p.id === playerId;
        return { id: p.id, nickname: p.nickname, chips: p.chips, ready: p.ready, connected: p.connected, inRound: contenders.includes(p.id), score: reveal ? p.score : null, cards: p.hand.map((card) => reveal ? card : { hidden: true }), tieCards: p.tieCards.map((card) => phase === 'result' ? card : { hidden: true }), isBusted: reveal ? p.isBusted : false, isStanding: p.isStanding, isFolded: p.isFolded, isAllIn: p.isAllIn, roundBet: p.roundBet };
      }),
    };
  }

  function dispose() {
    clearActionTimer();
    clearProposalTimer();
    for (const timer of dropTimers.values()) clearTimeout(timer);
    dropTimers.clear();
  }

  return { join, disconnect, leave, setReady, proposeBaseBet, voteBaseBet, begin, hit, stand, call, raise, allin, fold, donate, stateFor, dispose, status: () => ({ phase, playerCount: players.filter((p) => p.connected).length }) };
}

module.exports = { createBlackjackRoom, scoreHand, INITIAL_CHIPS };
