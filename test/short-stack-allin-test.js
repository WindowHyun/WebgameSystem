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

/**
 * 한쪽 칩만 적은 상황을, 게임이 실제로 허용하는 방법으로 만든다.
 * 둘 다 올인해 한 판을 끝내면 진 쪽이 0원이 되고, 0원이 된 사람에게는 기부가
 * 열린다(기부는 기본 배팅금보다 적게 가진 사람에게만 된다).
 */
function makeShortStack(room, ids, target) {
  const view = () => room.stateFor(ids[0]);
  for (let tries = 0; tries < 12; tries += 1) {
    if (view().phase !== 'betting') {
      for (const id of ids) room.setReady(id, true);
      assert.equal(room.begin(ids[0]), null, '판을 시작할 수 없습니다.');
    }
    // 비기면 재대결이 붙으므로 결과가 날 때까지 반복한다.
    for (let step = 0; step < 8 && view().phase === 'betting'; step += 1) {
      room.allin(view().turnPlayerId);
    }
    const broke = view().players.find((p) => p.chips === 0);
    if (!broke) continue;
    const rich = view().players.find((p) => p.chips > 0);
    assert.equal(room.donate(rich.id, broke.id, target), null, '기부가 거절되었습니다.');
    return { shortId: broke.id, bigId: rich.id };
  }
  throw new Error('숏스택을 만들지 못했습니다.');
}

/**
 * [신고] 상대보다 칩이 많을 때 올인하면 상대가 받을 수 있는 만큼만 걸려야 한다.
 *
 * 예전에는 보유한 칩 전부가 팟에 올라갔다. 사이드 팟이 없으니 그 돈은 상대가
 * 자기 몫으로 올인하는 순간 환불로 그대로 되돌아왔지만, 그사이 화면에는 아무도
 * 받을 수 없는 액수가 판돈으로 찍혀 있었다 - 200만원을 걸었다가 3천원으로
 * 조용히 내려앉는 셈이다. 되돌려 주느니 처음부터 걸지 않는다.
 */
function testDoesNotOverCommit() {
  const room = createPokerRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
  const seats = seat(room, ['큰손', '숏스택']);
  const ids = seats.map((x) => x.playerId);
  assert.equal(room.begin(ids[0]), null);
  const view = () => room.stateFor(ids[0]);
  const startTotal = totalChips(view());

  const { shortId, bigId } = makeShortStack(room, ids, 3000);
  for (const id of ids) room.setReady(id, true);
  assert.equal(room.begin(ids[0]), null);
  const byId = (id) => view().players.find((p) => p.id === id);
  assert.equal(byId(shortId).chips + byId(shortId).roundBet, 3000);

  // 큰손 차례로 맞춘다. 숏스택이 먼저면 한 번 콜해서 넘긴다.
  if (view().turnPlayerId === shortId) assert.equal(room.call(shortId), null);
  assert.equal(view().turnPlayerId, bigId);

  const shortTotal = byId(shortId).roundBet + byId(shortId).chips;
  assert.equal(room.allin(bigId), null, '올인이 거절되었습니다.');
  const shoved = byId(bigId);
  assert.ok(shoved.roundBet <= shortTotal,
    `상대는 ${shortTotal}원뿐인데 ${shoved.roundBet}원이 걸렸습니다.`);
  assert.ok(shoved.chips > 0, '못 받을 몫은 큰손에게 남아 있어야 합니다.');
  assert.ok(!shoved.isAllIn, '칩이 남았으면 올인으로 표시하면 안 됩니다.');
  assert.equal(totalChips(view()), startTotal, '올인 직후에도 총액은 그대로여야 합니다.');

  // 숏스택은 받을 수 있어야 한다 - 폴드 말고.
  const need = view().currentBet - byId(shortId).roundBet;
  const answer = byId(shortId).chips >= need ? room.call(shortId) : room.allin(shortId);
  assert.equal(answer, null, `숏스택이 받을 수 있어야 합니다. (받은 값: ${answer})`);
  assert.equal(totalChips(view()), startTotal, '끝난 뒤에도 총액은 그대로여야 합니다.');
  room.dispose();
  console.log('포커 올인: 상대가 받을 수 있는 만큼만 걸리고, 못 받을 몫은 손에 남는다 통과');
}

/** 세 명이면 상한은 "나 말고 가장 많이 가진 사람"이 낼 수 있는 전부다. */
function testThreeHandedCap() {
  const room = createPokerRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
  const seats = seat(room, ['A', 'B', 'C']);
  const ids = seats.map((x) => x.playerId);
  assert.equal(room.begin(ids[0]), null);
  const view = () => room.stateFor(ids[0]);
  const startTotal = totalChips(view());

  // 한 명을 3000원으로 줄인다. 나머지 둘은 그대로다.
  const first = view().turnPlayerId;
  assert.equal(room.raise(first, 50000), null);
  const thin = view().turnPlayerId;
  assert.equal(room.allin(thin), null);

  // 상한이 내려갔어도, 아직 칩이 넉넉한 사람은 그 금액을 받을 수 있어야 한다.
  const third = view().turnPlayerId;
  const need = view().currentBet - view().players.find((p) => p.id === third).roundBet;
  const rich = view().players.find((p) => p.id === third).chips >= need;
  const answer = rich ? room.call(third) : room.allin(third);
  assert.equal(answer, null, `세 번째 사람이 받을 수 있어야 합니다. (받은 값: ${answer})`);
  assert.equal(totalChips(view()), startTotal, '총액은 그대로여야 합니다.');
  room.dispose();
  console.log('포커 올인: 세 명일 때도 상한과 환불이 맞물려 총액이 보존된다 통과');
}

/** 블랙잭도 같은 규칙이다. 배팅 단계는 카드 선택을 넘긴 뒤에 온다. */
function testBlackjackCap() {
  const room = createBlackjackRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
  const seats = seat(room, ['큰손', '숏스택']);
  const ids = seats.map((x) => x.playerId);
  assert.equal(room.begin(ids[0]), null);
  const view = () => room.stateFor(ids[0]);
  const startTotal = totalChips(view());

  for (let guard = 0; view().phase === 'playing' && guard < 20; guard += 1) {
    assert.equal(room.stand(view().turnPlayerId), null);
  }
  assert.equal(view().phase, 'betting');

  const firstId = view().turnPlayerId;
  assert.equal(room.allin(firstId), null);
  const shoved = view().players.find((p) => p.id === firstId);
  const rivals = view().players.filter((p) => p.id !== firstId);
  const reachable = Math.max(...rivals.map((p) => p.roundBet + p.chips));
  assert.ok(shoved.roundBet <= reachable,
    `상대가 낼 수 있는 건 ${reachable}원인데 ${shoved.roundBet}원이 걸렸습니다.`);
  const second = room.allin(rivals[0].id);
  assert.equal(second, null, `상대도 올인할 수 있어야 합니다. (받은 값: ${second})`);
  assert.equal(totalChips(view()), startTotal, '총액은 그대로여야 합니다.');
  room.dispose();
  console.log('블랙잭 올인: 상한이 상대 보유액에 맞춰지고 총액이 보존된다 통과');
}

testPoker();
testCapDropsToSmaller();
testBlackjack();
testDoesNotOverCommit();
testThreeHandedCap();
testBlackjackCap();
