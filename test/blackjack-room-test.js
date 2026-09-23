'use strict';

const assert = require('assert');
const { createBlackjackRoom, scoreHand, INITIAL_CHIPS } = require('../web/blackjack-room');

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
// [이슈] 폴드했다고 라운드가 끝난 뒤까지 카드가 영원히 가려지면 안 된다.
const foldedAtResult = bluffState.players.find((p) => p.id === opponent.playerId);
assert.ok(foldedAtResult.score !== null, '폴드한 사람도 라운드가 끝나면 점수가 보여야 한다');
assert.ok(foldedAtResult.cards.every((card) => !card.hidden), '폴드한 사람의 카드도 라운드가 끝나면 공개되어야 한다');

room.disconnect(a.playerId);
room.disconnect(b.playerId);
const fresh = room.join({ nickname: '새 참가자' });
assert.equal(room.stateFor(fresh.playerId).you.chips, INITIAL_CHIPS);
assert.equal(room.stateFor(fresh.playerId).baseBet, 100);

// [규칙] 에이스는 무조건 1로 센다.
// 1/11로 세던 때는 히트했는데 점수가 줄어드는 일이 있었다(A+K 21점 → 4를 받으면 15점).
// 규칙상 맞는 계산이지만 화면에는 숫자 하나만 보여서 "히트했더니 점수가 깎였다"는
// 제보가 나왔다. 이 게임의 규칙은 에이스 1로 정한다.
for (const [ranks, want, label] of [
  [[1, 13], 11, 'A + K'],
  [[1, 1], 2, 'A + A'],
  [[1, 5, 9], 15, 'A + 5 + 9'],
  [[1, 6], 7, 'A + 6'],
  [[1, 10, 10], 21, 'A + 10 + 10'],
  [[10, 9, 5], 24, '10 + 9 + 5 (버스트)'],
]) {
  assert.equal(scoreHand(ranks.map((rank) => ({ rank, suit: '♠' }))), want, `${label}는 ${want}점이어야 합니다`);
}

// 제보된 증상 자체를 지킨다: 어떤 손에서든 히트하면 점수는 반드시 오른다.
// 두 장짜리 모든 손 × 받을 수 있는 모든 카드, 세 장째에서 한 장 더까지 전부 본다.
for (let a = 1; a <= 13; a += 1) {
  for (let b = 1; b <= 13; b += 1) {
    for (let c = 1; c <= 13; c += 1) {
      const two = [a, b].map((rank) => ({ rank, suit: '♠' }));
      const three = two.concat({ rank: c, suit: '♥' });
      assert.ok(scoreHand(three) > scoreHand(two),
        `히트했는데 점수가 줄거나 그대로다: ${[a, b]} = ${scoreHand(two)} → +${c} = ${scoreHand(three)}`);
      for (let d = 1; d <= 13; d += 1) {
        const four = three.concat({ rank: d, suit: '♦' });
        assert.ok(scoreHand(four) > scoreHand(three),
          `히트했는데 점수가 줄거나 그대로다: ${[a, b, c]} = ${scoreHand(three)} → +${d} = ${scoreHand(four)}`);
      }
    }
  }
}

console.log('블랙잭 규칙: 21 초과 블러핑·배팅·쇼다운·투표·에이스 1·히트하면 점수가 오른다·빈 방 초기화 통과');
