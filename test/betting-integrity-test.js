'use strict';

/**
 * 판돈이 엉뚱한 사람에게 넘어가는 네 가지 경로.
 *
 *   1. 둘 다 올인했다가 비기면 재대결이 붙는데, 재대결은 새 배팅부터 시작한다. 칩이
 *      0원인 사람은 콜·올인·레이즈가 전부 거절되어 폴드밖에 못 했고, 가만있어도
 *      제한시간에 자동 폴드되었다. 먼저 차례가 온 쪽이 팟을 통째로 잃었다.
 *   2. A 올인 → B 콜 → C가 자기 차례에 나가면, 배팅은 이미 끝났는데 종료 판정을
 *      건너뛰고 차례가 올인한 A에게 갔다. A는 할 수 있는 게 없어 자동 폴드되었다.
 *   3. 올인하고 기다리는 사람은 1초만 끊겨도 폴드되었다. 더 정할 것이 없는데도.
 *   4. 블랙잭은 21을 넘은 사실을 본인만 알아야 블러핑이 되는데, 모두가 보는 기록에
 *      "21을 넘었지만"이 찍혔다.
 *
 * 어느 경우든 방 전체의 칩 + 팟은 시작 총액과 같아야 한다.
 */

const assert = require('assert');
const { createPokerRoom, INITIAL_CHIPS } = require('../web/poker-room');
const { createBlackjackRoom } = require('../web/blackjack-room');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

/** 칩 총액. 끊긴 채 판에 남은 사람도 세야 하므로 목록 대신 모든 참가자의 칩을 받는다. */
const total = (chips, pot) => chips.reduce((a, b) => a + b, 0) + pot;

function seat(make, names, extra) {
  const room = make(Object.assign({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 }, extra || {}));
  const joined = names.map((nickname) => room.join({ nickname }));
  for (const p of joined) room.setReady(p.playerId, true);
  assert.equal(room.begin(joined[0].playerId), null);
  return { room, joined, ids: joined.map((p) => p.playerId) };
}

/** 블랙잭은 카드 선택을 끝내야 배팅이 시작된다. */
function skipToBetting(room, viewerId) {
  for (let guard = 0; guard < 20 && room.stateFor(viewerId).phase === 'playing'; guard += 1) {
    room.stand(room.stateFor(viewerId).turnPlayerId);
  }
  assert.equal(room.stateFor(viewerId).phase, 'betting');
}

// ─────────────────────────────── 1 ───────────────────────────────

function testAllInTieRematch() {
  console.log('\n=== 1. 둘 다 올인했다가 비기면 ===');
  // 동점은 카드 운이라 나올 때까지 판을 새로 연다(한 판에 약 6%).
  for (let attempt = 1; attempt <= 3000; attempt += 1) {
    const { room, ids } = seat(createPokerRoom, ['갑', '을']);
    const view = () => room.stateFor(ids[0]);
    const start = total(view().players.map((p) => p.chips), view().pot);
    room.allin(view().turnPlayerId);
    room.allin(view().turnPlayerId);
    const tied = view().history.some((h) => h.text.includes('재대결'));
    if (!tied) { room.dispose(); continue; }

    const end = view();
    check(`(${attempt}번째 판에서 동점) 칩이 없는 재대결은 배팅 없이 결판이 난다`,
      end.phase === 'result', `단계 ${end.phase}`);
    check('아무도 폴드로 팟을 잃지 않았다',
      !end.history.some((h) => h.text.includes('폴드')), end.history.map((h) => h.text).join(' / '));
    check('결과가 카드 비교로 났다(또는 카드가 모자라 환불)',
      !!end.result && (end.result.revealed === true || end.result.noWinner === true), JSON.stringify(end.result));
    check('칩 총액이 그대로다', total(end.players.map((p) => p.chips), end.pot) === start);
    room.dispose();
    return;
  }
  check('동점이 한 번은 나와야 검사할 수 있다', false, '3000판 동안 동점 없음');
}

// ─────────────────────────────── 2 ───────────────────────────────

async function testLeaveAfterAllInAndCall(game, make, how) {
  const { room, ids } = seat(make, ['A', 'B', 'C'], { actionTimeoutMs: 150 });
  if (game === '블랙잭') skipToBetting(room, ids[0]);
  const view = () => room.stateFor(ids[0]);
  const start = INITIAL_CHIPS * 3;
  const shover = view().turnPlayerId; room.allin(shover);
  const caller = view().turnPlayerId; room.call(caller);
  const leaver = view().turnPlayerId;
  if (how === '끊김') room.disconnect(leaver); else room.leave(leaver);

  const now = view();
  check(`${game}/${how}: 배팅이 이미 끝났으니 곧바로 결과로 간다`, now.phase === 'result', `단계 ${now.phase}`);
  await wait(400); // 예전에는 여기서 올인한 사람이 제한시간에 걸려 자동 폴드됐다
  const later = view();
  check(`${game}/${how}: 올인한 사람이 자동 폴드되지 않았다`,
    !later.history.some((h) => h.text.includes('자동 폴드')), later.history.slice(-3).map((h) => h.text).join(' / '));
  check(`${game}/${how}: 결과가 카드 비교로 났다`,
    !!later.result && (later.result.revealed !== false || later.result.noWinner === true), JSON.stringify(later.result));
  if (how === '끊김') {
    // 끊긴 C는 폴드되어 목록에서 빠져 있다. C는 한 푼도 내지 않았으므로 시작 칩 그대로다.
    const chips = later.players.map((p) => p.chips).concat(INITIAL_CHIPS);
    check(`${game}/${how}: 칩 총액이 그대로다`, total(chips, later.pot) === start,
      `${total(chips, later.pot)} vs ${start}`);
  }
  room.dispose();
}

