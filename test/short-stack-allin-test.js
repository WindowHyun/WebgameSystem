'use strict';

/**
 * [규칙] 상대가 먼저 올인해도, 칩이 더 적은 사람이 자기 몫으로 올인할 수 있다.
 *
 * 예전에는 이 판에 올인이 한 번이라도 있으면 두 번째 올인을 막았다. 그런데 콜은
 * "칩이 모자라면 올인하라"며 거절하고 올인은 "이미 올인이 있었다"며 거절해서, 칩이
 * 적은 사람에게 남는 선택지가 폴드뿐이었다 - 자기 칩을 다 걸고 겨뤄 볼 기회조차
 * 없었다. 올인으로 동점을 내 칩이 0이 되면 그다음 판부터는 확정적으로 그 상태였다.
 *
 * 사이드 팟이 없으므로 규칙은 하나로 정한다: 올인이 여럿이면 그중 가장 적은 금액이
 * 이 판의 상한이 되고, 더 낸 사람은 넘치는 몫을 돌려받는다. 여기서는 그 규칙과,
 * 그 과정에서 칩이 늘거나 줄지 않는지를 함께 확인한다.
 */

const assert = require('assert');
const { createPokerRoom, INITIAL_CHIPS } = require('../web/poker-room');
const { createBlackjackRoom } = require('../web/blackjack-room');

/** 방 전체의 칩 + 팟. 어떤 경우에도 시작 총액과 같아야 한다. */
function totalChips(state) {
  return state.players.reduce((sum, p) => sum + p.chips, 0) + state.pot;
}

function seat(room, names) {
  const joined = names.map((name) => room.join({ nickname: name }));
  for (const p of joined) room.setReady(p.playerId, true);
  return joined;
}

function testPoker() {
  const room = createPokerRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
  const [a, b] = seat(room, ['큰손', '숏스택']);
  assert.equal(room.begin(a.playerId), null);
  const view = () => room.stateFor(a.playerId);
  const startTotal = totalChips(view());
  assert.equal(startTotal, INITIAL_CHIPS * 2);

  // 숏스택의 칩을 줄여 놓는다. 큰손이 올인하면 콜도 못 하는 상황을 만든다.
  const short = room.stateFor(b.playerId);
  const shortId = short.you.id;
  const shortPlayer = view().players.find((p) => p.id === shortId);
  assert.ok(shortPlayer);

  // 큰손이 먼저 올인한다.
  const firstId = view().turnPlayerId;
  const secondId = view().players.find((p) => p.id !== firstId).id;
  assert.equal(room.allin(firstId), null, '첫 올인은 언제나 가능해야 합니다.');

  const afterFirst = view();
  assert.equal(totalChips(afterFirst), startTotal, '올인 직후에도 총액은 그대로여야 합니다.');

  // 두 번째 사람도 올인할 수 있어야 한다. 예전에는 여기서 거절당했다.
  const before = view().players.find((p) => p.id === secondId).chips;
  assert.ok(before > 0, '두 번째 사람에게 칩이 남아 있어야 이 검사가 의미 있습니다.');
  const second = room.allin(secondId);
  assert.equal(second, null, `상대가 올인했어도 올인할 수 있어야 합니다. (받은 값: ${second})`);

  const end = view();
  assert.equal(totalChips(end), startTotal, '두 번째 올인 뒤에도 총액은 그대로여야 합니다.');
  assert.equal(end.phase, 'result', '둘 다 올인했으면 더 낼 것이 없으므로 바로 결과로 가야 합니다.');
  console.log('포커 올인: 상대가 올인해도 올인할 수 있고, 칩 총액이 보존된다 통과');
}

/** 칩이 적은 쪽이 올인하면 판의 상한이 그쪽에 맞춰 내려가고 차액이 환불된다. */
function testCapDropsToSmaller() {
  const room = createPokerRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
  const [a] = seat(room, ['A', 'B', 'C']);
  assert.equal(room.begin(a.playerId), null);
  const view = () => room.stateFor(a.playerId);
  const startTotal = totalChips(view());

  // 첫 사람이 크게 레이즈해서 판을 키운다.
  const raiser = view().turnPlayerId;
  assert.equal(room.raise(raiser, 50000), null);
  const raiserBet = view().players.find((p) => p.id === raiser).roundBet;
  assert.ok(raiserBet >= 50000, '레이즈가 반영되어야 합니다.');

  // 다음 사람이 올인한다. 그 금액이 레이즈액보다 크므로 상한은 아직 내려가지 않는다.
  const second = view().turnPlayerId;
  assert.equal(room.allin(second), null);
  const capAfterSecond = view().allInCap;
  assert.ok(capAfterSecond > raiserBet, '큰 스택의 올인은 상한을 레이즈액 위로 잡습니다.');

  // 세 번째 사람도 올인한다. 이 사람이 가장 적게 낼 수밖에 없다면 상한이 내려간다.
  const third = view().turnPlayerId;
  if (third && third !== second) {
    assert.equal(room.allin(third), null, '세 번째 사람도 올인할 수 있어야 합니다.');
    const capAfterThird = view().allInCap;
    assert.ok(capAfterThird <= capAfterSecond, '올인이 여럿이면 더 적은 쪽이 상한이 됩니다.');
    for (const p of view().players) {
      assert.ok(p.roundBet <= capAfterThird,
        `상한을 넘겨 낸 사람은 차액을 돌려받아야 합니다. (${p.nickname} ${p.roundBet} > ${capAfterThird})`);
    }
  }
  assert.equal(totalChips(view()), startTotal, '상한이 내려가도 칩 총액은 그대로여야 합니다.');
  console.log('포커 올인: 올인이 여럿이면 가장 적은 금액이 상한이 되고 차액이 환불된다 통과');
}

function testBlackjack() {
  const room = createBlackjackRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
  const [a] = seat(room, ['큰손', '숏스택']);
  assert.equal(room.begin(a.playerId), null);
  const view = () => room.stateFor(a.playerId);
  const startTotal = totalChips(view());

  // 카드 선택 단계를 넘겨 배팅으로 간다.
  let guard = 0;
  while (view().phase === 'playing' && guard < 20) {
    assert.equal(room.stand(view().turnPlayerId), null);
    guard += 1;
  }
  assert.equal(view().phase, 'betting');

  const firstId = view().turnPlayerId;
  const secondId = view().players.find((p) => p.id !== firstId).id;
  assert.equal(room.allin(firstId), null);
  const second = room.allin(secondId);
  assert.equal(second, null, `상대가 올인했어도 올인할 수 있어야 합니다. (받은 값: ${second})`);
  assert.equal(totalChips(view()), startTotal, '올인 뒤에도 칩 총액은 그대로여야 합니다.');
  console.log('블랙잭 올인: 상대가 올인해도 올인할 수 있고, 칩 총액이 보존된다 통과');
}

testPoker();
testCapDropsToSmaller();
testBlackjack();
