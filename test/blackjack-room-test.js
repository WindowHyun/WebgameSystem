'use strict';

const assert = require('assert');
const { createBlackjackRoom, INITIAL_CHIPS } = require('../web/blackjack-room');

const room = createBlackjackRoom({ onChange() {} });
const a = room.join({ nickname: 'A' });
const b = room.join({ nickname: 'B' });
assert.ok(!a.error && !b.error);
const aReconnected = room.join({ nickname: 'A', token: a.token });
assert.equal(aReconnected.playerId, a.playerId);
assert.equal(room.stateFor(a.playerId).players.length, 2);

assert.equal(room.proposeBaseBet(a.playerId, 500), null);
let state = room.stateFor(b.playerId);
assert.equal(state.baseBetProposal.amount, 500);
assert.equal(room.voteBaseBet(b.playerId, state.baseBetProposal.id, true), null);
assert.equal(room.stateFor(a.playerId).baseBet, 500);

room.setReady(a.playerId, true);
room.setReady(b.playerId, true);
assert.equal(room.begin(a.playerId), null);
state = room.stateFor(a.playerId);
assert.equal(state.phase, 'playing');
assert.equal(state.players.find((p) => p.id === a.playerId).cards.length, 2);
assert.ok(!state.players.find((p) => p.id === a.playerId).cards[0].hidden);
assert.ok(state.players.find((p) => p.id === b.playerId).cards[0].hidden);

let current = state.turnPlayerId;
assert.equal(room.stand(current), null);
current = room.stateFor(a.playerId).turnPlayerId;
assert.equal(room.stand(current), null);
state = room.stateFor(a.playerId);
assert.equal(state.phase, 'betting');

current = state.turnPlayerId;
assert.equal(room.call(current), null);
current = room.stateFor(a.playerId).turnPlayerId;
assert.equal(room.call(current), null);
state = room.stateFor(a.playerId);
assert.equal(state.phase, 'result');
assert.equal(state.pot, 0);
assert.equal(state.players.reduce((sum, p) => sum + p.chips, 0), INITIAL_CHIPS * 2);
assert.ok(state.players.every((p) => p.cards.every((card) => !card.hidden)));

const bluffRoom = createBlackjackRoom({ onChange() {} });
const bluffer = bluffRoom.join({ nickname: '블러퍼' });
const opponent = bluffRoom.join({ nickname: '상대' });
bluffRoom.setReady(bluffer.playerId, true);
bluffRoom.setReady(opponent.playerId, true);
bluffRoom.begin(bluffer.playerId);
let bluffState = bluffRoom.stateFor(bluffer.playerId);
while (bluffState.players.find((p) => p.id === bluffer.playerId).score <= 21) {
  assert.equal(bluffRoom.hit(bluffer.playerId), null);
  bluffState = bluffRoom.stateFor(bluffer.playerId);
}
assert.equal(bluffState.phase, 'playing');
assert.equal(bluffState.turnPlayerId, bluffer.playerId);
assert.equal(bluffRoom.stand(bluffer.playerId), null);
assert.equal(bluffRoom.stand(opponent.playerId), null);
assert.equal(bluffRoom.stateFor(bluffer.playerId).phase, 'betting');
assert.equal(bluffRoom.call(bluffer.playerId), null);
assert.equal(bluffRoom.fold(opponent.playerId), null);
bluffState = bluffRoom.stateFor(bluffer.playerId);
assert.equal(bluffState.result.winnerId, bluffer.playerId);
assert.ok(bluffState.players.find((p) => p.id === bluffer.playerId).score > 21);

room.disconnect(a.playerId);
room.disconnect(b.playerId);
const fresh = room.join({ nickname: '새 참가자' });
assert.equal(room.stateFor(fresh.playerId).you.chips, INITIAL_CHIPS);
assert.equal(room.stateFor(fresh.playerId).baseBet, 100);

console.log('블랙잭 규칙: 21 초과 블러핑·배팅·쇼다운·투표·빈 방 초기화 통과');