// ─────────────────────────────── 3 ───────────────────────────────

async function testAllInPlayerBlips(game, make) {
  // 유예를 짧게 잡아, "유예가 지나도 판이 끝날 때까지는 자리가 남는가"까지 본다.
  const { room, joined, ids } = seat(make, ['A', 'B', 'C'], { disconnectGraceMs: 60 });
  if (game === '블랙잭') skipToBetting(room, ids[1]);
  const view = (id) => room.stateFor(id || ids[1]);
  const shover = view().turnPlayerId;
  const token = joined.find((p) => p.playerId === shover).token;
  const others = ids.filter((id) => id !== shover);
  const watcher = others[0];
  room.allin(shover);

  room.disconnect(shover);
  const seen = view(watcher).players.find((p) => p.id === shover);
  check(`${game}: 올인한 사람이 끊겨도 폴드되지 않는다`, !!seen && !seen.isFolded && seen.isAllIn,
    JSON.stringify(seen));
  check(`${game}: 남은 사람 화면에 끊겼다고 보인다`, !!seen && seen.connected === false);

  await wait(200); // 유예(60ms)가 지났다. 그래도 판이 끝날 때까지는 판에 남아야 한다.
  const still = view(watcher).players.find((p) => p.id === shover);
  check(`${game}: 유예가 지나도 판이 끝날 때까지 자리가 남는다`, !!still && !still.isFolded);

  // 나머지가 받는다. 올인한 사람도 카드 비교에 들어가야 한다.
  for (const id of others) {
    if (view(watcher).phase !== 'betting') break;
    if (view(watcher).turnPlayerId === id) room.call(id);
  }
  if (view(watcher).phase === 'betting') room.call(view(watcher).turnPlayerId);
  const end = view(watcher);
  check(`${game}: 판이 카드 비교로 끝났다`, end.phase === 'result'
    && (end.result.revealed !== false || end.result.noWinner === true), JSON.stringify(end.result));
  // 나머지 둘이 더 높은 숫자로 비기면 재대결은 그 둘만 한다. 그러면 끊긴 사람은 이미
  // 진 것이라 판에서 빠지고 목록에도 없다 - 올인했으니 남은 칩은 0원이다.
  const wonOrLost = end.players.find((p) => p.id === shover);
  const chipsAtEnd = wonOrLost ? wonOrLost.chips : 0;

  await wait(200); // 판이 끝났으니 이제 자리가 정리된다
  check(`${game}: 판이 끝난 뒤에는 끊긴 자리가 정리된다`,
    !view(watcher).players.some((p) => p.id === shover));
  const back = room.join({ nickname: 'A', token });
  const mine = room.stateFor(back.playerId).players.find((p) => p.id === back.playerId);
  check(`${game}: 돌아오면 판 결과가 반영된 칩을 그대로 돌려받는다`,
    !!mine && mine.chips === chipsAtEnd, `${mine && mine.chips} vs ${chipsAtEnd}`);
  room.dispose();
}

async function testAllInExplicitLeaveStillForfeits() {
  // 스스로 나가기를 누른 것은 포기다. 끊김과 달리 폴드로 처리하는 게 맞다.
  const { room, ids } = seat(createPokerRoom, ['A', 'B', 'C']);
  const view = () => room.stateFor(ids[1]);
  const shover = view().turnPlayerId;
  room.allin(shover);
  room.leave(shover);
  check('포커: 올인하고 스스로 나가면 폴드(포기)로 처리한다',
    view().history.some((h) => h.text.includes('방을 나가 폴드')));
  room.dispose();
}

// ─────────────────────────────── 4 ───────────────────────────────

function testBustStaysPrivate() {
  console.log('\n=== 4. 블랙잭 21 초과는 본인만 안다 ===');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { room, ids } = seat(createBlackjackRoom, ['갑', '을']);
    const hitter = room.stateFor(ids[0]).turnPlayerId;
    const other = ids.find((id) => id !== hitter);
    for (let i = 0; i < 6; i += 1) room.hit(hitter);
    const mine = room.stateFor(hitter).players.find((p) => p.id === hitter);
    if (!mine.isBusted) { room.dispose(); continue; }

    const seen = room.stateFor(other);
    check('본인 화면에는 21 초과가 보인다', mine.isBusted === true);
    check('상대 화면의 참가자 정보에는 보이지 않는다',
      seen.players.find((p) => p.id === hitter).isBusted === false);
    check('상대가 보는 기록에도 드러나지 않는다',
      !seen.history.some((h) => /21을 넘|초과/.test(h.text)), seen.history.map((h) => h.text).join(' / '));
    room.dispose();
    return;
  }
  check('21 초과가 한 번은 나와야 검사할 수 있다', false);
}

async function main() {
  testAllInTieRematch();

  console.log('\n=== 2. 올인·콜 뒤 차례인 사람이 나가면 ===');
  for (const [game, make] of [['포커', createPokerRoom], ['블랙잭', createBlackjackRoom]]) {
    for (const how of ['나가기', '끊김']) await testLeaveAfterAllInAndCall(game, make, how);
  }

  console.log('\n=== 3. 올인하고 기다리던 사람이 잠깐 끊기면 ===');
  await testAllInPlayerBlips('포커', createPokerRoom);
  await testAllInPlayerBlips('블랙잭', createBlackjackRoom);
  await testAllInExplicitLeaveStillForfeits();

  testBustStaysPrivate();

  console.log(`\n배팅 무결성: ${pass}개 통과, ${fail}개 실패`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
