'use strict';

const assert = require('assert');
const { createPokerRoom } = require('../web/poker-room');
const { createBlackjackRoom } = require('../web/blackjack-room');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function joinReady(room, names) {
  const joined = names.map((nickname) => room.join({ nickname }));
  joined.forEach((player) => room.setReady(player.playerId, true));
  return joined;
}

async function run() {
  const poker = createPokerRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 15 });
  const [pa, pb, pc] = joinReady(poker, ['같은이름', '같은이름', '세번째']);
  assert.equal(poker.stateFor(pb.playerId).players.find((p) => p.id === pb.playerId).nickname, '같은이름(2)');
  assert.equal(poker.setBaseBet(pa.playerId, 500), null);
  assert.equal(poker.begin(pa.playerId), '기본 배팅금 투표가 끝난 뒤 시작해 주세요.');
  await wait(30);
  assert.equal(poker.stateFor(pa.playerId).baseBetProposal, null);
  assert.equal(poker.begin(pa.playerId), null);
  let state = poker.stateFor(pa.playerId);
  assert.equal(poker.donate(pa.playerId, pb.playerId, 100), '기부는 대기 중에만 할 수 있습니다.');
  assert.equal(poker.raise(state.turnPlayerId, 100), null);
  state = poker.stateFor(pa.playerId);
  assert.equal(poker.call(state.turnPlayerId), null);
  state = poker.stateFor(pa.playerId);
  assert.equal(state.phase, 'betting', '레이즈 직후 한 명의 콜만으로 쇼다운하면 안 됩니다.');
  assert.equal(state.turnPlayerId, pc.playerId);

  const capacity = createPokerRoom({ onChange() {} });
  for (let i = 0; i < 5; i += 1) assert.ok(!capacity.join({ nickname: `참가자${i}` }).error);
  assert.match(capacity.join({ nickname: '여섯번째' }).error, /최대 5명/);

  const pokerTimeout = createPokerRoom({ onChange() {}, actionTimeoutMs: 15 });
  const [pta] = joinReady(pokerTimeout, ['시간초과1', '시간초과2']);
  assert.equal(pokerTimeout.begin(pta.playerId), null);
  await wait(35);
  assert.equal(pokerTimeout.stateFor(pta.playerId).phase, 'result');

  const blackjack = createBlackjackRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 15 });
  const [ba, bb, bc] = joinReady(blackjack, ['블랙', '블랙', '세번째']);
  assert.equal(blackjack.stateFor(bb.playerId).players.find((p) => p.id === bb.playerId).nickname, '블랙(2)');
  assert.equal(blackjack.proposeBaseBet(ba.playerId, 500), null);
  assert.equal(blackjack.begin(ba.playerId), '기본 배팅금 투표가 끝난 뒤 시작해 주세요.');
  await wait(30);
  assert.equal(blackjack.begin(ba.playerId), null);
  state = blackjack.stateFor(ba.playerId);
  while (state.players.find((p) => p.id === ba.playerId).score <= 21) {
    assert.equal(blackjack.hit(ba.playerId), null);
    state = blackjack.stateFor(ba.playerId);
  }
  const opponentView = blackjack.stateFor(bb.playerId).players.find((p) => p.id === ba.playerId);
  assert.equal(opponentView.score, null);
  assert.equal(opponentView.isBusted, false, '상대에게 21 초과 여부가 노출되면 안 됩니다.');
  assert.equal(blackjack.donate(ba.playerId, bb.playerId, 100), '기부는 대기 중에만 할 수 있습니다.');
  assert.equal(blackjack.stand(ba.playerId), null);
  assert.equal(blackjack.stand(bb.playerId), null);
  assert.equal(blackjack.stand(bc.playerId), null);
  state = blackjack.stateFor(ba.playerId);
  assert.equal(blackjack.raise(state.turnPlayerId, 100), null);
  state = blackjack.stateFor(ba.playerId);
  assert.equal(blackjack.call(state.turnPlayerId), null);
  assert.equal(blackjack.stateFor(ba.playerId).phase, 'betting', '모든 참가자가 배팅을 맞추기 전에 끝나면 안 됩니다.');

  const pokerDisconnectTurn = createPokerRoom({ onChange() {}, actionTimeoutMs: 0 });
  const [pdA, pdB, pdC] = joinReady(pokerDisconnectTurn, ['A', 'B', 'C', 'D']);
  assert.equal(pokerDisconnectTurn.begin(pdA.playerId), null);
  assert.equal(pokerDisconnectTurn.call(pdA.playerId), null);
  assert.equal(pokerDisconnectTurn.call(pdB.playerId), null);
  assert.equal(pokerDisconnectTurn.stateFor(pdC.playerId).turnPlayerId, pdC.playerId);
  pokerDisconnectTurn.disconnect(pdA.playerId);
  assert.equal(pokerDisconnectTurn.stateFor(pdC.playerId).turnPlayerId, pdC.playerId, '포커에서 앞 순서 참가자가 끊겨도 현재 턴을 유지해야 합니다.');

  const pokerLeaveTurn = createPokerRoom({ onChange() {}, actionTimeoutMs: 0 });
  const [plA, plB, plC] = joinReady(pokerLeaveTurn, ['A', 'B', 'C']);
  assert.equal(pokerLeaveTurn.begin(plA.playerId), null);
  assert.equal(pokerLeaveTurn.call(plA.playerId), null);
  assert.equal(pokerLeaveTurn.stateFor(plB.playerId).turnPlayerId, plB.playerId);
  pokerLeaveTurn.leave(plC.playerId);
  assert.equal(pokerLeaveTurn.stateFor(plB.playerId).turnPlayerId, plB.playerId, '포커에서 다른 참가자가 나가도 현재 턴을 유지해야 합니다.');

  const blackjackDisconnectTurn = createBlackjackRoom({ onChange() {}, actionTimeoutMs: 0 });
  const [bdA, bdB, bdC, bdD] = joinReady(blackjackDisconnectTurn, ['A', 'B', 'C', 'D']);
  assert.equal(blackjackDisconnectTurn.begin(bdA.playerId), null);
  for (const player of [bdA, bdB, bdC, bdD]) assert.equal(blackjackDisconnectTurn.stand(player.playerId), null);
  assert.equal(blackjackDisconnectTurn.call(bdA.playerId), null);
  assert.equal(blackjackDisconnectTurn.call(bdB.playerId), null);
  assert.equal(blackjackDisconnectTurn.stateFor(bdC.playerId).turnPlayerId, bdC.playerId);
  blackjackDisconnectTurn.disconnect(bdA.playerId);
  assert.equal(blackjackDisconnectTurn.stateFor(bdC.playerId).turnPlayerId, bdC.playerId, '블랙잭에서 앞 순서 참가자가 끊겨도 현재 턴을 유지해야 합니다.');

  const blackjackLeaveTurn = createBlackjackRoom({ onChange() {}, actionTimeoutMs: 0 });
  const [blA, blB, blC] = joinReady(blackjackLeaveTurn, ['A', 'B', 'C']);
  assert.equal(blackjackLeaveTurn.begin(blA.playerId), null);
  for (const player of [blA, blB, blC]) assert.equal(blackjackLeaveTurn.stand(player.playerId), null);
  assert.equal(blackjackLeaveTurn.call(blA.playerId), null);
  assert.equal(blackjackLeaveTurn.stateFor(blB.playerId).turnPlayerId, blB.playerId);
  blackjackLeaveTurn.leave(blC.playerId);
  assert.equal(blackjackLeaveTurn.stateFor(blB.playerId).turnPlayerId, blB.playerId, '블랙잭에서 다른 참가자가 나가도 현재 턴을 유지해야 합니다.');

  const blackjackTimeout = createBlackjackRoom({ onChange() {}, actionTimeoutMs: 15 });
  const [bta] = joinReady(blackjackTimeout, ['시간초과1', '시간초과2']);
  assert.equal(blackjackTimeout.begin(bta.playerId), null);
  await wait(75);
  assert.equal(blackjackTimeout.stateFor(bta.playerId).phase, 'result');

  const latePoker = createPokerRoom({ onChange() {}, actionTimeoutMs: 0 });
  const [lpA, lpB] = joinReady(latePoker, ['진행자A', '진행자B']);
  assert.equal(latePoker.begin(lpA.playerId), null);
  const lpLate = latePoker.join({ nickname: '늦은참가자' });
  let lateState = latePoker.stateFor(lpLate.playerId);
  assert.equal(lateState.you.inRound, false);
  assert.ok(lateState.players.filter((p) => p.card).every((p) => p.card.hidden), '진행 중 입장자에게 기존 참가자의 카드가 보여서는 안 됩니다.');
  latePoker.call(latePoker.stateFor(lpA.playerId).turnPlayerId);
  latePoker.fold(latePoker.stateFor(lpA.playerId).turnPlayerId);
  lateState = latePoker.stateFor(lpLate.playerId);
  assert.equal(lateState.result.revealed, false);
  assert.ok(lateState.players.filter((p) => p.card).every((p) => p.card.hidden), '폴드로 끝난 판의 승자 카드는 공개하지 않습니다.');
  assert.ok(lateState.players.every((p) => p.roundBet === 0));
  for (const player of [lpA, lpB, lpLate]) latePoker.setReady(player.playerId, true);
  assert.equal(latePoker.begin(lpA.playerId), null);
  assert.equal(latePoker.stateFor(lpLate.playerId).you.inRound, true, '진행 중 입장자는 다음 판부터 참가해야 합니다.');

  const foldedPoker = createPokerRoom({ onChange() {}, actionTimeoutMs: 0 });
  const [fpA, , fpC] = joinReady(foldedPoker, ['A', 'B', 'C']);
  assert.equal(foldedPoker.begin(fpA.playerId), null);
  while (foldedPoker.stateFor(fpA.playerId).turnPlayerId !== fpC.playerId) foldedPoker.call(foldedPoker.stateFor(fpA.playerId).turnPlayerId);
  assert.equal(foldedPoker.fold(fpC.playerId), null);
  const foldedState = foldedPoker.stateFor(fpC.playerId);
  assert.ok(foldedState.players.filter((p) => p.card).every((p) => p.card.hidden), '폴드한 참가자에게 남은 사람들의 카드가 보여서는 안 됩니다.');

  const lateBlackjack = createBlackjackRoom({ onChange() {}, actionTimeoutMs: 0 });
  const [lbA, lbB] = joinReady(lateBlackjack, ['진행자A', '진행자B']);
  assert.equal(lateBlackjack.begin(lbA.playerId), null);
  const lbLate = lateBlackjack.join({ nickname: '늦은참가자' });
  assert.equal(lateBlackjack.stateFor(lbLate.playerId).you.inRound, false);
  lateBlackjack.disconnect(lbA.playerId);
  lateBlackjack.disconnect(lbB.playerId);
  const recovered = lateBlackjack.stateFor(lbLate.playerId);
  assert.equal(recovered.phase, 'result', '진행 참가자가 0명이 되면 판을 종료해야 합니다.');
  assert.equal(recovered.turnPlayerId, null);
  assert.equal(lateBlackjack.setReady(lbLate.playerId, true), null, '대기 참가자는 종료 후 다음 판을 준비할 수 있어야 합니다.');
  const lbNext = lateBlackjack.join({ nickname: '다음참가자' });
  lateBlackjack.setReady(lbNext.playerId, true);
  assert.equal(lateBlackjack.begin(lbLate.playerId), null);
  assert.equal(lateBlackjack.stateFor(lbLate.playerId).you.inRound, true, '대기 참가자는 다음 블랙잭 판에 참가해야 합니다.');

  for (const makeRoom of [createPokerRoom, createBlackjackRoom]) {
    const reserved = makeRoom({ onChange() {}, actionTimeoutMs: 0, disconnectGraceMs: 15 });
    const seats = Array.from({ length: 5 }, (_, index) => reserved.join({ nickname: `자리${index}` }));
    reserved.disconnect(seats[4].playerId);
    assert.match(reserved.join({ nickname: '정원우회' }).error, /최대 5명/, '재접속 유예 자리도 정원에 포함해야 합니다.');
    assert.equal(reserved.join({ nickname: '자리4', token: seats[4].token }).playerId, seats[4].playerId);
    assert.equal(reserved.status().playerCount, 5);
    reserved.disconnect(seats[4].playerId);
    await wait(30);
    assert.ok(!reserved.join({ nickname: '정리후참가' }).error, '유예가 끝난 연결 종료 자리는 제거해야 합니다.');
    assert.equal(reserved.status().playerCount, 5);
  }

  console.log('카드 게임 이슈 방지: 정보 은닉·중도 참가·투표·배팅 종료·턴 동기화·시간제한·재접속 정원·닉네임 통과');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
