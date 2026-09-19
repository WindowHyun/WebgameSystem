'use strict';

/**
 * [규칙] 동점 재대결이 폴드한 사람의 카드를 지우면 안 된다.
 *
 * 인디언 포커는 라운드가 끝나면 폴드한 사람의 카드까지 전부 공개한다 - 숨길 이유가
 * 더 없기 때문이다. 그런데 남은 두 사람이 같은 숫자를 뽑아 재대결로 넘어가면,
 * startBetting()이 "이번 판에 안 뛰는 사람"의 카드를 지우면서 폴드한 사람의 카드까지
 * 같이 없앴다. 그래서 결과 화면에서 그 자리만 텅 비어 보였다.
 *
 * 52장에서 두 사람이 같은 숫자를 뽑을 확률은 3/51 ≈ 5.9%다. 카드가 무작위라 동점이
 * 날 때까지 판을 돌려 보고, 실제로 동점이 난 판에서만 확인한다.
 */

const assert = require('assert');
const { createPokerRoom } = require('../web/poker-room');

const MAX_TRIES = 600;

/** 한 판을 돌린다. 동점 재대결이 일어나면 그 상황을 돌려주고, 아니면 null. */
function playUntilTie() {
  const room = createPokerRoom({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
  const seats = ['A', 'B', 'C'].map((name) => room.join({ nickname: name }));
  for (const seat of seats) room.setReady(seat.playerId, true);
  assert.equal(room.begin(seats[0].playerId), null);

  // 차례인 사람이 폴드한다. 이 사람의 카드가 끝까지 남아 있어야 한다.
  const view = () => room.stateFor(seats[0].playerId);
  const foldedId = view().turnPlayerId;
  assert.equal(room.fold(foldedId), null);

  // 남은 두 사람이 콜로 맞춰 쇼다운까지 간다. 동점이면 방이 "재대결" 기록을 남긴다.
  const rematched = () => view().history.some((item) => item.text.includes('재대결'));
  for (let guard = 0; guard < 12 && view().phase === 'betting'; guard += 1) {
    const turnId = view().turnPlayerId;
    if (!turnId || turnId === foldedId) break;
    if (room.call(turnId) !== null) break;
    if (rematched()) return { room, seats, foldedId, view };
  }
  return rematched() ? { room, seats, foldedId, view } : null;
}

function main() {
  let found = null;
  for (let attempt = 0; attempt < MAX_TRIES && !found; attempt += 1) found = playUntilTie();
  assert.ok(found, `${MAX_TRIES}판을 돌려도 동점 재대결이 나오지 않았습니다. 테스트를 의심해 주세요.`);

  const { room, seats, foldedId, view } = found;

  // 재대결이 진행 중인 동안에도 폴드한 사람의 카드는 자리에 남아 있어야 한다.
  const during = view().players.find((p) => p.id === foldedId);
  assert.ok(during.card, '동점 재대결 중에 폴드한 사람의 카드가 사라졌습니다.');
  assert.equal(during.isFolded, true, '폴드한 사람은 재대결 참가자가 아니어야 합니다.');

  // 폴드한 사람도 이 판의 참가자였으므로 재대결 테이블을 계속 볼 수 있어야 한다.
  // 예전에는 재대결이 시작되는 순간 참가자 명단이 동점자 둘로 줄면서, 폴드한 사람의
  // 화면에서 남의 카드가 전부 가려졌다(자기 카드만 빼고 보이는 게 이 게임의 규칙이다).
  const foldedView = room.stateFor(foldedId);
  assert.equal(foldedView.you.inRound, true,
    '폴드해도 이번 판 참가자이므로 중도 입장자("다음 판 대기")로 취급하면 안 됩니다.');
  const others = foldedView.players.filter((p) => p.id !== foldedId && p.card);
  assert.ok(others.length >= 2, '재대결 중인 두 사람의 카드가 자리에 있어야 합니다.');
  assert.ok(others.every((p) => !p.card.hidden),
    '폴드한 사람에게도 재대결 중인 사람들의 카드가 보여야 합니다.');
  assert.equal(foldedView.players.find((p) => p.id === foldedId).card.hidden, true,
    '자기 카드는 라운드가 끝나기 전까지 자신에게 보이면 안 됩니다.');

  // 재대결을 끝까지 굴린다.
  for (let guard = 0; guard < 24 && view().phase === 'betting'; guard += 1) {
    const turnId = view().turnPlayerId;
    if (!turnId) break;
    if (room.call(turnId) !== null) break;
  }

  const end = view();
  if (end.phase !== 'result') {
    // 재대결이 또 동점이면 다시 betting이다. 그 경우에도 카드는 남아 있어야 한다.
    assert.ok(end.players.find((p) => p.id === foldedId).card,
      '재대결이 거듭돼도 폴드한 사람의 카드는 남아 있어야 합니다.');
    console.log('동점 재대결: 폴드한 사람의 카드가 재대결 내내 유지된다 (연속 동점까지 확인) 통과');
    return;
  }

  const folded = end.players.find((p) => p.id === foldedId);
  assert.ok(folded.card, '라운드가 끝났는데 폴드한 사람의 카드가 사라졌습니다.');
  assert.ok(!folded.card.hidden, '라운드가 끝나면 폴드한 사람의 카드도 공개되어야 합니다.');

  // 재대결에 참가한 두 사람의 카드도 함께 공개된다.
  const shown = end.players.filter((p) => p.card && !p.card.hidden).length;
  assert.equal(shown, seats.length, `결과 화면에는 세 사람의 카드가 모두 보여야 합니다. (보인 카드 ${shown}장)`);

  console.log('동점 재대결: 폴드한 사람의 카드가 지워지지 않고 결과에서 함께 공개된다 통과');
}

main();
