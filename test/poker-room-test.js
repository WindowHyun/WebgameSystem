'use strict';

const assert = require('assert');
const { createPokerRoom, INITIAL_CHIPS } = require('../web/poker-room');

const room = createPokerRoom({ onChange() {} });
const a = room.join({ nickname: 'A' });
const b = room.join({ nickname: 'B' });
assert.ok(!a.error && !b.error);
const aReconnected = room.join({ nickname: 'A', token: a.token });
assert.equal(aReconnected.playerId, a.playerId);
assert.equal(room.stateFor(a.playerId).players.length, 2);
assert.equal(room.stateFor(a.playerId).you.chips, INITIAL_CHIPS);
room.setReady(a.playerId, true);
room.setReady(b.playerId, true);
assert.equal(room.begin(a.playerId), null);
let stateA = room.stateFor(a.playerId);
const stateB = room.stateFor(b.playerId);
assert.equal(stateA.phase, 'betting');
assert.equal(stateA.players.find((p) => p.id === a.playerId).card.hidden, true);
assert.ok(stateA.players.find((p) => p.id === b.playerId).card.rank);
assert.equal(stateB.players.find((p) => p.id === b.playerId).card.hidden, true);

const first = stateA.turnPlayerId;
assert.equal(room.call(first), null);
const second = room.stateFor(a.playerId).turnPlayerId;
assert.equal(room.call(second), null);
stateA = room.stateFor(a.playerId);
assert.ok(stateA.phase === 'result' || stateA.phase === 'betting'); // 동점이면 재대결
assert.ok(stateA.pot === 0 || stateA.pot >= 200);
assert.equal(stateA.players.reduce((sum, p) => sum + p.chips, 0) + stateA.pot, INITIAL_CHIPS * 2);

room.disconnect(a.playerId);
room.disconnect(b.playerId);
const resetPlayer = room.join({ nickname: '새 참가자' });
assert.equal(room.stateFor(resetPlayer.playerId).you.chips, INITIAL_CHIPS);
assert.equal(room.status().playerCount, 1);

const voteRoom = createPokerRoom({ onChange() {} });
const v1 = voteRoom.join({ nickname: '가' });
const v2 = voteRoom.join({ nickname: '나' });
const v3 = voteRoom.join({ nickname: '다' });
assert.equal(voteRoom.setBaseBet(v1.playerId, 500), null);
let proposal = voteRoom.stateFor(v2.playerId).baseBetProposal;
assert.equal(proposal.amount, 500);
assert.equal(voteRoom.voteBaseBet(v1.playerId, proposal.id, true), '제안자는 투표 대상이 아닙니다.');
assert.equal(voteRoom.stateFor(v1.playerId).baseBet, 100);
voteRoom.voteBaseBet(v2.playerId, proposal.id, true);
assert.equal(voteRoom.stateFor(v3.playerId).baseBet, 500);
assert.equal(voteRoom.stateFor(v3.playerId).baseBetProposal, null);

assert.equal(voteRoom.setBaseBet(v3.playerId, 1000), null);
proposal = voteRoom.stateFor(v1.playerId).baseBetProposal;
voteRoom.voteBaseBet(v1.playerId, proposal.id, false);
voteRoom.voteBaseBet(v2.playerId, proposal.id, false);
assert.equal(voteRoom.stateFor(v3.playerId).baseBet, 500);
assert.equal(voteRoom.stateFor(v3.playerId).baseBetProposal, null);

// [이슈] 폴드해도 이번 라운드 참가자였다면 계속 테이블을 볼 수 있어야 하고,
// 라운드가 끝나면 폴드했던 사람의 카드도 결국 공개되어야 한다.
const foldRoom = createPokerRoom({ onChange() {} });
const fx = foldRoom.join({ nickname: 'X' });
const fy = foldRoom.join({ nickname: 'Y' });
const fz = foldRoom.join({ nickname: 'Z' });
[fx, fy, fz].forEach((p) => foldRoom.setReady(p.playerId, true));
assert.equal(foldRoom.begin(fx.playerId), null);
assert.equal(foldRoom.stateFor(fx.playerId).turnPlayerId, fx.playerId);
assert.equal(foldRoom.fold(fx.playerId), null);

const afterFold = foldRoom.stateFor(fx.playerId);
assert.equal(afterFold.phase, 'betting', '두 명이 남았으니 라운드는 계속된다');
const yCard = afterFold.players.find((p) => p.id === fy.playerId).card;
const zCard = afterFold.players.find((p) => p.id === fz.playerId).card;
assert.ok(yCard && !yCard.hidden, '폴드해도 아직 뛰고 있는 다른 사람의 카드는 계속 보여야 한다');
assert.ok(zCard && !zCard.hidden, '폴드해도 아직 뛰고 있는 다른 사람의 카드는 계속 보여야 한다');

let foldState = foldRoom.stateFor(fy.playerId);
for (let guard = 0; guard < 20 && foldState.phase === 'betting'; guard += 1) {
  assert.equal(foldRoom.call(foldState.turnPlayerId), null);
  foldState = foldRoom.stateFor(fy.playerId);
}
assert.equal(foldState.phase, 'result');
const foldedAtResult = foldState.players.find((p) => p.id === fx.playerId);
assert.ok(foldedAtResult.card && !foldedAtResult.card.hidden,
  '폴드한 사람의 카드도 라운드가 끝나면 다른 사람에게 공개되어야 한다');

// [이슈] 상대가 폴드해서 끝난 판(쇼다운 없음)도 끝나면 각자 자기 카드를 볼 수 있어야 한다.
// 예전에는 쇼다운까지 간 판만 공개해서, 이긴 사람도 진 사람도 자기 카드를 끝내 몰랐다.
const quitRoom = createPokerRoom({ onChange() {} });
const qa = quitRoom.join({ nickname: 'QA' });
const qb = quitRoom.join({ nickname: 'QB' });
[qa, qb].forEach((p) => quitRoom.setReady(p.playerId, true));
assert.equal(quitRoom.begin(qa.playerId), null);
const quitter = quitRoom.stateFor(qa.playerId).turnPlayerId;
const stayer = quitter === qa.playerId ? qb.playerId : qa.playerId;
assert.ok(quitRoom.stateFor(stayer).players.find((p) => p.id === stayer).card.hidden, '판 중에는 자기 카드를 볼 수 없다');
assert.equal(quitRoom.fold(quitter), null);
for (const viewer of [qa.playerId, qb.playerId]) {
  const s = quitRoom.stateFor(viewer);
  assert.equal(s.phase, 'result');
  assert.equal(s.result.revealed, false, '쇼다운 없이 끝난 판');
  const mine = s.players.find((p) => p.id === viewer).card;
  assert.ok(mine && !mine.hidden && mine.rank, '폴드로 끝난 판도 끝나면 자기 카드를 볼 수 있어야 한다');
  assert.ok(s.players.every((p) => !p.card || !p.card.hidden), '폴드로 끝난 판도 끝나면 모든 카드를 공개한다');
}
// 다음 판을 시작하면 다시 자기 카드는 가려진다.
[qa, qb].forEach((p) => quitRoom.setReady(p.playerId, true));
assert.equal(quitRoom.begin(qa.playerId), null);
const nextRound = quitRoom.stateFor(qa.playerId);
assert.equal(nextRound.phase, 'betting');
assert.ok(nextRound.players.find((p) => p.id === qa.playerId).card.hidden, '새 판에서는 다시 자기 카드가 가려진다');

console.log('포커 규칙: 배팅·카드 공개·정산·배팅금 투표·폴드 후 관전·폴드로 끝난 판 공개·빈 방 초기화 통과');
