'use strict';

const crypto = require('crypto');
const { createCoverPause } = require('./cover-pause');
const { cleanNickname } = require('./protocol');
const { createSafeTimeout, uniqueName } = require('./room-helpers');
const { bestHand, compareEvaluations } = require('./holdem-eval');

const INITIAL_CHIPS = 1000000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
/**
 * 칩을 나누는 가장 작은 단위. 스몰 블라인드가 기본 배팅금(= 빅 블라인드)의 절반이라 50원 단위 칩이 생긴다.
 * 팟을 비긴 사람들에게 나눌 때 남는 몫도 이 단위로 나눠야 칩이 50원 단위로 유지된다.
 */
const CHIP_UNIT = 50;
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const STREET_NAMES = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };

/**
 * 텍사스 홀덤 방.
 *
 * 인디언 포커(web/poker-room.js)와 같은 틀이다 - 준비 → 시작 확인, 기본 배팅금 투표, 칩 보관, 접속이 끊겼을 때의
 * 유예, 제한시간, 보스 키로 멈추는 제한시간. 다른 점만 적는다.
 *
 *   - 딜러 버튼이 판마다 한 칸씩 돈다. 딜러 다음 사람이 스몰 블라인드(기본 배팅금의 절반), 그다음이 빅 블라인드(기본
 *     배팅금)를 먼저 낸다. 둘이서 할 때는 딜러가 스몰 블라인드이고 프리플랍에서 먼저 말한다.
 *   - 판은 프리플랍 → 플랍(공용 3장) → 턴(1장) → 리버(1장) 순서이고, 거리마다 배팅한다. 마지막까지 남으면 내 카드 2장과
 *     공용 5장 중 가장 좋은 5장으로 겨룬다(web/holdem-eval.js). 비기면 팟을 나눈다.
 *   - 올인은 인디언 포커와 같은 규칙이다: 사이드 팟이 없다. 올인이 나오면 그 금액이 이 판의 배팅 상한이 되고, 더 낸 사람은
 *     넘치는 몫을 돌려받는다. 상한이 정해지면 더 배팅할 수 없으니 남은 공용 카드를 한꺼번에 깔고 바로 겨룬다.
 *   - 제한시간이 지났을 때 공짜로 넘어갈 수 있으면(낼 돈이 없으면) 폴드가 아니라 체크로 처리한다.
 */
