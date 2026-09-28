'use strict';

const crypto = require('crypto');
const { error: logError } = require('../logger');
const { createCoverPause } = require('./cover-pause');

const INITIAL_CHIPS = 1000000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;

/**
 * 손패 점수. [규칙] 에이스는 무조건 1로 센다. J·Q·K는 10.
 *
 * 한때 에이스를 1 또는 11로 세고 21을 넘지 않는 한 11로 올려 잡았다. 규칙상 맞는
 * 계산이지만, 그러면 히트했는데 점수가 줄어드는 일이 생긴다(A+K 21점에서 4를 받으면
 * 에이스가 1로 내려가 15점). 화면에는 숫자 하나만 보여서 "히트했더니 점수가
 * 깎였다"는 제보가 나왔다. 이 게임의 규칙은 에이스 1로 정했다 - 이제 카드를 받으면
 * 점수는 반드시 오른다(test/blackjack-room-test.js가 모든 손으로 확인한다).
 */
function scoreHand(hand) {
  let sum = 0;
  for (const card of hand) sum += card.rank > 10 ? 10 : card.rank;
  return sum;
}

function createBlackjackRoom(options) {
  const notify = options.onChange || (() => {});
  // [관리 로그] 누가 무엇을 했는지 알린다. 서버가 "[블랙잭] 닉네임 > 행동"으로 남긴다.
  // 운영자가 판을 되짚을 수 있도록 받은 카드와 그때의 점수까지 남긴다(운영 결정).
  // 그래서 게임 도중 이 로그를 보는 사람은 남의 패를 알 수 있다 - 로그는 운영자만 본다.
  // 참가자끼리 보는 게임 화면의 기록(note)에는 여전히 카드·점수를 남기지 않는다.
  const onAction = options.onAction || (() => {});
  const act = (who, what) => { try { onAction(who, what); } catch { /* 로그 실패는 무시 */ } };
  const money = (value) => `${Number(value || 0).toLocaleString()}원`;
  const cardName = (card) => (card ? ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[card.rank] || card.rank) + card.suit : '?');
  const handLine = (player) => `${player.score}점${player.isBusted ? ', 21 초과' : ''}, ${player.hand.length}장`;
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
  let proposalTimer = null;
  const dropTimers = new Map();
  // 포커 방과 같은 이유로 나간 사람의 칩을 토큰에 묶어 둔다(web/poker-room.js의 chipBank 참고).
  const chipBank = new Map(); // token -> chips
  // 판 도중에 떠난 사람이 이 판에 이미 낸 돈. 판이 무효로 끝나 모두에게 돌려줄 때 떠난
  // 사람 몫도 돌려주려고 기억한다(web/poker-room.js의 departedStakes 참고). 예전에는
  // "모두 21 초과"로 환불할 때 떠난 사람의 앤티가 팟과 함께 사라졌다.
  const departedStakes = new Map(); // token -> { paid: 이번 판에 내고 떠난 돈, nickname }
  const actionTimeoutMs = Number.isFinite(options.actionTimeoutMs) ? options.actionTimeoutMs : 30000;
  const proposalTimeoutMs = Number.isFinite(options.proposalTimeoutMs) ? options.proposalTimeoutMs : 30000;
  const disconnectGraceMs = Number.isFinite(options.disconnectGraceMs) ? options.disconnectGraceMs : 10000;

  const makeId = () => crypto.randomBytes(8).toString('hex');
  const makeToken = () => crypto.randomBytes(18).toString('hex');
  const note = (text) => { history.push({ text, timestamp: Date.now() }); if (history.length > 40) history.shift(); };
  // 점수 계산 규칙은 파일 맨 위 scoreHand 주석 참고(에이스는 무조건 1).
  const score = scoreHand;
  const inRound = () => contenders.map((id) => players.find((p) => p.id === id)).filter(Boolean);
  const bettingPlayers = () => inRound().filter((p) => !p.isFolded);
  const currentBetPlayer = () => bettingPlayers()[turn % Math.max(bettingPlayers().length, 1)];
  // 포커 방과 같은 이유로 타이머 콜백을 직접 감싼다(web/poker-room.js의 safeTimeout 참고).
  const safeTimeout = (fn, ms) => setTimeout(() => {
    try { fn(); } catch (err) { logError(`[블랙잭 진행 처리 실패] ${err && err.stack ? err.stack : err}`); }
  }, ms);
  const nameOf = (id) => (players.find((p) => p.id === id) || {}).nickname || '(나간 참가자)';
  // [보스 키] 차례인 사람이 화면을 가리고 있으면 그 사람의 제한시간을 멈춘다(web/cover-pause.js).
  // 카드 선택(playing)과 배팅(betting) 모두 차례가 있다.
  const pause = createCoverPause({
    setTimer: safeTimeout, clearTimer: clearTimeout, unref: true, maxPauseMs: options.maxCoverPauseMs,
    isWaitingOn: (id) => {
      const turn = phase === 'playing' ? currentPlayingPlayer() : phase === 'betting' ? currentBetPlayer() : null;
      return !!turn && turn.id === id;
    },
    onExpire: () => changed(),
  });
  const actionClock = pause.timer;
  /** 상태를 알리기 직전마다 멈춤 여부를 맞춘다(web/poker-room.js의 changed 참고). */
  function changed() {
    const turned = pause.sync();
    if (turned && turned.paused) act(turned.paused.map(nameOf).join(', '), '화면 가림 - 제한시간 멈춤');
    else if (turned) act('진행', `제한시간 다시 흐름 (${Math.round(turned.resumedAfterMs / 1000)}초 멈춤${turned.expired ? ', 멈출 수 있는 최대 시간 초과' : ''})`);
    notify();
  }
  const clearActionTimer = () => actionClock.clear();
  const clearProposalTimer = () => { if (proposalTimer) clearTimeout(proposalTimer); proposalTimer = null; };
  const cancelDrop = (playerId) => { const timer = dropTimers.get(playerId); if (timer) clearTimeout(timer); dropTimers.delete(playerId); };
  function scheduleDrop(playerId) {
    cancelDrop(playerId);
    const timer = safeTimeout(() => {
      dropTimers.delete(playerId);
      const player = players.find((p) => p.id === playerId && !p.connected);
      if (!player) return;
      const inHand = (phase === 'playing' || phase === 'betting') && contenders.includes(playerId) && !player.isFolded;
      // 올인한 사람은 판이 끝날 때까지 자리를 남긴다(web/poker-room.js 참고). 카드를
      // 고르는 중이었다면 더 뽑지 않고 스탠드해 둔다 - 이미 전부 걸었으니 폴드시키면 잃기만 한다.
      if (inHand && player.isAllIn) {
        if (phase === 'playing' && !player.isStanding) {
          const wasTurn = (currentPlayingPlayer() || {}).id === playerId;
          player.isStanding = true;
          note(`${player.nickname}님이 돌아오지 않아 자동 스탠드되었습니다.`);
          act(player.nickname, `스탠드 (연결이 끊긴 채 돌아오지 않음) → ${handLine(player)}`);
          if (wasTurn) advancePlaying(false);
          changed();
        }
        scheduleDrop(playerId);
        return;
      }
      // 유예가 다 지나도록 돌아오지 않았다. 이제야 폴드한다(disconnect 참고).
      if (inHand) {
        const previousTurnId = phase === 'playing' ? (currentPlayingPlayer() || {}).id : (currentBetPlayer() || {}).id;
        forceFold(player, '돌아오지 않아 폴드 처리되었습니다.', '폴드 (연결이 끊긴 채 돌아오지 않음)');
        if (phase === 'playing') rebasePlayingTurn(previousTurnId, playerId);
        else continueAfterDeparture(previousTurnId, playerId);
      }
      // [이슈] 카드 선택 중에는 차례가 inRound() 목록의 위치(turn)로 정해진다. 자리를 빼면
      // 목록이 한 칸 당겨져, 아무것도 안 한 사람을 건너뛰고 다음 사람에게 차례가 갔다.
      // 게다가 제한시간은 원래 사람 앞으로 걸려 있어 새 차례에는 제한시간도 없었다.
      // 자리를 빼기 전의 차례인 사람을 기억해 두었다가 그 사람 위치로 다시 맞춘다.
      const keepTurnId = phase === 'playing' ? (currentPlayingPlayer() || {}).id : null;
      act(player.nickname, `자리 정리 (돌아오지 않음, 칩 ${money(player.chips)} 보관)`);
      rememberStake(player);
      chipBank.set(player.token, player.chips);
      players.splice(players.indexOf(player), 1);
      contenders = contenders.filter((id) => id !== playerId);
      if (keepTurnId) {
        const index = inRound().findIndex((p) => p.id === keepTurnId);
        if (index >= 0) turn = index;
      }
      changed();
    }, Math.max(0, disconnectGraceMs));
    if (timer.unref) timer.unref();
    dropTimers.set(playerId, timer);
  }
  /** 판 도중에 떠나는 사람이 이미 낸 돈을 기억한다(departedStakes 참고). */
  function rememberStake(player) {
    if ((phase !== 'playing' && phase !== 'betting') || player.roundBet <= 0) return;
    const before = departedStakes.get(player.token);
    departedStakes.set(player.token, { paid: (before ? before.paid : 0) + player.roundBet, nickname: player.nickname });
  }
  /** 무효가 된 판: 떠난 사람이 낸 돈을 보관 칩(돌아와 있으면 그 자리)으로 돌려준다. */
  function returnDepartedStakes() {
    for (const [owner, { paid, nickname }] of departedStakes) {
      const back = players.find((p) => p.token === owner);
      if (back) back.chips += paid; else chipBank.set(owner, (chipBank.get(owner) || 0) + paid);
      act(back ? back.nickname : nickname, `환불 - 판 도중에 떠나며 두고 간 ${money(paid)} 돌려받음${back ? '' : ' (보관 칩에 더함)'}`);
    }
    departedStakes.clear();
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
      if (player) actionClock.start(() => stand(player.id, true), actionTimeoutMs);
    } else if (phase === 'betting') {
      const player = currentBetPlayer();
      if (player) actionClock.start(() => fold(player.id, true), actionTimeoutMs);
    }
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
    clearActionTimer(); clearProposalTimer(); pause.reset();
    for (const timer of dropTimers.values()) clearTimeout(timer);
    dropTimers.clear();
    chipBank.clear(); departedStakes.clear(); // 아무도 없는 방은 새 방이다. 칩도 처음부터 다시 시작한다.
    players.length = 0; history.length = 0; phase = 'lobby'; hostId = null; baseBet = 100;
    baseBetProposal = null; pot = 0; deck = []; contenders = []; turn = 0; currentBet = 0; minRaise = 100;
    allInCap = null; acted = new Set(); result = null;
  }

  function join({ nickname, token: oldToken }) {
    const clean = Array.from(String(nickname || '').trim()).slice(0, 24).join(''); // 글자 단위로 자른다(이모지가 반으로 쪼개지지 않게)
    if (!clean) return { error: '닉네임을 입력해 주세요.' };
    // 이전 소켓의 close보다 재연결이 먼저 도착해도 같은 토큰은 같은 자리로 복구한다.
    const restored = players.find((p) => p.token === oldToken);
    if (restored) {
      cancelDrop(restored.id);
      // 새로 열린 화면이 가려져 있는지는 그 화면이 다시 알려 준다. 이전 화면의 상태는 버린다.
      pause.forget(restored.id);
      restored.connected = true; restored.nickname = uniqueNickname(clean, restored.id); act(restored.nickname, '재접속'); changed();
      return { playerId: restored.id, token: restored.token, restored: true };
    }
    if (players.length >= MAX_PLAYERS) return { error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` };
    const waiting = phase === 'playing' || phase === 'betting';
    // 같은 토큰으로 돌아왔다면 나갈 때 들고 있던 칩을 그대로 돌려준다.
    const kept = chipBank.get(oldToken);
    if (oldToken) chipBank.delete(oldToken);
    // 보관 칩을 되찾은 사람은 토큰도 그대로 쓴다(web/poker-room.js의 join 참고).
    const player = { id: makeId(), token: kept === undefined ? makeToken() : oldToken, nickname: uniqueNickname(clean), chips: kept === undefined ? INITIAL_CHIPS : kept, connected: true, ready: false, hand: [], tieCards: [], score: 0, isBusted: false, isStanding: waiting, isFolded: waiting, isAllIn: false, roundBet: 0 };
    players.push(player);
    if (!hostId) hostId = player.id;
    act(player.nickname, `입장 (칩 ${money(player.chips)}${kept === undefined ? '' : ', 보관해 둔 칩 복구'}${waiting ? ', 다음 판부터' : ''})`);
    changed();
    return { playerId: player.id, token: player.token, restored: false };
  }

  function forceFold(player, why, logText) {
    if (!contenders.includes(player.id) || player.isFolded) return;
    player.isFolded = true;
    if (phase === 'playing') player.isStanding = true;
    note(`${player.nickname}님이 ${why}`);
    act(player.nickname, logText);
  }

  function disconnect(playerId) {
    const player = players.find((p) => p.id === playerId);
    if (!player) return;
    player.connected = false;
    pause.forget(playerId);
    act(player.nickname, '연결 끊김');
    if (baseBetProposal) { clearProposalTimer(); baseBetProposal = null; note('참가 인원이 바뀌어 기본 배팅금 투표가 취소되었습니다.'); act('투표', '기본 배팅금 투표 취소 (인원 변경)'); }
    // [규칙] 끊겼다고 곧바로 폴드하지 않는다. 유예 동안 돌아오면 그대로 이어서 하고,
    // 그래도 안 돌아오면 그때 폴드한다(scheduleDrop). 예전에는 끊기는 순간 폴드해서,
    // 남의 차례에 새로고침만 해도 앤티와 건 돈을 잃었다(web/poker-room.js의 disconnect 참고).
    // 올인한 사람은 판이 끝날 때까지 남는다.
    const waitingAllIn = phase === 'betting' && player.isAllIn;
    if ((phase === 'playing' || phase === 'betting') && contenders.includes(playerId) && !player.isFolded && !waitingAllIn) {
      note(`${player.nickname}님의 연결이 끊겼습니다. ${Math.max(1, Math.round(disconnectGraceMs / 1000))}초 안에 돌아오지 않으면 ${player.isAllIn ? '스탠드' : '폴드'}됩니다.`);
    }
    if (hostId === playerId) hostId = (players.find((p) => p.connected) || {}).id || null;
    if (players.some((p) => p.connected)) scheduleDrop(playerId);
    else resetIfEmpty();
    changed();
  }

  function leave(playerId) {
    const player = players.find((p) => p.id === playerId);
    if (!player) return;
    cancelDrop(playerId);
    pause.forget(playerId);
    const previousTurnId = phase === 'playing' ? (currentPlayingPlayer() || {}).id : phase === 'betting' ? (currentBetPlayer() || {}).id : null;
    act(player.nickname, `나감 (칩 ${money(player.chips)} 보관)`);
    forceFold(player, '방을 나가 폴드 처리되었습니다.', '폴드 (방을 나감)'); player.connected = false;
    rememberStake(player);
    chipBank.set(player.token, player.chips);
    players.splice(players.indexOf(player), 1);
    if (baseBetProposal) { clearProposalTimer(); baseBetProposal = null; note('참가 인원이 바뀌어 기본 배팅금 투표가 취소되었습니다.'); act('투표', '기본 배팅금 투표 취소 (인원 변경)'); }
    if (hostId === playerId) hostId = (players.find((p) => p.connected) || {}).id || null;
    if (phase === 'playing') rebasePlayingTurn(previousTurnId, playerId);
    else if (phase === 'betting') continueAfterDeparture(previousTurnId, playerId);
    resetIfEmpty(); changed();
  }

  /** [보스 키] 이 사람의 화면이 가려졌는지/돌아왔는지. 화면이 알려 준다(public/cover.js). */
  function setCovered(playerId, covered) {
    if (!players.some((p) => p.id === playerId)) return;
    pause.set(playerId, covered === true);
    changed();
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
      baseBet = value; note(`기본 배팅금이 ${value.toLocaleString()}원으로 변경되었습니다.`); act(player.nickname, `기본 배팅금 ${money(value)}으로 변경 (혼자라 바로 적용)`); changed(); return null;
    }
    baseBetProposal = { id: makeId(), proposerId: playerId, proposerName: player.nickname, amount: value, votes: new Map() };
    note(`${player.nickname}님이 기본 배팅금 ${value.toLocaleString()}원을 제안했습니다.`);
    act(player.nickname, `기본 배팅금 ${money(value)} 제안`);
    proposalTimer = safeTimeout(() => {
      if (!baseBetProposal) return;
      note('기본 배팅금 투표 시간이 끝나 변경이 취소되었습니다.'); act('투표', '기본 배팅금 투표 시간 초과로 취소'); baseBetProposal = null; proposalTimer = null; changed();
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
    act(players.find((p) => p.id === playerId).nickname, `기본 배팅금 ${money(baseBetProposal.amount)} ${agree ? '찬성' : '반대'}`);
    const voters = players.filter((p) => p.connected && p.id !== baseBetProposal.proposerId);
    const required = Math.ceil(voters.length / 2);
    const agreed = [...baseBetProposal.votes.values()].filter(Boolean).length;
    const remaining = voters.length - baseBetProposal.votes.size;
    if (agreed >= required) {
      baseBet = baseBetProposal.amount; note(`찬성 ${agreed}명으로 기본 배팅금이 ${baseBet.toLocaleString()}원으로 변경되었습니다.`); act('투표', `기본 배팅금 ${money(baseBet)}으로 변경 (찬성 ${agreed}명)`); clearProposalTimer(); baseBetProposal = null;
    } else if (agreed + remaining < required || remaining === 0) {
      note(`찬성 ${agreed}명으로 변경이 거절되었습니다. 다시 설정해 주세요.`); act('투표', `기본 배팅금 변경 부결 (찬성 ${agreed}명)`); clearProposalTimer(); baseBetProposal = null;
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
    phase = 'playing'; result = null; pot = 0; deck = freshDeck(); contenders = ready.map((p) => p.id); turn = 0; departedStakes.clear();
    currentBet = baseBet; minRaise = baseBet; allInCap = null; acted = new Set();
    for (const player of players) {
      player.hand = []; player.tieCards = []; player.score = 0; player.isBusted = false; player.isStanding = false;
      player.isFolded = !contenders.includes(player.id); player.isAllIn = false; player.roundBet = 0;
      if (contenders.includes(player.id)) { draw(player); draw(player); }
    }
    note('카드 두 장씩 배분했습니다. 차례대로 히트 또는 스탠드를 선택하세요.');
    act(players.find((p) => p.id === playerId).nickname, `게임 시작 (${ready.length}명: ${ready.map((p) => p.nickname).join(', ')})`);
    for (const player of inRound()) act(player.nickname, `카드 받음: ${player.hand.map(cardName).join(' ')} → ${handLine(player)}`);
    collectAnte(contenders);
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
      player.isStanding = true; note(`${player.nickname}님은 남은 카드가 없어 자동 스탠드되었습니다.`); act(player.nickname, `스탠드 (남은 카드 없음) → ${handLine(player)}`); advancePlaying(false); changed(); return null;
    }
    // 21을 넘었는지는 기록에 남기지 않는다. 기록은 모두가 보므로, 여기에 적으면 서버가
    // 점수와 21 초과 여부를 가려 준 것이 소용없어지고 블러핑이 성립하지 않는다.
    // 본인은 자기 상태(점수·21 초과 표시)로 안다. 운영자용 관리 로그에는 남긴다(맨 위 참고).
    note(`${player.nickname}님이 히트했습니다.`);
    act(player.nickname, `히트: ${cardName(player.hand[player.hand.length - 1])} 받음 → ${handLine(player)}`);
    armActionTimer(); changed(); return null;
  }

  function stand(playerId, timedOut) {
    const player = currentPlayingPlayer();
    if (!player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    player.isStanding = true; note(timedOut ? `${player.nickname}님의 제한시간이 지나 자동 스탠드되었습니다.` : `${player.nickname}님이 스탠드했습니다.`);
    act(player.nickname, `${timedOut ? '스탠드 (시간 초과)' : '스탠드'} → ${handLine(player)}`);
    advancePlaying(false); changed(); return null;
  }

  /**
   * [규칙] 앤티 - 카드를 나눠 줄 때 참가자 전원이 기본 배팅금을 먼저 팟에 낸다.
   * 이유와 올인 처리는 web/poker-room.js의 collectAnte 주석 참고. 블랙잭은 카드를 고른
   * 뒤에 배팅하므로, 카드를 받는 순간 걷어야 배팅 단계에서 폴드했을 때 앤티를 잃는다.
   */
  function collectAnte(ids) {
    const list = ids.map((id) => players.find((p) => p.id === id)).filter(Boolean);
    for (const player of list) {
      pay(player, Math.min(baseBet, player.chips));
      if (player.chips === 0) player.isAllIn = true;
    }
    const allIns = list.filter((p) => p.isAllIn);
    if (allIns.length) {
      allInCap = Math.min(...allIns.map((p) => p.roundBet));
      currentBet = allInCap;
      for (const other of list) {
        if (other.roundBet <= allInCap) continue;
        const refund = other.roundBet - allInCap;
        other.roundBet -= refund; other.chips += refund; pot -= refund;
      }
    }
    note(`앤티로 ${baseBet.toLocaleString()}원씩 걷었습니다. (팟 ${pot.toLocaleString()}원)`);
    act('진행', `앤티 ${money(baseBet)}씩 걷음 (팟 ${money(pot)})`);
    for (const player of allIns) {
      note(`${player.nickname}님은 칩이 모자라 ${player.roundBet.toLocaleString()}원을 내고 올인했습니다.`);
      act(player.nickname, `앤티 ${money(player.roundBet)} (칩이 모자라 올인)`);
    }
  }

  function beginBetting() {
    const survivors = inRound().filter((p) => !p.isFolded);
    if (survivors.length === 0) { refundAndFinish('진행 가능한 참가자가 없어 이번 판을 종료합니다.'); return; }
    if (survivors.length === 1) { settle(survivors[0]); return; }
    // 앤티가 곧 지금의 배팅액이다(begin에서 걷었다). 앤티로 올인한 사람은 이미 할 일을
    // 다 한 것이라 행동한 것으로 치고, 차례도 건너뛴다. 올인 상한도 그대로 이어 간다.
    phase = 'betting'; turn = 0; minRaise = baseBet;
    currentBet = allInCap !== null ? allInCap : baseBet;
    acted = new Set(survivors.filter((p) => p.isAllIn).map((p) => p.id));
    note('카드 선택이 끝났습니다. 배팅을 시작합니다.');
    act('진행', `카드 선택 끝, 배팅 시작 (${survivors.map((p) => p.nickname).join(', ')})`);
    skipAllInTurn();
    // 남은 사람이 전부 앤티로 올인했다면 배팅할 것이 없다.
    if (bettingDone()) { showdown(); return; }
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
    pay(player, needed); acted.add(playerId);
    // 앤티를 낸 뒤 더 낼 것이 없으면 콜이 아니라 체크다.
    note(needed ? `${player.nickname}님이 ${needed.toLocaleString()}원을 콜했습니다.` : `${player.nickname}님이 체크했습니다.`);
    act(player.nickname, needed ? `콜 ${money(needed)}` : '체크');
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
    note(`${player.nickname}님이 ${value.toLocaleString()}원을 레이즈했습니다.`);
    act(player.nickname, `레이즈 ${money(value)} (판돈 ${money(currentBet)})`);
    armActionTimer(); changed(); return null;
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
    act(player.nickname, player.isAllIn ? `올인 ${money(allInCap)}` : `상대가 받을 수 있는 최대 ${money(allInCap)} (칩 ${money(player.chips)} 남김)`);
    // 남은 사람이 모두 행동했고 금액도 맞췄다면 여기서 배팅이 끝난다(call()과 같은 판정).
    if (bettingDone()) { showdown(); return null; }
    advanceBet(); armActionTimer(); changed(); return null;
  }

  function fold(playerId, timedOut) {
    const player = currentBetPlayer();
    if (phase !== 'betting' || !player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    player.isFolded = true; note(timedOut ? `${player.nickname}님의 제한시간이 지나 자동 폴드되었습니다.` : `${player.nickname}님이 폴드했습니다.`);
    act(player.nickname, timedOut ? '폴드 (시간 초과)' : '폴드');
    if (bettingPlayers().length === 1) { settle(bettingPlayers()[0]); return null; }
    // 남은 사람들이 이미 다 행동했고 금액도 맞췄다면 이 배팅은 끝난 것이다(call()과 같은
    // 판정). 이게 없으면 마지막 차례인 사람이 폴드했을 때 차례가 처음으로 돌아가,
    // 이미 콜을 맞춘 사람이 또 내야 하는 상황이 된다.
    if (bettingDone()) { showdown(); return null; }
    turn %= bettingPlayers().length; skipAllInTurn(); armActionTimer(); changed(); return null;
  }

  function showdown() {
    act('진행', `쇼다운: ${bettingPlayers().map((p) => `${p.nickname} ${p.score > 21 ? `${p.score}점(21 초과)` : `${p.score}점`}/${p.hand.length}장`).join(' · ')}`);
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
      act('진행', `동점 재대결 카드: ${drawn.map((entry) => `${entry.player.nickname} ${cardName(entry.player.tieCards[entry.player.tieCards.length - 1])}(${entry.value})`).join(' · ')}`);
      const bestTieCard = Math.max(...drawn.map((entry) => entry.value));
      candidates = drawn.filter((entry) => entry.value === bestTieCard).map((entry) => entry.player);
    }
    if (candidates.length === 1) settle(candidates[0]);
    else refundAndFinish('동점을 가리지 못해 배팅금을 돌려드립니다.');
  }

  function settle(winner) {
    if (!winner) return;
    clearActionTimer();
    const amount = pot; winner.chips += pot; pot = 0; phase = 'result'; departedStakes.clear();
    result = { winnerId: winner.id, nickname: winner.nickname, amount, noWinner: false };
    note(`${winner.nickname}님이 ${winner.score}점으로 팟 ${amount.toLocaleString()}원을 획득했습니다.`);
    act(winner.nickname, `팟 ${money(amount)} 획득 (${winner.score}점) → 칩 ${money(winner.chips)}`);
    players.forEach((p) => { p.ready = false; p.isAllIn = false; p.roundBet = 0; }); changed();
  }

  function refundAndFinish(message) {
    clearActionTimer();
    for (const player of players) { player.chips += player.roundBet; player.roundBet = 0; player.ready = false; player.isAllIn = false; }
    returnDepartedStakes();
    pot = 0; phase = 'result'; result = { noWinner: true, message }; note(message); act('진행', `환불 - ${message}`); changed();
  }

  function donate(fromId, toId, amount) {
    if (phase !== 'lobby' && phase !== 'result') return '기부는 대기 중에만 할 수 있습니다.';
    const from = players.find((p) => p.id === fromId); const to = players.find((p) => p.id === toId); const value = Number(amount);
    if (!from || !to || from === to) return '기부 대상을 확인해 주세요.';
    if (to.chips >= baseBet) return '현재 칩이 부족한 참가자에게만 기부할 수 있습니다.';
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0 || from.chips < value) return '기부 금액과 보유 칩을 확인해 주세요.';
    from.chips -= value; to.chips += value; note(`${from.nickname}님이 ${to.nickname}님에게 ${value.toLocaleString()}원을 기부했습니다.`);
    act(from.nickname, `기부 → ${to.nickname} ${money(value)}`);
    changed(); return null;
  }

  function stateFor(playerId) {
    const me = players.find((p) => p.id === playerId);
    const playingTurn = currentPlayingPlayer();
    const bettingTurn = currentBetPlayer();
    return {
      type: 'blackjackState', phase, hostId, baseBet, pot, currentBet, minRaise, allInCap, result,
      turnPlayerId: phase === 'playing' ? playingTurn && playingTurn.id : phase === 'betting' ? bettingTurn && bettingTurn.id : null,
      // 차례인 사람이 화면을 가려 제한시간이 멈춰 있는가(web/cover-pause.js)
      paused: pause.pausedAt() !== null,
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
    pause.dispose();
    for (const timer of dropTimers.values()) clearTimeout(timer);
    dropTimers.clear();
  }

  return { join, disconnect, leave, setCovered, setReady, proposeBaseBet, voteBaseBet, begin, hit, stand, call, raise, allin, fold, donate, stateFor, dispose, status: () => ({ phase, playerCount: players.filter((p) => p.connected).length }) };
}

module.exports = { createBlackjackRoom, scoreHand, INITIAL_CHIPS };
