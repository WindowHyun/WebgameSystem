'use strict';

const crypto = require('crypto');
const { error: logError } = require('../logger');
const { createCoverPause } = require('./cover-pause');

const INITIAL_CHIPS = 1000000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;

function createPokerRoom(options) {
  const notify = options.onChange || (() => {});
  // [관리 로그] 누가 무엇을 했는지 알린다. 서버가 "[포커] 닉네임 > 행동"으로 남긴다.
  // 배팅 중에는 카드를 넘기지 않는다(판이 끝나 모두에게 공개된 뒤에만). 로그를 보는
  // 사람이 게임에 끼면 남의 카드를 미리 알게 된다. 기록하다 실패해도 게임은 계속된다.
  const onAction = options.onAction || (() => {});
  const act = (who, what) => { try { onAction(who, what); } catch { /* 로그 실패는 무시 */ } };
  const money = (value) => `${Number(value || 0).toLocaleString()}원`;
  const cardName = (card) => (card ? ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[card.rank] || card.rank) + card.suit : '?');
  const players = [];
  const history = [];
  let phase = 'lobby';
  let hostId = null;
  let baseBet = 100;
  let pot = 0;
  let deck = [];
  let contenders = [];
  // 이번 판에 카드를 받은 사람들. contenders와 달리 동점 재대결이 일어나도 줄어들지
  // 않는다. 폴드한 사람도 이 판의 참가자였으므로 테이블을 계속 볼 수 있어야 하는데,
  // contenders로 판단하면 재대결 순간 동점자 둘만 남아 폴드한 사람 화면이 캄캄해졌다.
  let dealtIn = [];
  let turn = 0;
  let currentBet = 0;
  // 이번 배팅에서 다음 레이즈가 최소한 올려야 하는 금액. 직전에 누군가 올린 폭이 곧
  // 기준이 되고(포커의 일반 규칙), 아무도 안 올렸으면 기본 배팅금이 기준이다.
  let minRaise = 100;
  let allInCap = null;
  let acted = new Set();
  let result = null;
  let baseBetProposal = null;
  let proposalTimer = null;
  const dropTimers = new Map();
  // 자리를 잃은 사람의 칩을 토큰에 묶어 둔다. 이게 없으면 나갔다 다시 들어오는 것만으로
  // 칩이 INITIAL_CHIPS로 되살아나서, 지고 있으면 나갔다 오면 그만인 게임이 된다.
  // (방이 완전히 비면 새 방이므로 함께 지운다 - resetEmptyRoom 참고)
  const chipBank = new Map(); // token -> chips
  // 판 도중에 자리를 떠난 사람(나가기·자리 정리)이 이 판에 이미 낸 돈. 판이 승자 없이
  // 무효로 끝나 모두에게 돌려줄 때(refundAndFinish) 떠난 사람 몫도 돌려주려고 기억한다.
  // 예전에는 방에 남은 사람만 돌려받고, 떠난 사람이 낸 돈은 팟과 함께 사라졌다.
  // 승자가 팟을 가져가면(settle) 포기한 돈이므로 잊는다.
  const departedStakes = new Map(); // token -> { paid: 이번 판에 내고 떠난 돈, nickname }
  const actionTimeoutMs = Number.isFinite(options.actionTimeoutMs) ? options.actionTimeoutMs : 30000;
  const proposalTimeoutMs = Number.isFinite(options.proposalTimeoutMs) ? options.proposalTimeoutMs : 30000;
  const disconnectGraceMs = Number.isFinite(options.disconnectGraceMs) ? options.disconnectGraceMs : 10000;

  const id = () => crypto.randomBytes(8).toString('hex');
  const token = () => crypto.randomBytes(18).toString('hex');
  const active = () => contenders.map((pid) => players.find((p) => p.id === pid)).filter((p) => p && !p.isFolded);
  const current = () => active()[turn % Math.max(active().length, 1)];
  const note = (text) => { history.push({ text, timestamp: Date.now() }); if (history.length > 40) history.shift(); };
  // 타이머 콜백에서 난 예외는 붙잡아 줄 호출자가 없어 프로세스까지 올라간다. Render는
  // 전역 핸들러가 받아 주지만 Vercel 인스턴스는 그대로 죽어 붙어 있던 사람이 전부 튕긴다.
  // 라이어 방은 서버가 감싼 타이머를 주입받는데, 카드 방은 스스로 감싼다.
  const safeTimeout = (fn, ms) => setTimeout(() => {
    try { fn(); } catch (err) { logError(`[포커 진행 처리 실패] ${err && err.stack ? err.stack : err}`); }
  }, ms);
  const nameOf = (pid) => (players.find((p) => p.id === pid) || {}).nickname || '(나간 참가자)';
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
  function scheduleDrop(pid) {
    cancelDrop(pid);
    const timer = safeTimeout(() => {
      dropTimers.delete(pid);
      const p = players.find((x) => x.id === pid && !x.connected);
      if (!p) return;
      const inHand = phase === 'betting' && contenders.includes(pid) && !p.isFolded;
      // 올인하고 결과를 기다리는 사람은 판이 끝날 때까지 자리를 남긴다. 여기서 빼면
      // 판에서도 빠져서, 이미 건 칩을 겨뤄 보지도 못하고 잃는다(disconnect 참고).
      if (inHand && p.isAllIn) { scheduleDrop(pid); return; }
      // 유예가 다 지나도록 돌아오지 않았다. 이제야 폴드한다(disconnect 참고).
      if (inHand) {
        const previousTurnId = current() && current().id;
        p.isFolded = true;
        note(`${p.nickname}님이 돌아오지 않아 폴드 처리되었습니다.`);
        act(p.nickname, '폴드 (연결이 끊긴 채 돌아오지 않음)');
        continueAfterDeparture(previousTurnId, pid);
      }
      act(p.nickname, `자리 정리 (돌아오지 않음, 칩 ${money(p.chips)} 보관)`);
      rememberStake(p);
      chipBank.set(p.token, p.chips);
      players.splice(players.indexOf(p), 1);
      contenders = contenders.filter((id) => id !== pid);
      changed();
    }, Math.max(0, disconnectGraceMs));
    if (timer.unref) timer.unref();
    dropTimers.set(pid, timer);
  }
  /** 판 도중에 떠나는 사람이 이미 낸 돈을 기억한다(departedStakes 참고). */
  function rememberStake(p) {
    const paid = p.roundContribution || 0;
    if (phase !== 'betting' || paid <= 0) return;
    const before = departedStakes.get(p.token);
    departedStakes.set(p.token, { paid: (before ? before.paid : 0) + paid, nickname: p.nickname });
  }
  /** 무효가 된 판: 떠난 사람이 낸 돈을 보관 칩(돌아와 있으면 그 자리)으로 돌려준다. */
  function returnDepartedStakes() {
    for (const [owner, { paid, nickname }] of departedStakes) {
      const back = players.find((x) => x.token === owner);
      if (back) back.chips += paid; else chipBank.set(owner, (chipBank.get(owner) || 0) + paid);
      act(back ? back.nickname : nickname, `환불 - 판 도중에 떠나며 두고 간 ${money(paid)} 돌려받음${back ? '' : ' (보관 칩에 더함)'}`);
    }
    departedStakes.clear();
  }
  function rebaseBettingTurn(previousTurnId, departedId) {
    const list = active();
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
    return active().every((x) => acted.has(x.id) && (x.roundBet === currentBet || x.isAllIn));
  }
  /**
   * 차례가 올인한 사람에게 가면 건너뛴다. 올인한 사람은 더 낼 것도 정할 것도 없어서,
   * 차례를 받으면 제한시간에 걸려 자동 폴드되고 이미 낸 칩을 전부 잃는다.
   */
  function skipAllInTurn() {
    const list = active();
    for (let step = 0; step < list.length; step += 1) {
      const index = (turn + step) % list.length;
      if (!list[index].isAllIn) { turn = index; return; }
    }
  }
  /**
   * 배팅 중에 누가 빠진 뒤(나가기·끊김) 판을 이어 간다.
   *
   * 예전에는 차례만 옆 사람에게 넘겼다. 그래서 A 올인 → B 콜 → C가 자기 차례에
   * 나가면, 배팅은 이미 끝났는데도 차례가 올인한 A에게 돌아가 A가 자동 폴드되고
   * B가 쇼다운 없이 팟을 가져갔다. call()·fold()와 같은 종료 판정을 여기서도 한다.
   */
  function continueAfterDeparture(previousTurnId, departedId) {
    const left = active();
    if (left.length === 1) { settle(left[0], false); return; }
    if (left.length === 0) return;
    if (bettingDone()) { showdown(); return; }
    rebaseBettingTurn(previousTurnId, departedId);
    skipAllInTurn();
    armActionTimer();
  }
  function uniqueNickname(value, excludeId) {
    const used = new Set(players.filter((p) => p.id !== excludeId).map((p) => p.nickname));
    if (!used.has(value)) return value;
    for (let number = 2; number < 1000; number += 1) {
      const suffix = `(${number})`; const candidate = value.slice(0, 24 - suffix.length) + suffix;
      if (!used.has(candidate)) return candidate;
    }
    return value.slice(0, 20) + '-' + id().slice(0, 3);
  }
  function armActionTimer() {
    clearActionTimer();
    if (phase !== 'betting' || actionTimeoutMs <= 0) return;
    const player = current();
    if (!player) return;
    actionClock.start(() => fold(player.id, true), actionTimeoutMs);
  }

  function resetEmptyRoom() {
    if (players.some((p) => p.connected)) return false;
    clearActionTimer(); clearProposalTimer(); pause.reset();
    for (const timer of dropTimers.values()) clearTimeout(timer);
    dropTimers.clear();
    chipBank.clear(); departedStakes.clear(); // 아무도 없는 방은 새 방이다. 칩도 처음부터 다시 시작한다.
    players.length = 0; history.length = 0; phase = 'lobby'; hostId = null; baseBet = 100;
    pot = 0; deck = []; contenders = []; dealtIn = []; turn = 0; currentBet = 0; minRaise = 100; allInCap = null;
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

  function draw(ids) {
    if (deck.length < ids.length) return false;
    for (const pid of ids) {
      const p = players.find((x) => x.id === pid);
      p.currentCard = deck.pop();
    }
    return true;
  }

  function join({ nickname, token: oldToken }) {
    const clean = Array.from(String(nickname || '').trim()).slice(0, 24).join(''); // 글자 단위로 자른다(이모지가 반으로 쪼개지지 않게)
    if (!clean) return { error: '닉네임을 입력해 주세요.' };
    // Render 재배포·모바일 네트워크 전환에서는 새 소켓이 먼저 열리고 이전 소켓의
    // close가 늦게 도착할 수 있다. 토큰이 같으면 연결 상태와 관계없이 같은 자리다.
    const restored = players.find((p) => p.token === oldToken);
    if (restored) {
      cancelDrop(restored.id);
      // 새로 열린 화면이 가려져 있는지는 그 화면이 다시 알려 준다. 이전 화면의 상태는 버린다.
      pause.forget(restored.id);
      restored.connected = true;
      restored.nickname = uniqueNickname(clean, restored.id);
      act(restored.nickname, '재접속');
      changed();
      return { playerId: restored.id, token: restored.token, restored: true };
    }
    if (players.length >= MAX_PLAYERS) return { error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` };
    const waiting = phase === 'betting' || phase === 'showdown';
    // 같은 토큰으로 돌아왔다면 나갈 때 들고 있던 칩을 그대로 돌려준다.
    const kept = chipBank.get(oldToken);
    if (oldToken) chipBank.delete(oldToken);
    // 보관 칩을 되찾은 사람은 토큰도 그대로 쓴다. 떠날 때 기억해 둔 판돈(departedStakes)을
    // 무효 판에서 돌려받으려면 같은 사람임을 알아봐야 한다.
    const p = { id: id(), token: kept === undefined ? token() : oldToken, nickname: uniqueNickname(clean), chips: kept === undefined ? INITIAL_CHIPS : kept, connected: true, ready: false, currentCard: null, isAllIn: false, isFolded: waiting, roundBet: 0, roundContribution: 0 };
    players.push(p);
    if (!hostId) hostId = p.id;
    act(p.nickname, `입장 (칩 ${money(p.chips)}${kept === undefined ? '' : ', 보관해 둔 칩 복구'}${waiting ? ', 다음 판부터' : ''})`);
    changed();
    return { playerId: p.id, token: p.token, restored: false };
  }

  function disconnect(pid) {
    const p = players.find((x) => x.id === pid);
    if (!p) return;
    p.connected = false;
    pause.forget(pid);
    act(p.nickname, '연결 끊김');
    if (baseBetProposal) { clearProposalTimer(); baseBetProposal = null; note('참가 인원이 바뀌어 기본 배팅금 투표가 취소되었습니다.'); act('투표', '기본 배팅금 투표 취소 (인원 변경)'); }
    // [규칙] 끊겼다고 곧바로 폴드하지 않는다. 자리를 남겨 두는 유예(disconnectGraceMs)
    // 동안 돌아오면 그대로 이어서 하고, 그래도 안 돌아오면 그때 폴드한다(scheduleDrop).
    //
    // 예전에는 끊기는 순간 폴드했다. 그래서 50만 원을 콜해 둔 사람이 자기 차례도 아닌데
    // 새로고침 한 번, 폰 화면 잠금, 와이파이→LTE 전환만으로 건 돈을 전부 잃었다.
    // 앤티가 생긴 뒤로는 판에 들어간 사람 모두가 돈을 걸고 있어 더 자주 일어났다.
    // 끊긴 사람의 차례가 오면 다른 사람은 유예만큼만 기다린다.
    // 올인한 사람은 판이 끝날 때까지 자리를 남긴다(더 정할 것이 없어 기다리게 하지 않는다).
    // 스스로 나가기를 누른 것(leave)은 포기라서 그쪽은 곧바로 폴드한다.
    if (phase === 'betting' && contenders.includes(pid) && !p.isFolded && !p.isAllIn) {
      note(`${p.nickname}님의 연결이 끊겼습니다. ${Math.max(1, Math.round(disconnectGraceMs / 1000))}초 안에 돌아오지 않으면 폴드됩니다.`);
    }
    if (hostId === pid) hostId = (players.find((x) => x.connected) || {}).id || null;
    if (!resetEmptyRoom()) scheduleDrop(pid);
    changed();
  }

  function leave(pid) {
    const index = players.findIndex((p) => p.id === pid);
    if (index < 0) return;
    cancelDrop(pid);
    pause.forget(pid);
    act(players[index].nickname, `나감 (칩 ${money(players[index].chips)} 보관)`);
    if (baseBetProposal) { clearProposalTimer(); baseBetProposal = null; note('참가 인원이 바뀌어 기본 배팅금 투표가 취소되었습니다.'); act('투표', '기본 배팅금 투표 취소 (인원 변경)'); }
    const previousTurnId = phase === 'betting' && current() ? current().id : null;
    if (phase === 'betting' && contenders.includes(pid) && !players[index].isFolded) {
      players[index].isFolded = true;
      note(`${players[index].nickname}님이 방을 나가 폴드 처리되었습니다.`);
      act(players[index].nickname, '폴드 (방을 나감)');
    }
    rememberStake(players[index]);
    chipBank.set(players[index].token, players[index].chips);
    players.splice(index, 1);
    if (hostId === pid) hostId = (players.find((p) => p.connected) || {}).id || null;
    if (phase === 'betting') continueAfterDeparture(previousTurnId, pid);
    resetEmptyRoom();
    changed();
  }

  /** [보스 키] 이 사람의 화면이 가려졌는지/돌아왔는지. 화면이 알려 준다(public/cover.js). */
  function setCovered(pid, covered) {
    if (!players.some((p) => p.id === pid)) return;
    pause.set(pid, covered === true);
    changed();
  }

  function setReady(pid, ready) {
    if (phase !== 'lobby' && phase !== 'result') return '대기 중에만 준비 상태를 바꿀 수 있습니다.';
    const p = players.find((x) => x.id === pid);
    if (!p) return '참가자를 찾을 수 없습니다.';
    p.ready = !!ready;
    changed();
    return null;
  }

  function setBaseBet(pid, amount) {
    if (phase !== 'lobby' && phase !== 'result') return '게임 중에는 변경할 수 없습니다.';
    if (!players.some((p) => p.id === pid && p.connected)) return '참가자를 찾을 수 없습니다.';
    if (baseBetProposal) return '이미 기본 배팅금 투표가 진행 중입니다.';
    const value = Number(amount);
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0 || value > INITIAL_CHIPS) return '기본 배팅금은 100원 단위로 설정해 주세요.';
    const proposer = players.find((p) => p.id === pid);
    if (players.filter((p) => p.connected).length === 1) {
      baseBet = value;
      note(`기본 배팅금이 ${value.toLocaleString()}원으로 변경되었습니다.`);
      act(proposer.nickname, `기본 배팅금 ${money(value)}으로 변경 (혼자라 바로 적용)`);
      changed();
      return null;
    }
    baseBetProposal = { id: id(), proposerId: pid, proposerName: proposer.nickname, amount: value, votes: new Map() };
    note(`${proposer.nickname}님이 기본 배팅금 ${value.toLocaleString()}원을 제안했습니다.`);
    act(proposer.nickname, `기본 배팅금 ${money(value)} 제안`);
    proposalTimer = safeTimeout(() => {
      if (!baseBetProposal) return;
      note('기본 배팅금 투표 시간이 끝나 변경이 취소되었습니다.'); act('투표', '기본 배팅금 투표 시간 초과로 취소'); baseBetProposal = null; proposalTimer = null; changed();
    }, proposalTimeoutMs);
    if (proposalTimer.unref) proposalTimer.unref();
    changed();
    return null;
  }

  function voteBaseBet(pid, proposalId, agree) {
    if (phase !== 'lobby' && phase !== 'result') return '게임 중에는 투표할 수 없습니다.';
    if (!baseBetProposal || baseBetProposal.id !== proposalId) return '종료된 투표입니다.';
    if (!players.some((p) => p.id === pid && p.connected)) return '참가자를 찾을 수 없습니다.';
    if (pid === baseBetProposal.proposerId) return '제안자는 투표 대상이 아닙니다.';
    if (baseBetProposal.votes.has(pid)) return '이미 투표했습니다.';
    baseBetProposal.votes.set(pid, !!agree);
    act(players.find((p) => p.id === pid).nickname, `기본 배팅금 ${money(baseBetProposal.amount)} ${agree ? '찬성' : '반대'}`);
    const voters = players.filter((p) => p.connected && p.id !== baseBetProposal.proposerId);
    const required = Math.ceil(voters.length / 2);
    const agreed = [...baseBetProposal.votes.values()].filter(Boolean).length;
    const remaining = voters.length - baseBetProposal.votes.size;
    if (agreed >= required) {
      baseBet = baseBetProposal.amount;
      note(`찬성 ${agreed}명으로 기본 배팅금이 ${baseBet.toLocaleString()}원으로 변경되었습니다.`);
      act('투표', `기본 배팅금 ${money(baseBet)}으로 변경 (찬성 ${agreed}명)`);
      clearProposalTimer();
      baseBetProposal = null;
    } else if (agreed + remaining < required || remaining === 0) {
      note(`찬성 ${agreed}명으로 기본 배팅금 변경이 거절되었습니다. 다시 설정해 주세요.`);
      act('투표', `기본 배팅금 변경 부결 (찬성 ${agreed}명)`);
      clearProposalTimer();
      baseBetProposal = null;
    }
    changed();
    return null;
  }

  // 예전에는 방장만 시작할 수 있었다. 그런데 방장은 "처음 들어온 사람"으로 한 번 정해지면
  // 연결이 살아 있는 한 넘어가지 않는다. 그 사람이 폰을 잠그거나 자리를 비우면 서버는
  // 최대 75초(하트비트) 동안 그걸 모르고, 그동안 남은 사람들은 회색 시작 버튼만 보며
  // 다음 판을 영영 시작하지 못했다. 화면이 방장이 누군지 알려 주지도 않아 원인도 몰랐다.
  // 라이어 게임(web/room.js)은 원래부터 아무나 시작할 수 있었다 - 규칙을 그쪽에 맞춘다.
  function begin(pid) {
    if (!players.some((p) => p.id === pid && p.connected)) return '방에 참가한 뒤 시작할 수 있습니다.';
    if (phase !== 'lobby' && phase !== 'result') return '이미 게임이 진행 중입니다.';
    if (baseBetProposal) return '기본 배팅금 투표가 끝난 뒤 시작해 주세요.';
    const ready = players.filter((p) => p.connected && p.ready && p.chips > 0);
    if (ready.length < MIN_PLAYERS) return '준비한 참가자가 2명 이상이어야 합니다.';
    pot = 0; result = null; deck = freshDeck(); contenders = ready.map((p) => p.id); departedStakes.clear();
    dealtIn = contenders.slice(); // 이 판의 참가자 명단. 재대결이 와도 그대로 둔다.
    players.forEach((p) => { p.roundContribution = 0; });
    act(players.find((p) => p.id === pid).nickname, `게임 시작 (${ready.length}명: ${ready.map((p) => p.nickname).join(', ')})`);
    note('새 라운드가 시작되었습니다.');
    startBetting(contenders, false);
    changed();
    return null;
  }

  /**
   * [규칙] 앤티 - 판을 시작할 때 참가자 전원이 기본 배팅금을 먼저 팟에 낸다.
   *
   * 예전에는 아무도 미리 내지 않았다. 기본 배팅금은 "계속하려면 최소 이만큼"이라는
   * 콜 기준일 뿐이라, 첫 차례에 폴드하면 0원을 잃었고 폴드로 이긴 사람은 자기가 낸
   * 돈만 돌려받았다. 기본 배팅금을 투표로 올려도 폴드가 나오면 아무 의미가 없었다.
   *
   * 칩이 기본 배팅금보다 적은 사람은 가진 만큼 내고 올인한다. 올인이 나오면 allin()과
   * 같은 규칙으로 그 금액이 이 판의 상한이 되고, 더 낸 사람은 넘치는 몫을 돌려받는다
   * (사이드 팟이 없으므로 아무도 맞출 수 없는 돈을 팟에 남기지 않는다).
   */
  function collectAnte(ids) {
    const list = ids.map((pid) => players.find((x) => x.id === pid)).filter(Boolean);
    for (const p of list) {
      pay(p, Math.min(baseBet, p.chips));
      if (p.chips === 0) { p.isAllIn = true; acted.add(p.id); }
    }
    const allIns = list.filter((p) => p.isAllIn);
    if (allIns.length) {
      allInCap = Math.min(...allIns.map((p) => p.roundBet));
      currentBet = allInCap;
      for (const x of list) {
        if (x.roundBet <= allInCap) continue;
        const refund = x.roundBet - allInCap;
        x.roundBet -= refund; x.roundContribution -= refund; x.chips += refund; pot -= refund;
      }
    }
    note(`앤티로 ${baseBet.toLocaleString()}원씩 걷었습니다. (팟 ${pot.toLocaleString()}원)`);
    act('진행', `앤티 ${money(baseBet)}씩 걷음 (팟 ${money(pot)})`);
    for (const p of allIns) {
      note(`${p.nickname}님은 칩이 모자라 ${p.roundBet.toLocaleString()}원을 내고 올인했습니다.`);
      act(p.nickname, `앤티 ${money(p.roundBet)} (칩이 모자라 올인)`);
    }
  }

  function startBetting(ids, tie) {
    // 새 판은 앤티가 곧 지금의 배팅액이다(collectAnte가 걷는다). 재대결은 팟이 이미 있어
    // 다시 걷지 않으므로 0원(체크)부터 시작한다.
    contenders = ids.slice(); turn = 0; currentBet = tie ? 0 : baseBet; minRaise = baseBet; allInCap = null; acted = new Set(); phase = 'betting';
    for (const p of players) {
      p.isFolded = !ids.includes(p.id);
      p.isAllIn = false;
      p.roundBet = 0;
      // 새 판을 시작할 때는 지난 판 카드가 남아 있으면 안 되므로 지운다. 그런데 동점
      // 재대결은 같은 판의 연장이다. 그때까지 지우면 이번 판에 폴드했던 사람의 카드가
      // 사라져, 라운드가 끝나고 전원 카드를 공개할 때 그 자리만 텅 비었다.
      // (폴드해도 결과에서는 카드가 공개되는 게 이 게임의 규칙이다 - stateFor 참고)
      if (!tie && !ids.includes(p.id)) p.currentCard = null;
    }
    if (!draw(ids)) { refundAndFinish('남은 카드가 부족해 배팅금을 돌려드립니다.'); return; }
    if (tie) {
      note(`동점자 ${ids.length}명이 재대결합니다. 팟은 유지됩니다.`);
      act('진행', `동점 재대결: ${ids.map((pid) => players.find((x) => x.id === pid).nickname).join(', ')} (팟 ${money(pot)} 유지)`);
    }
    // [규칙] 재대결에 더 걸 칩이 없는 사람이 있으면 배팅 없이 카드로만 가린다.
    //
    // 재대결은 새 배팅부터 시작하는데, 올인으로 칩이 0원이 된 사람은 콜·올인·레이즈가
    // 전부 거절되어 폴드밖에 할 수 없었다. 가만있어도 제한시간에 자동 폴드되어,
    // 둘 다 올인했다가 비기면 먼저 차례가 온 쪽이 팟을 통째로 잃었다.
    // 사이드 팟이 없으니 한 명이라도 더 걸 수 없으면 아무도 더 걸 수 없다(올인 상한과
    // 같은 이치). 그러면 배팅할 것이 없으므로 곧바로 새 카드를 비교한다.
    if (tie && ids.some((pid) => { const p = players.find((x) => x.id === pid); return !p || p.chips <= 0; })) {
      note('더 걸 칩이 없는 사람이 있어 배팅 없이 카드로만 가립니다.');
      act('진행', '더 걸 칩이 없는 사람이 있어 배팅 없이 카드로만 재대결');
      showdown();
      return;
    }
    if (!tie) collectAnte(ids);
    // 앤티로 올인한 사람은 차례를 받지 않는다. 전원이 앤티로 올인했다면 배팅할 것이 없다.
    skipAllInTurn();
    if (bettingDone()) { showdown(); return; }
    armActionTimer();
  }

  function pay(p, amount) {
    p.chips -= amount; p.roundBet += amount; p.roundContribution = (p.roundContribution || 0) + amount; pot += amount;
  }

  function advance() {
    const list = active();
    if (list.length <= 1) return settle(list[0], false);
    const cur = current();
    const idx = list.findIndex((p) => p.id === (cur && cur.id));
    // 올인한 사람은 더 낼 것도 정할 것도 없다. 차례를 넘길 때 건너뛴다. 건너뛰지 않으면
    // 그 사람 앞에서 제한시간이 흘러 자동 폴드되고, 이미 낸 칩을 그대로 잃는다.
    for (let step = 1; step <= list.length; step += 1) {
      const next = list[(idx + step) % list.length];
      if (!next.isAllIn) { turn = list.indexOf(next); return; }
    }
    turn = (idx + 1) % list.length; // 전원 올인 - 배팅 종료 판정이 처리한다
  }

  function call(pid) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    const p = current();
    const need = Math.max(0, currentBet - p.roundBet);
    if (p.chips < need) return '콜할 칩이 부족합니다. 올인을 선택하세요.';
    pay(p, need); acted.add(pid);
    // 앤티를 낸 뒤 더 낼 것이 없으면 콜이 아니라 체크다.
    note(need ? `${p.nickname}님이 ${need.toLocaleString()}원을 콜했습니다.` : `${p.nickname}님이 체크했습니다.`);
    act(p.nickname, need ? `콜 ${money(need)}` : '체크');
    if (bettingDone()) return showdown();
    advance(); armActionTimer(); changed(); return null;
  }

  function raise(pid, amount) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    if (allInCap !== null) return '올인 이후에는 레이즈할 수 없습니다.';
    const value = Number(amount);
    const p = current();
    const need = currentBet - p.roundBet + value;
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0) return '레이즈는 100원 단위로 입력해 주세요.';
    // [규칙] 레이즈 폭은 직전 레이즈 폭 이상이어야 한다. 이게 없으면 100원씩 올리는 것만
    // 반복해서 앞사람이 크게 올린 판을 사실상 없던 일로 만들 수 있고, 배팅이 끝나지 않는다.
    // 첫 레이즈의 기준은 기본 배팅금이다(startBetting에서 minRaise를 그렇게 잡는다).
    if (value < minRaise) return `레이즈는 직전 레이즈 금액인 ${minRaise.toLocaleString()}원 이상이어야 합니다.`;
    if (need >= p.chips) return '레이즈 후 칩이 남아야 합니다. 전액은 올인을 사용하세요.';
    pay(p, need); currentBet += value; minRaise = value; acted = new Set([pid]);
    advance();
    note(`${p.nickname}님이 ${value.toLocaleString()}원을 레이즈했습니다.`);
    act(p.nickname, `레이즈 ${money(value)} (판돈 ${money(currentBet)})`);
    armActionTimer(); changed(); return null;
  }

  /**
   * 올인. 상대가 먼저 올인했더라도, 그보다 적은 칩으로도 올인할 수 있다.
   *
   * 예전에는 이 판에 올인이 한 번이라도 있으면 두 번째 올인을 막았다. 그런데 콜은
   * "칩이 모자라면 올인하라"며 거절하고 올인은 "이미 올인이 있었다"며 거절해서,
   * 칩이 적은 사람에게 남는 선택지가 폴드뿐이었다. 올인으로 동점을 내 칩이 0이 되면
   * 그다음 판부터는 확정적으로 그 상태였다.
   *
   * 사이드 팟이 없으므로 규칙은 하나로 정리한다: 올인이 여럿이면 그중 가장 적은
   * 금액이 이 판의 상한이 되고, 그보다 많이 낸 사람에게는 넘치는 몫을 돌려준다.
   * 아무도 맞출 수 없는 돈이 팟에 남지 않으니 모두가 끝까지 겨룰 수 있다.
   * (폴드한 사람이 이미 낸 칩은 그대로 팟에 남는다 - 포기한 돈이다)
   *
   * 반대쪽도 같은 이유로 막는다: 내가 더 많이 가졌다면 상대가 받을 수 있는 만큼만
   * 걸린다. 아래 본문 주석 참고.
   */
  function allin(pid) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    const p = current();
    if (p.chips <= 0) return '올인할 칩이 없습니다.';
    // [규칙] 상대가 받을 수 없는 몫은 애초에 걸지 않는다.
    //
    // 사이드 팟이 없으므로 아무도 맞출 수 없는 돈은 팟에 올라가 봐야 아래 환불로
    // 그대로 되돌아온다. 되돌려 주느니 처음부터 안 거는 편이 낫다 - 200만원을 걸었다가
    // 3천원으로 조용히 내려앉는 대신, 화면에 찍히는 숫자가 곧 진짜 판돈이 된다.
    //
    // 이 판에서 실제로 겨룰 수 있는 최대는 "나 말고 가장 많이 가진 사람"이 낼 수 있는
    // 전부다. 그보다 적게 가진 사람은 어차피 자기 몫으로 올인해 상한을 더 끌어내린다.
    const rivals = active().filter((x) => x.id !== pid);
    const reachable = rivals.length
      ? Math.max(...rivals.map((x) => x.roundBet + x.chips)) : Infinity;
    // 이미 낸 것보다 적게 되돌릴 수는 없다(레이즈로 앞서 더 냈을 수 있다).
    const cap = Math.max(p.roundBet, Math.min(p.roundBet + p.chips, reachable));
    pay(p, cap - p.roundBet);
    allInCap = allInCap === null ? cap : Math.min(allInCap, cap);
    currentBet = allInCap;
    for (const x of active()) {
      if (x.roundBet <= allInCap) continue;
      const refund = x.roundBet - allInCap;
      x.roundBet -= refund; x.roundContribution -= refund; x.chips += refund; pot -= refund;
    }
    // 환불까지 끝난 뒤에야 "정말 다 걸었는지"가 정해진다. 상한에 막혀 칩이 남았다면
    // 올인이 아니다 - 남은 칩을 들고 있는 사람을 올인으로 표시하면 화면이 거짓말을 한다.
    p.isAllIn = p.chips === 0;
    acted.add(pid);
    note(p.isAllIn
      ? `${p.nickname}님이 ${allInCap.toLocaleString()}원에 올인했습니다.`
      : `${p.nickname}님이 상대가 받을 수 있는 최대인 ${allInCap.toLocaleString()}원을 걸었습니다.`);
    act(p.nickname, p.isAllIn ? `올인 ${money(allInCap)}` : `상대가 받을 수 있는 최대 ${money(allInCap)} (칩 ${money(p.chips)} 남김)`);
    // 남은 사람이 모두 행동했고 금액도 맞췄다면 여기서 배팅이 끝난다. 이 판정이 없으면
    // 전원이 올인한 뒤에도 차례가 계속 돌아, 더 낼 것도 없는 사람이 제한시간에 걸린다.
    if (bettingDone()) return showdown();
    advance(); armActionTimer(); changed(); return null;
  }

  function fold(pid, timedOut) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    const p = current(); p.isFolded = true; acted.add(pid); note(timedOut ? `${p.nickname}님의 제한시간이 지나 자동 폴드되었습니다.` : `${p.nickname}님이 폴드했습니다.`);
    act(p.nickname, timedOut ? '폴드 (시간 초과)' : '폴드');
    const left = active();
    if (left.length === 1) return settle(left[0], false);
    // 남은 사람들이 이미 다 행동했고 금액도 맞췄다면 이 배팅은 끝난 것이다. 예전에는
    // 이 판정이 call()에만 있어서, 마지막 차례인 사람이 폴드하면 차례가 처음으로 돌아가
    // 이미 콜을 맞춘 사람이 또 내야 하는 상황이 됐다.
    if (bettingDone()) return showdown();
    turn %= left.length; skipAllInTurn(); armActionTimer(); changed(); return null;
  }

  function showdown() {
    phase = 'showdown';
    const list = active();
    act('진행', `쇼다운: ${list.map((p) => `${p.nickname} ${cardName(p.currentCard)}`).join(' · ')}`);
    const max = Math.max(...list.map((p) => p.currentCard.rank));
    const winners = list.filter((p) => p.currentCard.rank === max);
    if (winners.length > 1) {
      startBetting(winners.map((p) => p.id), true);
      changed(); return null;
    }
    return settle(winners[0], true);
  }

  function settle(winner, revealed) {
    if (!winner) return null;
    clearActionTimer();
    const won = pot; winner.chips += pot; pot = 0; phase = 'result'; departedStakes.clear();
    result = { winnerId: winner.id, nickname: winner.nickname, amount: won, revealed };
    note(`${winner.nickname}님이 팟 ${won.toLocaleString()}원을 획득했습니다.`);
    act(winner.nickname, `팟 ${won.toLocaleString()}원 획득${revealed ? '' : ' (나머지가 폴드)'} → 칩 ${winner.chips.toLocaleString()}원`);
    for (const p of players) { p.ready = false; p.isAllIn = false; p.roundBet = 0; p.roundContribution = 0; }
    changed(); return null;
  }

  function refundAndFinish(message) {
    clearActionTimer();
    for (const player of players) { player.chips += player.roundContribution || 0; player.roundContribution = 0; player.roundBet = 0; player.ready = false; player.isAllIn = false; }
    returnDepartedStakes();
    pot = 0; phase = 'result'; result = { noWinner: true, message }; note(message); act('진행', `환불 - ${message}`); changed(); return null;
  }

  function donate(fromId, toId, amount) {
    if (phase !== 'lobby' && phase !== 'result') return '기부는 대기 중에만 할 수 있습니다.';
    const from = players.find((p) => p.id === fromId); const to = players.find((p) => p.id === toId);
    const value = Number(amount);
    if (!from || !to || from === to) return '기부 대상을 확인해 주세요.';
    if (to.chips >= baseBet) return '현재 칩이 부족한 참가자에게만 기부할 수 있습니다.';
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0 || from.chips < value) return '기부 금액과 보유 칩을 확인해 주세요.';
    from.chips -= value; to.chips += value; note(`${from.nickname}님이 ${to.nickname}님에게 ${value.toLocaleString()}원을 기부했습니다.`);
    act(from.nickname, `기부 → ${to.nickname} ${money(value)}`);
    changed(); return null;
  }

  function stateFor(pid) {
    const me = players.find((p) => p.id === pid);
    // 폴드해도 이번 라운드 참가자였다면 계속 테이블을 볼 수 있어야 한다. 배팅을
    // 그만뒀다고 구경까지 막을 이유는 없다.
    const viewerInRound = !!me && dealtIn.includes(pid);
    return {
      type: 'pokerState', phase, baseBet, pot, currentBet, minRaise, allInCap, hostId, turnPlayerId: current() && current().id,
      // 차례인 사람이 화면을 가려 제한시간이 멈춰 있는가(web/cover-pause.js)
      paused: pause.pausedAt() !== null,
      result, history: history.slice(-12), you: me ? { id: me.id, chips: me.chips, ready: me.ready, inRound: dealtIn.includes(me.id) } : null,
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
      // 끊긴 사람은 목록에서 뺀다. 다만 끊긴 채로 판을 계속 겨루는 사람(올인하고
      // 기다리는 사람)은 남긴다 - 빼면 그 사람이 이겨도 테이블에 카드가 안 보이고,
      // "○○님이 획득했습니다"만 떠서 누가 어떻게 이겼는지 알 수 없다.
      players: players.filter((p) => p.connected || (phase !== 'lobby' && contenders.includes(p.id) && !p.isFolded)).map((p) => {
        // "이번 판에 카드를 받았는가". 화면은 이걸로 중도 입장자("다음 판 대기")와
        // 이 판에 뛰다 폴드한 사람("폴드")을 가른다.
        const inRound = dealtIn.includes(p.id);
        let reveal = false;
        if (phase === 'betting') reveal = viewerInRound && p.id !== pid && !p.isFolded;
        // 라운드가 끝나면 폴드했던 사람의 카드도 공개한다 - 더 숨길 이유가 없다.
        else if (phase === 'result') reveal = !!(result && result.revealed);
        return { id: p.id, nickname: p.nickname, chips: p.chips, ready: p.ready, connected: p.connected, inRound, isFolded: p.isFolded, isAllIn: p.isAllIn, roundBet: p.roundBet, card: p.currentCard ? (reveal ? p.currentCard : { hidden: true }) : null };
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

module.exports = { createPokerRoom, INITIAL_CHIPS };