function createHoldemRoom(options) {
  const notify = options.onChange || (() => {});
  // [관리 로그] 누가 무엇을 했는지 알린다. 서버가 "[홀덤] 닉네임 > 행동"으로 남긴다.
  // 판이 끝나기 전에는 남의 카드를 적지 않는다(로그를 보는 사람이 게임에 끼면 미리 알게 된다). 공용 카드는 모두가 보는 것이라 적는다.
  const onAction = options.onAction || (() => {});
  const act = (who, what) => { try { onAction(who, what); } catch { /* 로그 실패는 무시 */ } };
  const money = (value) => `${Number(value || 0).toLocaleString()}원`;
  const cardName = (card) => (card ? ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[card.rank] || card.rank) + card.suit : '?');
  const cardsName = (cards) => cards.map(cardName).join(' ');
  const players = [];
  const history = [];
  let phase = 'lobby'; // lobby | betting | result
  let street = null;
  let baseBet = 100;
  let pot = 0;
  let deck = [];
  let board = [];
  let contenders = []; // 이번 판에 카드를 받은 사람들(자리 순서). 나간 사람의 id도 남겨 자리 순서를 지킨다.
  // 이번 판의 참가자 명단. 폴드한 사람도 이 판의 참가자였으므로 테이블을 계속 볼 수 있어야 한다.
  let dealtIn = [];
  let dealerId = null;
  let dealerSeat = 0; // 딜러가 앉은 자리 번호. 딜러가 나갔을 때 그 자리에 이제 앉은 사람부터 다음 딜러를 찾는다.
  let smallBlindId = null;
  let bigBlindId = null;
  let turn = 0;
  let currentBet = 0;
  // 이번 거리에서 다음 레이즈가 최소한 올려야 하는 금액. 직전에 누가 올린 폭이 기준이고, 아무도 안 올렸으면 기본 배팅금이다.
  let minRaise = 100;
  let allInCap = null;
  let acted = new Set();
  let result = null;
  let baseBetProposal = null;
  let proposalTimer = null;
  const dropTimers = new Map();
  // 자리를 잃은 사람의 칩을 토큰에 묶어 둔다(web/poker-room.js의 chipBank 참고).
  const chipBank = new Map(); // token -> chips
  const actionTimeoutMs = Number.isFinite(options.actionTimeoutMs) ? options.actionTimeoutMs : 30000;
  const proposalTimeoutMs = Number.isFinite(options.proposalTimeoutMs) ? options.proposalTimeoutMs : 30000;
  const disconnectGraceMs = Number.isFinite(options.disconnectGraceMs) ? options.disconnectGraceMs : 10000;

  const makeId = () => crypto.randomBytes(8).toString('hex');
  const makeToken = () => crypto.randomBytes(18).toString('hex');
  const playerOf = (pid) => players.find((p) => p.id === pid);
  const nameOf = (pid) => (playerOf(pid) || {}).nickname || '(나간 참가자)';
  const active = () => contenders.map(playerOf).filter((p) => p && !p.isFolded);
  const current = () => active()[turn % Math.max(active().length, 1)];
  const note = (text) => { history.push({ text, timestamp: Date.now() }); if (history.length > 40) history.shift(); };
  const safeTimeout = createSafeTimeout('홀덤');
  // [보스 키] 차례인 사람이 화면을 가리고 있으면 그 사람의 제한시간을 멈춘다(web/cover-pause.js).
  const pause = createCoverPause({
    setTimer: safeTimeout, clearTimer: clearTimeout, unref: true, maxPauseMs: options.maxCoverPauseMs,
    isWaitingOn: (pid) => phase === 'betting' && !!current() && current().id === pid,
    onExpire: () => changed(),
  });
  const actionClock = pause.timer;
  /** 상태를 알리기 직전마다 멈춤 여부를 맞춘다. 차례가 넘어가는 것도 여기서 반영된다. */
  function changed() {
    const turned = pause.sync();
    if (turned && turned.paused) act(turned.paused.map(nameOf).join(', '), '화면 가림 - 제한시간 멈춤');
    else if (turned) act('진행', `제한시간 다시 흐름 (${Math.round(turned.resumedAfterMs / 1000)}초 멈춤${turned.expired ? ', 멈출 수 있는 최대 시간 초과' : ''})`);
    notify();
  }
  const clearActionTimer = () => actionClock.clear();
  const clearProposalTimer = () => { if (proposalTimer) clearTimeout(proposalTimer); proposalTimer = null; };
  const cancelDrop = (pid) => { const timer = dropTimers.get(pid); if (timer) clearTimeout(timer); dropTimers.delete(pid); };

  /** 차례인 사람의 제한시간. 시간이 지나면 낼 돈이 없을 때는 체크, 있을 때는 폴드한다. */
  function armActionTimer() {
    clearActionTimer();
    if (phase !== 'betting' || actionTimeoutMs <= 0) return;
    const player = current();
    if (!player) return;
    actionClock.start(() => {
      const waiting = current();
      if (!waiting || waiting.id !== player.id) return;
      if (currentBet - waiting.roundBet <= 0) call(waiting.id, true); else fold(waiting.id, true);
    }, actionTimeoutMs);
  }

  /** 남은 사람이 모두 행동했고 금액도 맞췄는가. 상한이 정해진 뒤에는 낼 돈이 같으면 더 정할 것이 없다. */
  function bettingDone() {
    return active().every((x) => x.roundBet === currentBet && (x.isAllIn || allInCap !== null || acted.has(x.id)));
  }
  /** 차례가 올인한 사람에게 가면 건너뛴다. 올인한 사람은 정할 것이 없어서, 차례를 받으면 제한시간에 걸려 자동 폴드된다. */
  function skipAllInTurn() {
    const list = active();
    for (let step = 0; step < list.length; step += 1) {
      const index = (turn + step) % list.length;
      if (!list[index].isAllIn) { turn = index; return; }
    }
  }
  /** 차례를 다음 사람(올인한 사람은 건너뜀)에게 넘긴다. */
  function advance() {
    const list = active();
    if (list.length <= 1) return;
    const cur = current();
    const idx = list.findIndex((p) => p.id === (cur && cur.id));
    for (let step = 1; step <= list.length; step += 1) {
      const next = list[(idx + step) % list.length];
      if (!next.isAllIn) { turn = list.indexOf(next); return; }
    }
    turn = (idx + 1) % list.length; // 전원 올인 - 배팅 종료 판정이 처리한다
  }
  /** startId 다음 자리부터 돌면서 처음 만나는, 아직 판에 남아 있고 올인하지 않은 사람에게 차례를 준다. */
  function turnToFirstAfter(startId) {
    const start = contenders.indexOf(startId);
    for (let step = 1; step <= contenders.length; step += 1) {
      const candidate = playerOf(contenders[(start + step) % contenders.length]);
      if (candidate && !candidate.isFolded && !candidate.isAllIn) {
        turn = active().findIndex((p) => p.id === candidate.id);
        return;
      }
    }
    turn = 0;
  }

  /**
   * 배팅 중에 누가 빠진 뒤(나가기·끊김) 판을 이어 간다. 남은 사람이 한 명이면 그 사람이 팟을 가져가고,
   * 남은 사람이 이미 모두 행동했고 금액도 맞췄다면 이 거리의 배팅은 끝난 것이다.
   */
  function continueAfterDeparture(previousTurnId, departedId) {
    const left = active();
    if (left.length === 1) { settleByFold(left[0]); return; }
    if (left.length === 0) return;
    if (bettingDone()) { finishBetting(); return; }
    const preserved = left.findIndex((player) => player.id === previousTurnId);
    if (preserved >= 0) turn = preserved;
    else {
      // 차례인 사람이 나갔다: 그 자리 다음 사람에게 넘긴다.
      const departedIndex = contenders.indexOf(departedId);
      turn = 0;
      for (let offset = 1; offset <= contenders.length; offset += 1) {
        const next = left.findIndex((player) => player.id === contenders[(departedIndex + offset) % contenders.length]);
        if (next >= 0) { turn = next; break; }
      }
    }
    skipAllInTurn();
    armActionTimer();
  }

  function scheduleDrop(pid) {
    cancelDrop(pid);
    const timer = safeTimeout(() => {
      dropTimers.delete(pid);
      const p = playerOf(pid);
      if (!p || p.connected) return;
      const inHand = phase === 'betting' && contenders.includes(pid) && !p.isFolded;
      // 올인하고 결과를 기다리는 사람은 판이 끝날 때까지 자리를 남긴다. 여기서 빼면 이미 건 칩을 겨뤄 보지도 못하고 잃는다.
      if (inHand && p.isAllIn) { scheduleDrop(pid); return; }
      if (inHand) {
        const previousTurnId = current() && current().id;
        p.isFolded = true;
        note(`${p.nickname}님이 돌아오지 않아 폴드 처리되었습니다.`);
        act(p.nickname, '폴드 (연결이 끊긴 채 돌아오지 않음)');
        continueAfterDeparture(previousTurnId, pid);
      }
      act(p.nickname, `자리 정리 (돌아오지 않음, 칩 ${money(p.chips)} 보관)`);
      chipBank.set(p.token, p.chips);
      players.splice(players.indexOf(p), 1);
      changed();
    }, Math.max(0, disconnectGraceMs));
    if (timer.unref) timer.unref();
    dropTimers.set(pid, timer);
  }

  function resetEmptyRoom() {
    if (players.some((p) => p.connected)) return false;
    clearActionTimer(); clearProposalTimer(); pause.reset();
    for (const timer of dropTimers.values()) clearTimeout(timer);
    dropTimers.clear();
    chipBank.clear(); // 아무도 없는 방은 새 방이다. 칩도 처음부터 다시 시작한다.
    players.length = 0; history.length = 0; phase = 'lobby'; street = null; baseBet = 100;
    pot = 0; deck = []; board = []; contenders = []; dealtIn = []; dealerId = null; dealerSeat = 0;
    smallBlindId = null; bigBlindId = null; turn = 0; currentBet = 0; minRaise = 100; allInCap = null;
    acted = new Set(); result = null; baseBetProposal = null;
    return true;
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
  // 테스트에서만: 덱을 고정한다(누가 이기는지 보려면 카드를 알아야 한다). 실제 서버는 주지 않는다. 카드는 뒤에서부터 뽑는다.
  const makeDeck = typeof options.makeDeck === 'function' ? options.makeDeck : freshDeck;
  // 테스트에서만: 자리 번호(0부터)마다 시작 칩을 다르게 준다. 칩이 모자란 사람이 있는 판을 만들려는 것이다. 실제 서버는 주지 않는다.
  const startingChips = () => (typeof options.initialChips === 'function' ? options.initialChips(players.length) : INITIAL_CHIPS);
  // 덱은 52장이고 한 판에 쓰는 카드는 많아야 5×2+5장이라 모자랄 일이 없다.
  const deal = (count) => { const cards = []; for (let i = 0; i < count; i += 1) cards.push(deck.pop()); return cards; };

  function join({ nickname, token: oldToken }) {
    const clean = cleanNickname(nickname); // 글자 단위로 자른다(web/protocol.js)
    if (!clean) return { error: '닉네임을 입력해 주세요.' };
    // 새 소켓이 먼저 열리고 이전 소켓의 close가 늦게 도착할 수 있다. 토큰이 같으면 연결 상태와 관계없이 같은 자리다.
    const restored = players.find((p) => p.token === oldToken);
    if (restored) {
      cancelDrop(restored.id);
      // 새로 열린 화면이 가려져 있는지는 그 화면이 다시 알려 준다. 이전 화면의 상태는 버린다.
      pause.forget(restored.id);
      restored.connected = true;
      restored.nickname = uniqueName(new Set(players.filter((p) => p.id !== restored.id).map((p) => p.nickname)), clean, makeId);
      act(restored.nickname, '재접속');
      changed();
      return { playerId: restored.id, token: restored.token, restored: true };
    }
    if (players.length >= MAX_PLAYERS) return { error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` };
    const waiting = phase === 'betting';
    // 같은 토큰으로 돌아왔다면 나갈 때 들고 있던 칩을 그대로 돌려준다.
    const kept = chipBank.get(oldToken);
    if (oldToken) chipBank.delete(oldToken);
    const p = {
      id: makeId(), token: kept === undefined ? makeToken() : oldToken,
      nickname: uniqueName(new Set(players.map((x) => x.nickname)), clean, makeId),
      chips: kept === undefined ? startingChips() : kept, connected: true, ready: false,
      hole: [], isAllIn: false, isFolded: waiting, roundBet: 0, roundContribution: 0, lastAction: '',
    };
    players.push(p);
    act(p.nickname, `입장 (칩 ${money(p.chips)}${kept === undefined ? '' : ', 보관해 둔 칩 복구'}${waiting ? ', 다음 판부터' : ''})`);
    changed();
    return { playerId: p.id, token: p.token, restored: false };
  }

  function disconnect(pid) {
    const p = playerOf(pid);
    if (!p) return;
    p.connected = false;
    pause.forget(pid);
    act(p.nickname, '연결 끊김');
    if (baseBetProposal) { clearProposalTimer(); baseBetProposal = null; note('참가 인원이 바뀌어 블라인드 투표가 취소되었습니다.'); act('투표', '블라인드 투표 취소 (인원 변경)'); }
    // 끊겼다고 곧바로 폴드하지 않는다. 자리를 남겨 두는 유예 동안 돌아오면 그대로 이어서 하고, 그래도 안 돌아오면 그때 폴드한다.
    // 새로고침·폰 화면 잠금·와이파이→LTE 전환만으로 건 돈을 잃지 않게 하려는 것이다(web/poker-room.js와 같은 이유).
    if (phase === 'betting' && contenders.includes(pid) && !p.isFolded && !p.isAllIn) {
      note(`${p.nickname}님의 연결이 끊겼습니다. ${Math.max(1, Math.round(disconnectGraceMs / 1000))}초 안에 돌아오지 않으면 폴드됩니다.`);
    }
    if (!resetEmptyRoom()) scheduleDrop(pid);
    changed();
  }

  function leave(pid) {
    const index = players.findIndex((p) => p.id === pid);
    if (index < 0) return;
    const p = players[index];
    cancelDrop(pid);
    pause.forget(pid);
    act(p.nickname, `나감 (칩 ${money(p.chips)} 보관)`);
    if (baseBetProposal) { clearProposalTimer(); baseBetProposal = null; note('참가 인원이 바뀌어 블라인드 투표가 취소되었습니다.'); act('투표', '블라인드 투표 취소 (인원 변경)'); }
    const previousTurnId = phase === 'betting' && current() ? current().id : null;
    const wasInHand = phase === 'betting' && contenders.includes(pid) && !p.isFolded;
    if (wasInHand) {
      p.isFolded = true;
      note(`${p.nickname}님이 방을 나가 폴드 처리되었습니다.`);
      act(p.nickname, '폴드 (방을 나감)');
    }
    chipBank.set(p.token, p.chips);
    players.splice(index, 1);
    if (wasInHand) continueAfterDeparture(previousTurnId, pid);
    resetEmptyRoom();
    changed();
  }

  /** [보스 키] 이 사람의 화면이 가려졌는지/돌아왔는지. 화면이 알려 준다(public/cover.js). */
  function setCovered(pid, covered) {
    if (!playerOf(pid)) return;
    pause.set(pid, covered === true);
    changed();
  }

  function setReady(pid, ready) {
    if (phase !== 'lobby' && phase !== 'result') return '대기 중에만 준비 상태를 바꿀 수 있습니다.';
    const p = playerOf(pid);
    if (!p) return '참가자를 찾을 수 없습니다.';
    p.ready = !!ready;
    changed();
    return null;
  }

  /** 기본 배팅금(= 빅 블라인드) 변경 제안. 혼자면 바로 바뀌고, 아니면 나머지의 과반수 찬성이 필요하다. */
  function setBaseBet(pid, amount) {
    if (phase !== 'lobby' && phase !== 'result') return '게임 중에는 변경할 수 없습니다.';
    const proposer = players.find((p) => p.id === pid && p.connected);
    if (!proposer) return '참가자를 찾을 수 없습니다.';
    if (baseBetProposal) return '이미 블라인드 투표가 진행 중입니다.';
    const value = Number(amount);
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0 || value > INITIAL_CHIPS) return '빅 블라인드는 100원 단위로 설정해 주세요.';
    if (players.filter((p) => p.connected).length === 1) {
      baseBet = value;
      note(`블라인드가 ${money(value / 2)} / ${money(value)}으로 변경되었습니다.`);
      act(proposer.nickname, `블라인드 ${money(value / 2)}/${money(value)}으로 변경 (혼자라 바로 적용)`);
      changed();
      return null;
    }
    baseBetProposal = { id: makeId(), proposerId: pid, proposerName: proposer.nickname, amount: value, votes: new Map() };
    note(`${proposer.nickname}님이 블라인드 ${money(value / 2)} / ${money(value)}을 제안했습니다.`);
    act(proposer.nickname, `블라인드 ${money(value / 2)}/${money(value)} 제안`);
    proposalTimer = safeTimeout(() => {
      if (!baseBetProposal) return;
      note('블라인드 투표 시간이 끝나 변경이 취소되었습니다.'); act('투표', '블라인드 투표 시간 초과로 취소'); baseBetProposal = null; proposalTimer = null; changed();
    }, proposalTimeoutMs);
    changed();
    return null;
  }

  function voteBaseBet(pid, proposalId, agree) {
    if (phase !== 'lobby' && phase !== 'result') return '게임 중에는 투표할 수 없습니다.';
    if (!baseBetProposal || baseBetProposal.id !== proposalId) return '종료된 투표입니다.';
    const voter = players.find((p) => p.id === pid && p.connected);
    if (!voter) return '참가자를 찾을 수 없습니다.';
    if (pid === baseBetProposal.proposerId) return '제안자는 투표 대상이 아닙니다.';
    if (baseBetProposal.votes.has(pid)) return '이미 투표했습니다.';
    baseBetProposal.votes.set(pid, !!agree);
    const amount = baseBetProposal.amount;
    act(voter.nickname, `블라인드 ${money(amount / 2)}/${money(amount)} ${agree ? '찬성' : '반대'}`);
    const voters = players.filter((p) => p.connected && p.id !== baseBetProposal.proposerId);
    const required = Math.ceil(voters.length / 2);
    const agreed = [...baseBetProposal.votes.values()].filter(Boolean).length;
    const remaining = voters.length - baseBetProposal.votes.size;
    if (agreed >= required) {
      baseBet = amount;
      note(`찬성 ${agreed}명으로 블라인드가 ${money(amount / 2)} / ${money(amount)}으로 변경되었습니다.`);
      act('투표', `블라인드 ${money(amount / 2)}/${money(amount)}으로 변경 (찬성 ${agreed}명)`);
      clearProposalTimer();
      baseBetProposal = null;
    } else if (agreed + remaining < required || remaining === 0) {
      note(`찬성 ${agreed}명으로 블라인드 변경이 거절되었습니다. 다시 설정해 주세요.`);
      act('투표', `블라인드 변경 부결 (찬성 ${agreed}명)`);
      clearProposalTimer();
      baseBetProposal = null;
    }
    changed();
    return null;
  }

  function pay(p, amount) {
    p.chips -= amount; p.roundBet += amount; p.roundContribution += amount; pot += amount;
  }

  /**
   * [규칙] 이 판의 배팅 상한을 value(이번 거리에 낸 금액)로 정한다. 이미 더 낮은 상한이 있으면 그쪽이 남는다.
   * 상한보다 많이 낸 사람에게는 넘치는 몫을 돌려준다 - 사이드 팟이 없으므로 아무도 맞출 수 없는 돈을 팟에 남기지 않는다.
   * (폴드한 사람이 이미 낸 칩은 그대로 팟에 남는다 - 포기한 돈이다)
   * 상한이 정해지면 더 올릴 수 없고, 이 거리의 배팅이 끝나면 남은 공용 카드를 바로 깔고 겨룬다.
   * 앞선 거리에서는 남은 사람 모두가 같은 금액을 냈으므로, 이번 거리에 낸 금액만 견주면 된다.
   */
  function capBetting(value) {
    allInCap = allInCap === null ? value : Math.min(allInCap, value);
    currentBet = allInCap;
    for (const x of active()) {
      if (x.roundBet <= allInCap) continue;
      const refund = x.roundBet - allInCap;
      x.roundBet -= refund; x.roundContribution -= refund; x.chips += refund; pot -= refund;
      x.isAllIn = x.chips === 0;
    }
  }

  /** 새 판. 블라인드를 걷고 카드를 나눠 프리플랍을 시작한다. */
  function begin(pid) {
    if (!players.some((p) => p.id === pid && p.connected)) return '방에 참가한 뒤 시작할 수 있습니다.';
    if (phase !== 'lobby' && phase !== 'result') return '이미 게임이 진행 중입니다.';
    if (baseBetProposal) return '블라인드 투표가 끝난 뒤 시작해 주세요.';
    const ready = players.filter((p) => p.connected && p.ready && p.chips > 0);
    if (ready.length < MIN_PLAYERS) return '준비한 참가자가 2명 이상이어야 합니다.';
    pot = 0; result = null; deck = makeDeck(); board = []; street = 'preflop';
    contenders = ready.map((p) => p.id);
    dealtIn = contenders.slice();
    act(playerOf(pid).nickname, `게임 시작 (${ready.length}명: ${ready.map((p) => p.nickname).join(', ')})`);
    note('새 판이 시작되었습니다.');
    for (const p of players) {
      p.roundBet = 0; p.roundContribution = 0; p.isAllIn = false; p.lastAction = ''; p.hole = [];
      p.isFolded = !contenders.includes(p.id);
    }
    startHand();
    changed();
    return null;
  }

  /** 다음 딜러. 지난 딜러 다음 자리부터 돌아 처음 만나는 참가자이고, 지난 딜러가 나갔다면 그 자리에 이제 앉은 사람부터 찾는다. */
  function pickDealer() {
    const previous = players.findIndex((p) => p.id === dealerId);
    const start = previous >= 0 ? previous + 1 : dealerSeat;
    for (let step = 0; step < players.length; step += 1) {
      const p = players[(start + step) % players.length];
      if (contenders.includes(p.id)) return p;
    }
    return playerOf(contenders[0]);
  }

  function startHand() {
    const dealer = pickDealer();
    dealerId = dealer.id; dealerSeat = players.indexOf(dealer);
    const at = contenders.indexOf(dealerId);
    const after = (offset) => playerOf(contenders[(at + offset) % contenders.length]);
    const headsUp = contenders.length === 2;
    const small = headsUp ? dealer : after(1);
    const big = headsUp ? after(1) : after(2);
    smallBlindId = small.id; bigBlindId = big.id;
    street = 'preflop';
    currentBet = 0; minRaise = baseBet; allInCap = null; acted = new Set();
    for (const p of active()) p.hole = deal(2);

    pay(small, Math.min(baseBet / 2, small.chips));
    pay(big, Math.min(baseBet, big.chips));
    currentBet = big.roundBet;
    const shorts = [small, big].filter((p) => p.chips === 0);
    for (const p of shorts) p.isAllIn = true;
    if (shorts.length) capBetting(Math.min(...shorts.map((p) => p.roundBet)));
    note(`딜러 ${dealer.nickname}님. ${small.nickname}님이 스몰 블라인드 ${money(small.roundBet)}, ${big.nickname}님이 빅 블라인드 ${money(big.roundBet)}을 냈습니다.`);
    act('진행', `딜러 ${dealer.nickname} · 스몰 블라인드 ${small.nickname} ${money(small.roundBet)} · 빅 블라인드 ${big.nickname} ${money(big.roundBet)}`);
    for (const p of shorts) {
      note(`${p.nickname}님은 칩이 모자라 ${money(p.roundBet)}을 내고 올인했습니다.`);
      act(p.nickname, `블라인드 ${money(p.roundBet)} (칩이 모자라 올인)`);
    }
    phase = 'betting';
    // 프리플랍은 빅 블라인드 다음 사람부터 말한다(둘이서 할 때는 그게 딜러다).
    turnToFirstAfter(bigBlindId);
    skipAllInTurn();
    if (bettingDone()) { finishBetting(); return; }
    armActionTimer();
  }

  function call(pid, timedOut) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    const p = current();
    const need = Math.max(0, currentBet - p.roundBet);
    if (p.chips < need) return '콜할 칩이 부족합니다. 올인을 선택하세요.';
    pay(p, need); acted.add(pid);
    p.lastAction = need ? 'call' : 'check';
    if (timedOut) {
      note(`${p.nickname}님의 제한시간이 지나 자동 체크되었습니다.`);
      act(p.nickname, '체크 (시간 초과)');
    } else {
      note(need ? `${p.nickname}님이 ${money(need)}을 콜했습니다.` : `${p.nickname}님이 체크했습니다.`);
      act(p.nickname, need ? `콜 ${money(need)}` : '체크');
    }
    // 가진 칩을 전부 내고 콜했다면 올인이다 - 이 금액이 이 판의 상한이 된다.
    if (p.chips === 0) {
      p.isAllIn = true; p.lastAction = 'allin';
      capBetting(p.roundBet);
    }
    if (bettingDone()) return finishBetting();
    advance(); armActionTimer(); changed(); return null;
  }

  function raise(pid, amount) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    if (allInCap !== null) return '올인 이후에는 레이즈할 수 없습니다.';
    const value = Number(amount);
    const p = current();
    const need = currentBet - p.roundBet + value;
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0) return '레이즈는 100원 단위로 입력해 주세요.';
    // 레이즈 폭은 직전 레이즈 폭 이상이어야 한다. 이게 없으면 100원씩 올리는 것만 반복해서 앞사람이 크게 올린 판을 사실상 없던 일로 만들 수 있다.
    if (value < minRaise) return `레이즈는 직전 레이즈 금액인 ${money(minRaise)} 이상이어야 합니다.`;
    if (need >= p.chips) return '레이즈 후 칩이 남아야 합니다. 전액은 올인을 사용하세요.';
    pay(p, need); currentBet += value; minRaise = value; acted = new Set([pid]);
    p.lastAction = 'raise';
    advance();
    note(`${p.nickname}님이 ${money(value)}을 레이즈했습니다.`);
    act(p.nickname, `레이즈 ${money(value)} (판돈 ${money(currentBet)})`);
    armActionTimer(); changed(); return null;
  }

  /**
   * 올인. 상대가 받을 수 없는 몫은 애초에 걸지 않는다(web/poker-room.js의 allin과 같은 규칙).
   * 이 판에서 실제로 겨룰 수 있는 최대는 "나 말고 가장 많이 가진 사람"이 낼 수 있는 전부다. 상대가 먼저 올인했더라도
   * 그보다 적은 칩으로 올인할 수 있고, 그러면 상한이 그 금액으로 내려간다.
   */
  function allin(pid) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    const p = current();
    if (p.chips <= 0) return '올인할 칩이 없습니다.';
    const rivals = active().filter((x) => x.id !== pid);
    const reachable = rivals.length ? Math.max(...rivals.map((x) => x.roundBet + x.chips)) : Infinity;
    // 이미 낸 것보다 적게 되돌릴 수는 없다(레이즈로 앞서 더 냈을 수 있다).
    const cap = Math.max(p.roundBet, Math.min(p.roundBet + p.chips, reachable));
    pay(p, cap - p.roundBet);
    capBetting(cap);
    // 환불까지 끝난 뒤에야 "정말 다 걸었는지"가 정해진다. 상한에 막혀 칩이 남았다면 올인이 아니다.
    p.isAllIn = p.chips === 0;
    p.lastAction = p.isAllIn ? 'allin' : 'raise';
    acted.add(pid);
    note(p.isAllIn
      ? `${p.nickname}님이 ${money(allInCap)}에 올인했습니다.`
      : `${p.nickname}님이 상대가 받을 수 있는 최대인 ${money(allInCap)}을 걸었습니다.`);
    act(p.nickname, p.isAllIn ? `올인 ${money(allInCap)}` : `상대가 받을 수 있는 최대 ${money(allInCap)} (칩 ${money(p.chips)} 남김)`);
    if (bettingDone()) return finishBetting();
    advance(); armActionTimer(); changed(); return null;
  }

  function fold(pid, timedOut) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    const p = current();
    p.isFolded = true; p.lastAction = 'fold'; acted.add(pid);
    note(timedOut ? `${p.nickname}님의 제한시간이 지나 자동 폴드되었습니다.` : `${p.nickname}님이 폴드했습니다.`);
    act(p.nickname, timedOut ? '폴드 (시간 초과)' : '폴드');
    const left = active();
    if (left.length === 1) return settleByFold(left[0]);
    // 남은 사람들이 이미 다 행동했고 금액도 맞췄다면 이 거리의 배팅은 끝난 것이다.
    if (bettingDone()) return finishBetting();
    turn %= left.length; skipAllInTurn(); armActionTimer(); changed(); return null;
  }

  /** 이 거리의 배팅이 끝났다. 마지막 거리이거나 올인으로 상한이 정해졌으면 바로 겨루고, 아니면 다음 거리로 간다. */
  function finishBetting() {
    const list = active();
    if (list.length <= 1) return settleByFold(list[0]);
    if (street === 'river' || allInCap !== null || list.filter((p) => !p.isAllIn).length < 2) return runOut();
    return nextStreet();
  }

  function nextStreet() {
    street = STREETS[STREETS.indexOf(street) + 1];
    const cards = deal(street === 'flop' ? 3 : 1);
    board = board.concat(cards);
    for (const p of players) { p.roundBet = 0; if (!p.isFolded && !p.isAllIn) p.lastAction = ''; }
    currentBet = 0; minRaise = baseBet; acted = new Set();
    note(`${STREET_NAMES[street]}: ${cardsName(cards)}`);
    act('진행', `${STREET_NAMES[street]} ${cardsName(board)} (팟 ${money(pot)})`);
    // 거리마다 딜러 다음 사람부터 말한다(둘이서 할 때는 딜러가 마지막이라 상대가 먼저).
    turnToFirstAfter(dealerId);
    armActionTimer(); changed(); return null;
  }

  /** 올인으로 더 배팅할 수 없다. 남은 공용 카드를 한꺼번에 깔고 겨룬다. */
  function runOut() {
    if (board.length < 5) {
      const cards = deal(5 - board.length);
      board = board.concat(cards);
      street = 'river';
      note(`더 배팅할 수 없어 남은 공용 카드를 깔았습니다: ${cardsName(cards)}`);
      act('진행', `남은 공용 카드 공개 ${cardsName(board)}`);
    }
    return showdown();
  }

  /** 남은 사람 모두의 패를 겨룬다. 이긴 사람이 여럿이면 팟을 나눈다(남는 몫은 딜러 다음 자리 순서로 한 칸씩). */
  function showdown() {
    const hands = active().map((p) => ({ player: p, hand: bestHand(p.hole.concat(board)) }));
    let best = hands[0].hand;
    for (const { hand } of hands) if (compareEvaluations(hand, best) > 0) best = hand;
    const winnerHands = hands.filter(({ hand }) => compareEvaluations(hand, best) === 0);
    // 딜러 다음 자리부터 순서를 매긴다.
    const at = contenders.indexOf(dealerId);
    const order = (p) => (contenders.indexOf(p.id) - at - 1 + contenders.length) % contenders.length;
    winnerHands.sort((a, b) => order(a.player) - order(b.player));
    const shares = splitPot(pot, winnerHands.length);
    const winners = winnerHands.map(({ player, hand }, i) => ({ id: player.id, nickname: player.nickname, amount: shares[i], handName: hand.name }));
    act('진행', `쇼다운: ${hands.map(({ player, hand }) => `${player.nickname} ${cardsName(player.hole)} (${hand.name})`).join(' · ')}`);
    const shown = hands.map(({ player, hand }) => ({ id: player.id, nickname: player.nickname, cards: player.hole.slice(), name: hand.name, best: hand.best }));
    finishHand(winners, { revealed: true, hands: shown });
    return null;
  }

  /** 팟을 n등분한다. 나누어떨어지지 않는 몫은 앞사람부터 CHIP_UNIT씩 얹어 준다. */
  function splitPot(total, count) {
    const unit = total % CHIP_UNIT === 0 ? CHIP_UNIT : 1;
    const units = total / unit;
    const base = Math.floor(units / count);
    const extra = units - base * count;
    return Array.from({ length: count }, (_, i) => (base + (i < extra ? 1 : 0)) * unit);
  }

  function settleByFold(winner) {
    if (!winner) return null;
    finishHand([{ id: winner.id, nickname: winner.nickname, amount: pot }], { revealed: false, hands: [] });
    return null;
  }

  function finishHand(winners, { revealed, hands }) {
    clearActionTimer();
    const total = pot;
    for (const w of winners) playerOf(w.id).chips += w.amount;
    pot = 0; phase = 'result';
    result = { winners, amount: total, revealed, hands, board: board.slice() };
    for (const w of winners) {
      note(winners.length > 1
        ? `${w.nickname}님이 팟 ${money(total)} 중 ${money(w.amount)}을 가져갑니다${w.handName ? ` (${w.handName})` : ''}.`
        : `${w.nickname}님이 팟 ${money(w.amount)}을 획득했습니다${w.handName ? ` (${w.handName})` : ''}.`);
      act(w.nickname, `팟 ${money(w.amount)} 획득${revealed ? ` (${w.handName})` : ' (나머지가 폴드)'} → 칩 ${money(playerOf(w.id).chips)}`);
    }
    for (const p of players) { p.ready = false; p.isAllIn = false; p.roundBet = 0; p.roundContribution = 0; }
    changed();
  }

  function donate(fromId, toId, amount) {
    if (phase !== 'lobby' && phase !== 'result') return '기부는 대기 중에만 할 수 있습니다.';
    const from = playerOf(fromId); const to = playerOf(toId);
    const value = Number(amount);
    if (!from || !to || from === to) return '기부 대상을 확인해 주세요.';
    if (to.chips >= baseBet) return '현재 칩이 부족한 참가자에게만 기부할 수 있습니다.';
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0 || from.chips < value) return '기부 금액과 보유 칩을 확인해 주세요.';
    from.chips -= value; to.chips += value; note(`${from.nickname}님이 ${to.nickname}님에게 ${money(value)}을 기부했습니다.`);
    act(from.nickname, `기부 → ${to.nickname} ${money(value)}`);
    changed(); return null;
  }

  /** 지금 차례의 남은 제한시간(ms). 화면이 막대를 그리는 데 쓴다. 가려져 멈춰 있으면 멈춘 그대로다. */
  function turnRemainingMs() {
    const endsAt = actionClock.endsAt();
    if (endsAt === null || phase !== 'betting') return null;
    const paused = pause.pausedAt();
    return Math.max(0, endsAt - (paused !== null ? paused : Date.now()));
  }

  function stateFor(pid) {
    const me = playerOf(pid);
    // 폴드해도 이번 판 참가자였다면 계속 테이블을 볼 수 있어야 한다.
    const showdownIds = result && result.revealed ? new Set(result.hands.map((h) => h.id)) : new Set();
    const handNames = new Map((result && result.revealed ? result.hands : []).map((h) => [h.id, h.name]));
    const visiblePlayers = players.filter((p) => p.connected || (phase !== 'lobby' && contenders.includes(p.id) && !p.isFolded));
    return {
      type: 'holdemState', phase, street, baseBet, smallBlind: baseBet / 2, pot, currentBet, minRaise, allInCap,
      board: board.slice(), dealerId, smallBlindId, bigBlindId,
      // 차례는 배팅 중에만 있다. 판이 끝난 뒤에도 마지막 차례를 보내면 화면이 없는 차례를 그린다.
      turnPlayerId: phase === 'betting' && current() ? current().id : null,
      turnTotalMs: actionTimeoutMs > 0 ? actionTimeoutMs : null,
      turnRemainingMs: turnRemainingMs(),
      // 차례인 사람이 화면을 가려 제한시간이 멈춰 있는가(web/cover-pause.js)
      paused: pause.pausedAt() !== null,
      result, history: history.slice(-12),
      you: me ? { id: me.id, chips: me.chips, ready: me.ready, inRound: dealtIn.includes(me.id) } : null,
      baseBetProposal: baseBetProposal ? {
        id: baseBetProposal.id, proposerName: baseBetProposal.proposerName, amount: baseBetProposal.amount,
        agreed: [...baseBetProposal.votes.values()].filter(Boolean).length,
        voted: baseBetProposal.votes.size,
        total: players.filter((p) => p.connected && p.id !== baseBetProposal.proposerId).length,
        yourVote: pid === baseBetProposal.proposerId || baseBetProposal.votes.has(pid),
      } : null,
      canStart: !!me && (phase === 'lobby' || phase === 'result') && players.filter((p) => p.connected && p.ready && p.chips > 0).length >= MIN_PLAYERS,
      // 시작 버튼이 왜 꺼져 있는지 화면이 그대로 말해 줄 수 있게 서버가 사유를 내려 준다.
      readyCount: players.filter((p) => p.connected && p.ready && p.chips > 0).length,
      minPlayers: MIN_PLAYERS,
      players: visiblePlayers.map((p) => {
        // 내 카드는 늘 보인다. 남의 카드는 쇼다운까지 가서 공개된 판에서 겨룬 사람 것만 보인다 -
        // 모두 폴드해서 끝난 판의 승자도 카드를 보이지 않아도 된다(허세를 지킬 수 있다).
        let cards = null;
        if (p.hole.length) {
          if (p.id === pid || showdownIds.has(p.id)) cards = p.hole;
          else if (!p.isFolded && dealtIn.includes(p.id)) cards = p.hole.map(() => ({ hidden: true }));
        }
        return {
          id: p.id, nickname: p.nickname, chips: p.chips, ready: p.ready, connected: p.connected,
          inRound: dealtIn.includes(p.id), isFolded: p.isFolded, isAllIn: p.isAllIn,
          roundBet: p.roundBet, action: p.lastAction, cards, handName: handNames.get(p.id) || null,
        };
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

  return { join, disconnect, leave, setCovered, setReady, setBaseBet, voteBaseBet, begin, call, raise, allin, fold, donate, stateFor, dispose, status: () => ({ phase, playerCount: players.filter((p) => p.connected).length }) };
}

module.exports = { createHoldemRoom, INITIAL_CHIPS };
