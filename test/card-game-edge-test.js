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

  console.log('카드 게임 이슈 방지: 정보 은닉·투표·배팅 종료·턴 동기화·시간제한·정원·닉네임 통과');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
