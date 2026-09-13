'use strict';

const assert = require('assert');
const { createPokerRoom, INITIAL_CHIPS } = require('../web/poker-room');

const room = createPokerRoom({ onChange() {} });
const a = room.join({ nickname: 'A' });
const b = room.join({ nickname: 'B' });
assert.ok(!a.error && !b.error);
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

console.log('포커 규칙: 배팅·카드 공개·정산·배팅금 투표·빈 방 초기화 통과');
