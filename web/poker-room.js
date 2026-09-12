'use strict';

const crypto = require('crypto');

const INITIAL_CHIPS = 86000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

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
  let closeOnCallBy = null;
  let acted = new Set();
  let result = null;

  const id = () => crypto.randomBytes(8).toString('hex');
  const token = () => crypto.randomBytes(18).toString('hex');
  const active = () => contenders.map((pid) => players.find((p) => p.id === pid)).filter((p) => p && !p.isFolded);
  const current = () => active()[turn % Math.max(active().length, 1)];
  const note = (text) => { history.push({ text, timestamp: Date.now() }); if (history.length > 40) history.shift(); };

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
    for (const pid of ids) {
      const p = players.find((x) => x.id === pid);
      p.currentCard = deck.pop();
    }
  }

  function join({ nickname, token: oldToken }) {
    const clean = String(nickname || '').trim().slice(0, 24);
    if (!clean) return { error: '닉네임을 입력해 주세요.' };
    const restored = players.find((p) => p.token === oldToken && !p.connected);
    if (restored) {
      restored.connected = true;
      restored.nickname = clean;
      changed();
      return { playerId: restored.id, token: restored.token, restored: true };
    }
    if (players.filter((p) => p.connected).length >= MAX_PLAYERS) return { error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` };
    const p = { id: id(), token: token(), nickname: clean, chips: INITIAL_CHIPS, connected: true, ready: false, currentCard: null, isAllIn: false, isFolded: false, roundBet: 0 };
    players.push(p);
    if (!hostId) hostId = p.id;
    changed();
    return { playerId: p.id, token: p.token, restored: false };
  }

  function disconnect(pid) {
    const p = players.find((x) => x.id === pid);
    if (!p) return;
    p.connected = false;
    if (phase === 'betting' && contenders.includes(pid) && !p.isFolded) {
      const wasTurn = current() && current().id === pid;
      p.isFolded = true;
      note(`${p.nickname}님의 연결이 끊겨 폴드 처리되었습니다.`);
      const left = active();
      if (left.length === 1) settle(left[0], false);
      else if (wasTurn) turn %= left.length;
    }
    if (hostId === pid) hostId = (players.find((x) => x.connected) || {}).id || null;
    changed();
  }

  function leave(pid) {
    const index = players.findIndex((p) => p.id === pid);
    if (index < 0) return;
    if (phase === 'betting' && contenders.includes(pid) && !players[index].isFolded) fold(pid);
    players.splice(index, 1);
    if (hostId === pid) hostId = (players.find((p) => p.connected) || {}).id || null;
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
    if (pid !== hostId) return '방장만 기본 배팅금을 설정할 수 있습니다.';
    if (phase !== 'lobby' && phase !== 'result') return '게임 중에는 변경할 수 없습니다.';
    const value = Number(amount);
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0 || value > INITIAL_CHIPS) return '기본 배팅금은 100원 단위로 설정해 주세요.';
    baseBet = value;
    changed();
    return null;
  }

  function begin(pid) {
    if (pid !== hostId) return '방장만 시작할 수 있습니다.';
    if (phase !== 'lobby' && phase !== 'result') return '이미 게임이 진행 중입니다.';
    const ready = players.filter((p) => p.connected && p.ready && p.chips > 0);
    if (ready.length < MIN_PLAYERS) return '준비한 참가자가 2명 이상이어야 합니다.';
    pot = 0; result = null; deck = freshDeck(); contenders = ready.map((p) => p.id);
    startBetting(contenders, false);
    note('새 라운드가 시작되었습니다.');
    changed();
    return null;
  }

  function startBetting(ids, tie) {
    contenders = ids.slice(); turn = 0; currentBet = baseBet; allInCap = null; closeOnCallBy = null; acted = new Set(); phase = 'betting';
    for (const p of players) {
      p.isFolded = !ids.includes(p.id);
      p.isAllIn = false;
      p.roundBet = 0;
      if (!ids.includes(p.id)) p.currentCard = null;
    }
    draw(ids);
    if (tie) note(`동점자 ${ids.length}명이 재대결합니다. 팟은 유지됩니다.`);
  }

  function pay(p, amount) {
    p.chips -= amount; p.roundBet += amount; pot += amount;
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
    if (closeOnCallBy === pid || active().every((x) => acted.has(x.id) && (x.roundBet === currentBet || x.isAllIn))) return showdown();
    advance(); changed(); return null;
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
    advance(); closeOnCallBy = current() && current().id;
    note(`${p.nickname}님이 ${value.toLocaleString()}원을 레이즈했습니다.`); changed(); return null;
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
    advance(); changed(); return null;
  }

  function fold(pid) {
    if (phase !== 'betting' || !current() || current().id !== pid) return '지금은 본인 차례가 아닙니다.';
    const p = current(); p.isFolded = true; acted.add(pid); note(`${p.nickname}님이 폴드했습니다.`);
    const left = active();
    if (left.length === 1) return settle(left[0], false);
    turn %= left.length; changed(); return null;
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
    const won = pot; winner.chips += pot; pot = 0; phase = 'result';
    result = { winnerId: winner.id, nickname: winner.nickname, amount: won, revealed };
    note(`${winner.nickname}님이 팟 ${won.toLocaleString()}원을 획득했습니다.`);
    for (const p of players) { p.ready = false; p.isAllIn = false; }
    changed(); return null;
  }

  function donate(fromId, toId, amount) {
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
      canStart: pid === hostId && (phase === 'lobby' || phase === 'result') && players.filter((p) => p.connected && p.ready && p.chips > 0).length >= MIN_PLAYERS,
      players: players.filter((p) => p.connected).map((p) => ({ id: p.id, nickname: p.nickname, chips: p.chips, ready: p.ready, isFolded: p.isFolded, isAllIn: p.isAllIn, roundBet: p.roundBet, card: p.currentCard ? ((phase === 'betting' && p.id === pid) || p.isFolded ? { hidden: true } : p.currentCard) : null })),
    };
  }

  return { join, disconnect, leave, setReady, setBaseBet, begin, call, raise, allin, fold, donate, stateFor, status: () => ({ phase, playerCount: players.filter((p) => p.connected).length }) };
}

module.exports = { createPokerRoom, INITIAL_CHIPS };
