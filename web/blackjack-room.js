'use strict';

const crypto = require('crypto');

const INITIAL_CHIPS = 86000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;

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
  let allInCap = null;
  let closeOnCallBy = null;
  let acted = new Set();
  let result = null;

  const makeId = () => crypto.randomBytes(8).toString('hex');
  const makeToken = () => crypto.randomBytes(18).toString('hex');
  const note = (text) => { history.push({ text, timestamp: Date.now() }); if (history.length > 40) history.shift(); };
  const score = (hand) => hand.reduce((sum, card) => sum + (card.rank > 10 ? 10 : card.rank), 0);
  const inRound = () => contenders.map((id) => players.find((p) => p.id === id)).filter(Boolean);
  const bettingPlayers = () => inRound().filter((p) => !p.isFolded && !p.isBusted);
  const currentBetPlayer = () => bettingPlayers()[turn % Math.max(bettingPlayers().length, 1)];

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
    if (card) player.hand.push(card);
    player.score = score(player.hand);
    if (player.score > 21) player.isBusted = true;
  }

  function resetIfEmpty() {
    if (players.some((p) => p.connected)) return;
    players.length = 0; history.length = 0; phase = 'lobby'; hostId = null; baseBet = 100;
    baseBetProposal = null; pot = 0; deck = []; contenders = []; turn = 0; currentBet = 0;
    allInCap = null; closeOnCallBy = null; acted = new Set(); result = null;
  }

  function join({ nickname, token: oldToken }) {
    const clean = String(nickname || '').trim().slice(0, 24);
    if (!clean) return { error: '닉네임을 입력해 주세요.' };
    const restored = players.find((p) => p.token === oldToken && !p.connected);
    if (restored) {
      restored.connected = true; restored.nickname = clean; changed();
      return { playerId: restored.id, token: restored.token, restored: true };
    }
    if (players.filter((p) => p.connected).length >= MAX_PLAYERS) return { error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` };
    const player = { id: makeId(), token: makeToken(), nickname: clean, chips: INITIAL_CHIPS, connected: true, ready: false, hand: [], score: 0, isBusted: false, isStanding: false, isFolded: false, isAllIn: false, roundBet: 0 };
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
    player.connected = false;
    if (baseBetProposal) { baseBetProposal = null; note('참가 인원이 바뀌어 기본 배팅금 투표가 취소되었습니다.'); }
    if (phase === 'playing' || phase === 'betting') forceFold(player);
    if (hostId === playerId) hostId = (players.find((p) => p.connected) || {}).id || null;
    if (phase === 'playing') advancePlaying();
    else if (phase === 'betting' && bettingPlayers().length === 1) settle(bettingPlayers()[0]);
    resetIfEmpty(); changed();
  }

  function leave(playerId) {
    const player = players.find((p) => p.id === playerId);
    if (!player) return;
    player.connected = false; forceFold(player);
    players.splice(players.indexOf(player), 1);
    if (baseBetProposal) { baseBetProposal = null; note('참가 인원이 바뀌어 기본 배팅금 투표가 취소되었습니다.'); }
    if (hostId === playerId) hostId = (players.find((p) => p.connected) || {}).id || null;
    if (phase === 'playing') advancePlaying();
    else if (phase === 'betting' && bettingPlayers().length === 1) settle(bettingPlayers()[0]);
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
    note(`${player.nickname}님이 기본 배팅금 ${value.toLocaleString()}원을 제안했습니다.`); changed(); return null;
  }

  function voteBaseBet(playerId, proposalId, agree) {
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
      baseBet = baseBetProposal.amount; note(`찬성 ${agreed}명으로 기본 배팅금이 ${baseBet.toLocaleString()}원으로 변경되었습니다.`); baseBetProposal = null;
    } else if (agreed + remaining < required || remaining === 0) {
      note(`찬성 ${agreed}명으로 변경이 거절되었습니다. 다시 설정해 주세요.`); baseBetProposal = null;
    }
    changed(); return null;
  }

  function begin(playerId) {
    if (playerId !== hostId) return '방장만 시작할 수 있습니다.';
    if (phase !== 'lobby' && phase !== 'result') return '이미 게임이 진행 중입니다.';
    const ready = players.filter((p) => p.connected && p.ready && p.chips > 0);
    if (ready.length < MIN_PLAYERS) return '준비한 참가자가 2명 이상이어야 합니다.';
    phase = 'playing'; result = null; pot = 0; deck = freshDeck(); contenders = ready.map((p) => p.id); turn = 0;
    for (const player of players) {
      player.hand = []; player.score = 0; player.isBusted = false; player.isStanding = false;
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
      if (!player.isStanding && !player.isBusted && !player.isFolded) return player;
    }
    return null;
  }

  function advancePlaying(keepTurn) {
    if (phase !== 'playing') return;
    const round = inRound();
    if (!keepTurn) turn = (turn + 1) % Math.max(round.length, 1);
    const next = currentPlayingPlayer();
    if (next) { turn = round.findIndex((p) => p.id === next.id); return; }
    beginBetting();
  }

  function hit(playerId) {
    const player = currentPlayingPlayer();
    if (!player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    draw(player);
    note(`${player.nickname}님이 히트했습니다.${player.isBusted ? ' 21을 넘어 버스트했습니다.' : ''}`);
    if (player.isBusted) advancePlaying(false);
    changed(); return null;
  }

  function stand(playerId) {
    const player = currentPlayingPlayer();
    if (!player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    player.isStanding = true; note(`${player.nickname}님이 스탠드했습니다.`); advancePlaying(false); changed(); return null;
  }

  function beginBetting() {
    const survivors = inRound().filter((p) => !p.isBusted && !p.isFolded);
    if (!survivors.length) { refundAndFinish('모든 참가자가 버스트했습니다. 승자 없이 라운드를 종료합니다.'); return; }
    if (survivors.length === 1) { settle(survivors[0]); return; }
    phase = 'betting'; turn = 0; currentBet = baseBet; allInCap = null; closeOnCallBy = null; acted = new Set();
    note('카드 선택이 끝났습니다. 배팅을 시작합니다.');
  }

  function pay(player, amount) { player.chips -= amount; player.roundBet += amount; pot += amount; }
  function advanceBet() {
    const list = bettingPlayers();
    if (list.length <= 1) { settle(list[0]); return; }
    const player = currentBetPlayer();
    turn = (list.findIndex((p) => p.id === player.id) + 1) % list.length;
  }

  function call(playerId) {
    const player = currentBetPlayer();
    if (phase !== 'betting' || !player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    const needed = Math.max(0, currentBet - player.roundBet);
    if (player.chips < needed) return '콜할 칩이 부족합니다. 올인을 선택하세요.';
    pay(player, needed); acted.add(playerId); note(`${player.nickname}님이 ${needed.toLocaleString()}원을 콜했습니다.`);
    if (closeOnCallBy === playerId || bettingPlayers().every((p) => acted.has(p.id) && (p.roundBet === currentBet || p.isAllIn))) { showdown(); return null; }
    advanceBet(); changed(); return null;
  }

  function raise(playerId, amount) {
    const player = currentBetPlayer();
    if (phase !== 'betting' || !player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    if (allInCap !== null) return '올인 이후에는 레이즈할 수 없습니다.';
    const value = Number(amount); const needed = currentBet - player.roundBet + value;
    if (!Number.isInteger(value) || value < 100 || value % 100 !== 0) return '레이즈는 100원 단위로 입력해 주세요.';
    if (needed >= player.chips) return '레이즈 후 칩이 남아야 합니다. 전액은 올인을 사용하세요.';
    pay(player, needed); currentBet += value; acted = new Set([playerId]); advanceBet(); closeOnCallBy = currentBetPlayer().id;
    note(`${player.nickname}님이 ${value.toLocaleString()}원을 레이즈했습니다.`); changed(); return null;
  }

  function allin(playerId) {
    const player = currentBetPlayer();
    if (phase !== 'betting' || !player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    if (allInCap !== null) return '이 판에서는 이미 올인이 발생했습니다.';
    if (player.chips <= 0) return '올인할 칩이 없습니다.';
    const cap = player.roundBet + player.chips; pay(player, player.chips); player.isAllIn = true; allInCap = cap; currentBet = cap;
    for (const other of bettingPlayers()) if (other.roundBet > cap) { const refund = other.roundBet - cap; other.roundBet -= refund; other.chips += refund; pot -= refund; }
    acted.add(playerId); note(`${player.nickname}님이 ${cap.toLocaleString()}원에 올인했습니다.`); advanceBet(); changed(); return null;
  }

  function fold(playerId) {
    const player = currentBetPlayer();
    if (phase !== 'betting' || !player || player.id !== playerId) return '지금은 본인 차례가 아닙니다.';
    player.isFolded = true; note(`${player.nickname}님이 폴드했습니다.`);
    if (bettingPlayers().length === 1) { settle(bettingPlayers()[0]); return null; }
    turn %= bettingPlayers().length; changed(); return null;
  }

  function showdown() {
    let candidates = bettingPlayers();
    const bestScore = Math.max(...candidates.map((p) => p.score));
    candidates = candidates.filter((p) => p.score === bestScore);
    const mostCards = Math.max(...candidates.map((p) => p.hand.length));
    candidates = candidates.filter((p) => p.hand.length === mostCards);
    let safety = 20;
    while (candidates.length > 1 && deck.length >= candidates.length && safety-- > 0) {
      note(`동점자 ${candidates.length}명이 카드 한 장씩 재대결합니다.`);
      candidates.forEach(draw);
      candidates = candidates.filter((p) => !p.isBusted);
      if (!candidates.length) { refundAndFinish('재대결 참가자가 모두 버스트해 배팅금을 돌려드립니다.'); return; }
      const nextScore = Math.max(...candidates.map((p) => p.score));
      candidates = candidates.filter((p) => p.score === nextScore);
      const nextCards = Math.max(...candidates.map((p) => p.hand.length));
      candidates = candidates.filter((p) => p.hand.length === nextCards);
    }
    if (candidates.length === 1) settle(candidates[0]);
    else refundAndFinish('동점을 가리지 못해 배팅금을 돌려드립니다.');
  }

  function settle(winner) {
    if (!winner) return;
    const amount = pot; winner.chips += pot; pot = 0; phase = 'result';
    result = { winnerId: winner.id, nickname: winner.nickname, amount, noWinner: false };
    note(`${winner.nickname}님이 ${winner.score}점으로 팟 ${amount.toLocaleString()}원을 획득했습니다.`);
    players.forEach((p) => { p.ready = false; p.isAllIn = false; }); changed();
  }

  function refundAndFinish(message) {
    for (const player of players) { player.chips += player.roundBet; player.roundBet = 0; player.ready = false; player.isAllIn = false; }
    pot = 0; phase = 'result'; result = { noWinner: true, message }; note(message); changed();
  }

  function donate(fromId, toId, amount) {
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
      type: 'blackjackState', phase, hostId, baseBet, pot, currentBet, allInCap, result,
      turnPlayerId: phase === 'playing' ? playingTurn && playingTurn.id : phase === 'betting' ? bettingTurn && bettingTurn.id : null,
      you: me ? { id: me.id, chips: me.chips, ready: me.ready } : null,
      canStart: playerId === hostId && (phase === 'lobby' || phase === 'result') && players.filter((p) => p.connected && p.ready && p.chips > 0).length >= MIN_PLAYERS,
      baseBetProposal: baseBetProposal ? { id: baseBetProposal.id, proposerName: baseBetProposal.proposerName, amount: baseBetProposal.amount, agreed: [...baseBetProposal.votes.values()].filter(Boolean).length, voted: baseBetProposal.votes.size, total: players.filter((p) => p.connected && p.id !== baseBetProposal.proposerId).length, yourVote: playerId === baseBetProposal.proposerId || baseBetProposal.votes.has(playerId) } : null,
      history: history.slice(-12),
      players: players.filter((p) => p.connected).map((p) => {
        const reveal = phase === 'result' ? !p.isFolded : p.id === playerId;
        return { id: p.id, nickname: p.nickname, chips: p.chips, ready: p.ready, score: reveal ? p.score : null, cards: p.hand.map((card) => reveal ? card : { hidden: true }), isBusted: p.isBusted, isStanding: p.isStanding, isFolded: p.isFolded, isAllIn: p.isAllIn, roundBet: p.roundBet };
      }),
    };
  }

  return { join, disconnect, leave, setReady, proposeBaseBet, voteBaseBet, begin, hit, stand, call, raise, allin, fold, donate, stateFor, status: () => ({ phase, playerCount: players.filter((p) => p.connected).length }) };
}

module.exports = { createBlackjackRoom, INITIAL_CHIPS };
