'use strict';

/**
 * [규칙] 레이즈 폭은 직전 레이즈 폭 이상이어야 한다.
 *
 * 없으면 앞사람이 10,000원을 올려도 뒷사람이 100원만 올리는 것을 반복할 수 있다.
 * 그러면 큰 레이즈로 판을 정리하려는 시도가 사실상 무효가 되고, 100원씩 올리는 동안
 * 아무도 물러서지 않아 제한시간이 끝날 때까지 배팅이 돌기만 한다.
 */

const assert = require('assert');
const { createPokerRoom } = require('../web/poker-room');
const { createBlackjackRoom } = require('../web/blackjack-room');

/** 참가 + 준비를 한 번에. 타이머는 테스트에서 끈다(0 = 사용 안 함). */
function seat(room, names) {
  const joined = names.map((name) => room.join({ nickname: name }));
  for (const p of joined) room.setReady(p.playerId, true);
  return joined;
}

function pokerRoom() {
  const room = createPokerRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
  const [a, b, c] = seat(room, ['A', 'B', 'C']);
  assert.equal(room.begin(a.playerId), null);
  return { room, a, b, c };
}

function testPoker() {
  const { room, a } = pokerRoom();
  const state = () => room.stateFor(a.playerId);

  // 기본 배팅금이 100원이므로 첫 레이즈의 하한도 100원이다.
  assert.equal(state().minRaise, 100, '첫 레이즈 하한은 기본 배팅금이어야 합니다.');

  // 첫 사람이 5,000원 레이즈 → 다음 레이즈 하한이 5,000원으로 올라간다.
  assert.equal(room.raise(state().turnPlayerId, 5000), null);
  assert.equal(state().minRaise, 5000, '레이즈 뒤에는 그 폭이 다음 하한이 되어야 합니다.');

  // 그 미만은 거절. 예전에는 이게 통과해서 100원으로 되받아칠 수 있었다.
  const tooSmall = room.raise(state().turnPlayerId, 100);
  assert.ok(tooSmall && tooSmall.includes('5,000'), `하한 미만 레이즈는 거절해야 합니다. (받은 값: ${tooSmall})`);
  assert.equal(room.raise(state().turnPlayerId, 4900), '레이즈는 직전 레이즈 금액인 5,000원 이상이어야 합니다.');

  // 딱 하한은 통과하고, 하한은 그대로 유지된다.
  assert.equal(room.raise(state().turnPlayerId, 5000), null, '하한과 같은 금액은 허용해야 합니다.');
  assert.equal(state().minRaise, 5000);

  // 더 크게 올리면 하한도 같이 올라간다.
  assert.equal(room.raise(state().turnPlayerId, 12000), null);
  assert.equal(state().minRaise, 12000, '더 큰 레이즈는 하한을 그만큼 끌어올려야 합니다.');

  // 100원 단위 검사는 그대로 살아 있다.
  assert.equal(room.raise(state().turnPlayerId, 12050), '레이즈는 100원 단위로 입력해 주세요.');

  // 새 라운드가 시작되면 하한은 기본 배팅금으로 돌아간다.
  const fresh = pokerRoom();
  assert.equal(fresh.room.stateFor(fresh.a.playerId).minRaise, 100,
    '새 라운드에서는 하한이 기본 배팅금으로 초기화되어야 합니다.');
  console.log('포커 레이즈 하한: 직전 레이즈 미만 거절·같은 금액 허용·라운드마다 초기화 통과');
}

function testBlackjack() {
  const room = createBlackjackRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
  const [a] = seat(room, ['A', 'B', 'C']);
  assert.equal(room.begin(a.playerId), null);
  const state = () => room.stateFor(a.playerId);

  // 블랙잭은 카드 선택(playing) 단계를 지나야 배팅이 열린다. 전원 스탠드로 넘긴다.
  let guard = 0;
  while (state().phase === 'playing' && guard < 20) {
    assert.equal(room.stand(state().turnPlayerId), null);
    guard += 1;
  }
  assert.equal(state().phase, 'betting', '전원 스탠드 뒤에는 배팅 단계여야 합니다.');

  assert.equal(state().minRaise, 100, '첫 레이즈 하한은 기본 배팅금이어야 합니다.');
  assert.equal(room.raise(state().turnPlayerId, 3000), null);
  assert.equal(state().minRaise, 3000);
  assert.equal(room.raise(state().turnPlayerId, 2900), '레이즈는 직전 레이즈 금액인 3,000원 이상이어야 합니다.');
  assert.equal(room.raise(state().turnPlayerId, 3000), null, '하한과 같은 금액은 허용해야 합니다.');
  console.log('블랙잭 레이즈 하한: 직전 레이즈 미만 거절·같은 금액 허용 통과');
}

testPoker();
testBlackjack();
