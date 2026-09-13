'use strict';

const crypto = require('crypto');

const INITIAL_CHIPS = 86000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;

function createPokerRoom(options) {
  const changed = options.onChange || (() => {});
  const players = [];
  const history = [];
  let phase = 'lobby';
  let hostId = null;
  let baseBet = 100;
  let pot = 0;
  let deck = [];
  let contenders = [];
  let turn = 0;
  let currentBet = 0;
  let allInCap = null;
  let acted = new Set();
  let result = null;
  let baseBetProposal = null;
  let actionTimer = null;
  let proposalTimer = null;
  const actionTimeoutMs = Number.isFinite(options.actionTimeoutMs) ? options.actionTimeoutMs : 30000;
  const proposalTimeoutMs = Number.isFinite(options.proposalTimeoutMs) ? options.proposalTimeoutMs : 30000;

  const id = () => crypto.randomBytes(8).toString('hex');
  const token = () => crypto.randomBytes(18).toString('hex');
  const active = () => contenders.map((pid) => players.find((p) => p.id === pid)).filter((p) => p && !p.isFolded);
  const current = () => active()[turn % Math.max(active().length, 1)];
  const note = (text) => { history.push({ text, timestamp: Date.now() }); if (history.length > 40) history.shift(); };
  const clearActionTimer = () => { if (actionTimer) clearTimeout(actionTimer); actionTimer = null; };
  const clearProposalTimer = () => { if (proposalTimer) clearTimeout(proposalTimer); proposalTimer = null; };
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
    actionTimer = setTimeout(() => fold(player.id, true), actionTimeoutMs);
    if (actionTimer.unref) actionTimer.unref();
  }

  function resetEmptyRoom() {
    if (players.some((p) => p.connected)) return false;
    clearActionTimer(); clearProposalTimer();
    players.length = 0; history.length = 0; phase = 'lobby'; hostId = null; baseBet = 100;
    pot = 0; deck = []; contenders = []; turn = 0; currentBet = 0; allInCap = null;
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
    const clean = String(nickname || '').trim().slice(0, 24);
    if (!clean) return { error: '닉네임을 입력해 주세요.' };
    const restored = players.find((p) => p.token === oldToken && !p.connected);
    if (restored) {
      restored.connected = true;
      restored.nickname = uniqueNickname(clean, restored.id);
      changed();
      return { playerId: restored.id, token: restored.token, restored: true };
    }
    if (players.filter((p) => p.connected).length >= MAX_PLAYERS) return { error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` };
    const p = { id: id(), token: token(), nickname: uniqueNickname(clean), chips: INITIAL_CHIPS, connected: true, ready: false, currentCard: null, isAllIn: false, isFolded: false, roundBet: 0, roundContribution: 0 };
    players.push(p);
    if (!hostId) hostId = p.id;
    changed();
    return { playerId: p.id, token: p.token, restored: false };
  }

  function disconnect(pid) {
    const p = players.find((x) => x.id === pid);
    if (!p) return;
    p.connected = false;
    if (baseBetProposal) { clearProposalTimer(); baseBetProposal = null; note('참가 인원이 바뀌어 기본 배팅금 투표가 취소되었습니다.'); }
    if (phase === 'betting' && contenders.includes(pid) && !p.isFolded) {
      const previousTurnId = current() && current().id;
      p.isFolded = true;
      note(`${p.nickname}님의 연결이 끊겨 폴드 처리되었습니다.`);
      const left = active();
      if (left.length === 1) settle(left[0], false);
      else {
        rebaseBettingTurn(previousTurnId, pid);
        armActionTimer();
      }
    }
    if (hostId === pid) hostId = (players.find((x) => x.connected) || {}).id || null;
    resetEmptyRoom();
    changed();
  }

  function leave(pid) {
    const index = players.findIndex((p) => p.id === pid);
    if (index < 0) return;
    if (baseBetProposal) { clearProposalTimer(); baseBetProposal = null; note('참가 인원이 바뀌어 기본 배팅금 투표가 취소되었습니다.'); }
    const previousTurnId = phase === 'betting' && current() ? current().id : null;
    if (phase === 'betting' && contenders.includes(pid) && !players[index].isFolded) {
      players[index].isFolded = true;
      note(`${players[index].nickname}님이 방을 나가 폴드 처리되었습니다.`);
    }
    players.splice(index, 1);
    if (hostId === pid) hostId = (players.find((p) => p.connected) || {}).id || null;
    if (phase === 'betting') {
      const left = active();
      if (left.length === 1) settle(left[0], false);
      else if (left.length > 1) { rebaseBettingTurn(previousTurnId, pid); armActionTimer(); }
    }
    resetEmptyRoom();
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
      changed();
      return null;
    }
    baseBetProposal = { id: id(), proposerId: pid, proposerName: proposer.nickname, amount: value, votes: new Map() };
    note(`${proposer.nickname}님이 기본 배팅금 ${value.toLocaleString()}원을 제안했습니다.`);
    proposalTimer = setTimeout(() => {
      if (!baseBetProposal) return;
      note('기본 배팅금 투표 시간이 끝나 변경이 취소되었습니다.'); baseBetProposal = null; proposalTimer = null; changed();
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
    const voters = players.filter((p) => p.connected && p.id !== baseBetProposal.proposerId);
    const required = Math.ceil(voters.length / 2);
    const agreed = [...baseBetProposal.votes.values()].filter(Boolean).length;
    const remaining = voters.length - baseBetProposal.votes.size;
    if (agreed >= required) {
      baseBet = baseBetProposal.amount;
      note(`찬성 ${agreed}명으로 기본 배팅금이 ${baseBet.toLocaleString()}원으로 변경되었습니다.`);
      clearProposalTimer();
      baseBetProposal = null;
    } else if (agreed + remaining < required || remaining === 0) {
      note(`찬성 ${agreed}명으로 기본 배팅금 변경이 거절되었습니다. 다시 설정해 주세요.`);
      clearProposalTimer();
      baseBetProposal = null;
    }
    changed();
    return null;
  }

  function begin(pid) {
    if (pid !== hostId) return '방장만 시작할 수 있습니다.';
    if (phase !== 'lobby' && phase !== 'result') return '이미 게임이 진행 중입니다.';
    if (baseBetProposal) return '기본 배팅금 투표가 끝난 뒤 시작해 주세요.';
    const ready = players.filter((p) => p.connected && p.ready && p.chips > 0);
    if (ready.length < MIN_PLAYERS) return '준비한 참가자가 2명 이상이어야 합니다.';
    pot = 0; result = null; deck = freshDeck(); contenders = ready.map((p) => p.id);
    players.forEach((p) => { p.roundContribution = 0; });
    startBetting(contenders, false);
    note('새 라운드가 시작되었습니다.');
    changed();
    return null;
  }

  function startBetting(ids, tie) {
    contenders = ids.slice(); turn = 0; currentBet = baseBet; allInCap = null; acted = new Set(); phase = 'betting';
    for (const p of players) {
      p.isFolded = !ids.includes(p.id);
      p.isAllIn = false;
      p.roundBet = 0;
      if (!ids.includes(p.id)) p.currentCard = null;
    }
    if (!draw(ids)) { refundAndFinish('남은 카드가 부족해 배팅금을 돌려드립니다.'); return; }
    if (tie) note(`동점자 ${ids.length}명이 재대결합니다. 팟은 유지됩니다.`);
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
    turn = (idx + 1) % list.length;
  }

  function call(pid) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    const p = current();
    const need = Math.max(0, currentBet - p.roundBet);
    if (p.chips < need) return '콜할 칩이 부족합니다. 올인을 선택하세요.';
    pay(p, need); acted.add(pid); note(`${p.nickname}님이 ${need.toLocaleString()}원을 콜했습니다.`);
    if (active().every((x) => acted.has(x.id) && (x.roundBet === currentBet || x.isAllIn))) return showdown();
    advance(); armActionTimer(); changed(); return null;
  }

  function raise(pid, amount) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    if (allInCap !== null) return '올인 이후에는 레이즈할 수 없습니다.';
    const value = Number(amount);
    const p = current();
    const need = currentBet - p.roundBet + value;
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0) return '레이즈는 100원 단위로 입력해 주세요.';
    if (need >= p.chips) return '레이즈 후 칩이 남아야 합니다. 전액은 올인을 사용하세요.';
    pay(p, need); currentBet += value; acted = new Set([pid]);
    advance();
    note(`${p.nickname}님이 ${value.toLocaleString()}원을 레이즈했습니다.`); armActionTimer(); changed(); return null;
  }

  function allin(pid) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    if (allInCap !== null) return '이 판에서는 이미 올인이 발생했습니다.';
    const p = current();
    if (p.chips <= 0) return '올인할 칩이 없습니다.';
    const cap = p.roundBet + p.chips;
    pay(p, p.chips); p.isAllIn = true; allInCap = cap; currentBet = cap;
    for (const x of active()) {
      if (x.roundBet > cap) { const refund = x.roundBet - cap; x.roundBet -= refund; x.chips += refund; pot -= refund; }
    }
    acted.add(pid); note(`${p.nickname}님이 ${cap.toLocaleString()}원에 올인했습니다.`);
    advance(); armActionTimer(); changed(); return null;
  }

  function fold(pid, timedOut) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    const p = current(); p.isFolded = true; acted.add(pid); note(timedOut ? `${p.nickname}님의 제한시간이 지나 자동 폴드되었습니다.` : `${p.nickname}님이 폴드했습니다.`);
    const left = active();
    if (left.length === 1) return settle(left[0], false);
    turn %= left.length; armActionTimer(); changed(); return null;
  }

  function showdown() {
    phase = 'showdown';
    const list = active();
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
    const won = pot; winner.chips += pot; pot = 0; phase = 'result';
    result = { winnerId: winner.id, nickname: winner.nickname, amount: won, revealed };
    note(`${winner.nickname}님이 팟 ${won.toLocaleString()}원을 획득했습니다.`);
    for (const p of players) { p.ready = false; p.isAllIn = false; }
    changed(); return null;
  }

  function refundAndFinish(message) {
    clearActionTimer();
    for (const player of players) { player.chips += player.roundContribution || 0; player.roundContribution = 0; player.roundBet = 0; player.ready = false; player.isAllIn = false; }
    pot = 0; phase = 'result'; result = { noWinner: true, message }; note(message); changed(); return null;
  }

  function donate(fromId, toId, amount) {
    if (phase !== 'lobby' && phase !== 'result') return '기부는 대기 중에만 할 수 있습니다.';
    const from = players.find((p) => p.id === fromId); const to = players.find((p) => p.id === toId);
    const value = Number(amount);
    if (!from || !to || from === to) return '기부 대상을 확인해 주세요.';
    if (to.chips >= baseBet) return '현재 칩이 부족한 참가자에게만 기부할 수 있습니다.';
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0 || from.chips < value) return '기부 금액과 보유 칩을 확인해 주세요.';
    from.chips -= value; to.chips += value; note(`${from.nickname}님이 ${to.nickname}님에게 ${value.toLocaleString()}원을 기부했습니다.`); changed(); return null;
  }

  function stateFor(pid) {
    const me = players.find((p) => p.id === pid);
    return {
      type: 'pokerState', phase, baseBet, pot, currentBet, allInCap, hostId, turnPlayerId: current() && current().id,
      result, history: history.slice(-12), you: me ? { id: me.id, chips: me.chips, ready: me.ready } : null,
      baseBetProposal: baseBetProposal ? {
        id: baseBetProposal.id, proposerName: baseBetProposal.proposerName, amount: baseBetProposal.amount,
        agreed: [...baseBetProposal.votes.values()].filter(Boolean).length,
        voted: baseBetProposal.votes.size,
        total: players.filter((p) => p.connected && p.id !== baseBetProposal.proposerId).length,
        yourVote: pid === baseBetProposal.proposerId || baseBetProposal.votes.has(pid),
      } : null,
      canStart: pid === hostId && (phase === 'lobby' || phase === 'result') && players.filter((p) => p.connected && p.ready && p.chips > 0).length >= MIN_PLAYERS,
      players: players.filter((p) => p.connected).map((p) => ({ id: p.id, nickname: p.nickname, chips: p.chips, ready: p.ready, isFolded: p.isFolded, isAllIn: p.isAllIn, roundBet: p.roundBet, card: p.currentCard ? ((phase === 'betting' && p.id === pid) || p.isFolded ? { hidden: true } : p.currentCard) : null })),
    };
  }

  return { join, disconnect, leave, setReady, setBaseBet, voteBaseBet, begin, call, raise, allin, fold, donate, stateFor, status: () => ({ phase, playerCount: players.filter((p) => p.connected).length }) };
}

module.exports = { createPokerRoom, INITIAL_CHIPS };
