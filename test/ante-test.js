'use strict';

/**
 * [규칙] 앤티 - 판을 시작할 때 참가자 전원이 기본 배팅금을 먼저 팟에 낸다.
 *
 * 예전에는 아무도 미리 내지 않았다. 기본 배팅금은 "계속하려면 최소 이만큼"이라는
 * 콜 기준일 뿐이라, 첫 차례에 폴드하면 0원을 잃었고 폴드로 이긴 사람은 자기가 낸
 * 돈만 돌려받았다. 기본 배팅금을 투표로 올려도 폴드가 나오면 아무 의미가 없었다.
 *
 *   - 폴드하면 이미 낸 앤티를 잃고, 폴드로 이긴 사람은 모두의 앤티를 가져간다
 *   - 칩이 기본 배팅금보다 적은 사람은 가진 만큼 내고 올인한다(올인 상한 규칙 그대로)
 *   - 포커 동점 재대결은 팟이 이미 있으니 다시 걷지 않는다
 *   - 앤티를 낸 뒤 더 낼 것이 없으면 "체크"다
 * 어느 경우든 방 전체의 칩 + 팟은 시작 총액과 같아야 한다.
 */

const assert = require('assert');
const { createPokerRoom, INITIAL_CHIPS } = require('../web/poker-room');
const { createBlackjackRoom } = require('../web/blackjack-room');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const total = (s) => s.players.reduce((sum, p) => sum + p.chips, 0) + s.pot;

/** 방을 열고, 필요하면 투표로 기본 배팅금을 바꾼 뒤 판을 시작한다. */
function open(make, names, baseBet, extra) {
  const room = make(Object.assign({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0 }, extra || {}));
  const joined = names.map((nickname) => room.join({ nickname }));
  const ids = joined.map((p) => p.playerId);
  if (baseBet) {
    const propose = room.setBaseBet || room.proposeBaseBet;
    assert.equal(propose(ids[0], baseBet), null);
    const proposal = room.stateFor(ids[1]).baseBetProposal;
    for (const id of ids.slice(1)) room.voteBaseBet(id, proposal.id, true);
    assert.equal(room.stateFor(ids[0]).baseBet, baseBet, '투표로 기본 배팅금이 바뀌어야 합니다.');
  }
  const view = (id) => room.stateFor(id || ids[0]);
  const chipsOf = (id) => view().players.find((p) => p.id === id).chips;
  return { room, ids, view, chipsOf };
}
function start(room, ids) {
  for (const id of ids) room.setReady(id, true);
  assert.equal(room.begin(ids[0]), null);
}

function testPokerAnte() {
  console.log('\n=== 포커 ===');
  const { room, ids, view, chipsOf } = open(createPokerRoom, ['A', 'B', 'C'], 1000);
  start(room, ids);
  const s = view();
  check('시작하자마자 전원의 앤티가 팟에 있다', s.pot === 3000, `팟 ${s.pot}`);
  check('각자 앤티만큼 칩이 줄었다', ids.every((id) => chipsOf(id) === INITIAL_CHIPS - 1000));
  check('더 낼 것이 없으니 첫 행동은 체크(0원)다', s.currentBet - s.players.find((p) => p.id === s.turnPlayerId).roundBet === 0);
  check('체크 기록이 남는다', room.call(s.turnPlayerId) === null && view().history.some((h) => h.text.includes('체크')));

  const folder = view().turnPlayerId;
  room.fold(folder);
  check('폴드하면 앤티를 잃는다', chipsOf(folder) === INITIAL_CHIPS - 1000, `${chipsOf(folder)}`);
  const last = view().turnPlayerId;
  room.fold(last);
  const end = view();
  const winner = end.result.winnerId;
  check('폴드로 이긴 사람이 모두의 앤티를 가져간다',
    end.result.amount === 3000 && chipsOf(winner) === INITIAL_CHIPS + 2000, JSON.stringify(end.result));
  check('칩 총액이 그대로다', total(end) === INITIAL_CHIPS * 3);
  room.dispose();
}

function testPokerFirstFold() {
  // 제보 그대로: 기본 배팅금을 투표로 올리고, 첫 차례에 바로 폴드한다.
  const { room, ids, view, chipsOf } = open(createPokerRoom, ['A', 'B'], 1000);
  start(room, ids);
  const folder = view().turnPlayerId;
  const other = ids.find((id) => id !== folder);
  room.fold(folder);
  check('[제보] 첫 차례에 폴드해도 앤티 1,000원을 잃는다', chipsOf(folder) === INITIAL_CHIPS - 1000);
  check('[제보] 상대는 1,000원을 번다 (자기 돈만 돌려받지 않는다)', chipsOf(other) === INITIAL_CHIPS + 1000,
    `${chipsOf(other) - INITIAL_CHIPS}원`);
  room.dispose();
}

function testPokerRaiseOnTopOfAnte() {
  const { room, ids, view } = open(createPokerRoom, ['A', 'B']);
  start(room, ids);
  const raiser = view().turnPlayerId;
  assert.equal(room.raise(raiser, 500), null);
  const caller = view().turnPlayerId;
  const need = view().currentBet - view().players.find((p) => p.id === caller).roundBet;
  check('앤티 위에 레이즈하면 상대는 레이즈한 만큼만 더 낸다', need === 500, `${need}원`);
  room.call(caller);
  // 콜과 함께 판이 끝나 팟은 이긴 사람에게 넘어간다(비기면 재대결로 팟이 그대로 남는다).
  const s = view();
  const pot = s.result ? s.result.amount : s.pot;
  check('판돈 = 앤티 100 × 2 + 레이즈 500 × 2', pot === 1200, `${pot}원`);
  room.dispose();
}

/** 칩이 기본 배팅금보다 적은 사람: 가진 만큼만 내고 올인. 배팅이 멈추지 않아야 한다. */
function testPokerShortAnte() {
  const { room, ids, view, chipsOf } = open(createPokerRoom, ['A', 'B'], 1000);
  // 한 명을 0원으로 만든다(둘 다 올인 → 한 명이 다 가져간다).
  for (let tries = 0; tries < 20; tries += 1) {
    if (view().phase !== 'betting') start(room, ids);
    for (let i = 0; i < 6 && view().phase === 'betting'; i += 1) room.allin(view().turnPlayerId);
    if (ids.some((id) => chipsOf(id) === 0)) break;
  }
  const broke = ids.find((id) => chipsOf(id) === 0);
  const rich = ids.find((id) => id !== broke);
  assert.ok(broke, '한 명이 0원이 되어야 합니다.');
  assert.equal(room.donate(rich, broke, 300), null);
  const startTotal = total(view());
  start(room, ids);
  const short = view().players.find((p) => p.id === broke);
  check('칩이 모자란 사람은 가진 300원만 내고 올인한다', short.roundBet === 300 && short.chips === 0 && short.isAllIn,
    JSON.stringify(short));
  const big = view().players.find((p) => p.id === rich);
  check('상대의 앤티도 300원까지로 맞춰진다(못 받을 몫은 돌려준다)', big.roundBet === 300, `${big.roundBet}`);
  check('올인한 사람에게 차례가 가지 않는다', view().turnPlayerId === rich, view().turnPlayerId);
  check('남은 사람이 체크하면 곧바로 결판이 난다', room.call(rich) === null && view().phase !== 'betting', view().phase);
  check('칩 총액이 그대로다', total(view()) === startTotal);
  room.dispose();
}

function testPokerTieRematchNoSecondAnte() {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    const { room, ids, view } = open(createPokerRoom, ['A', 'B']);
    start(room, ids);
    room.call(view().turnPlayerId);
    room.call(view().turnPlayerId);
    if (!view().history.some((h) => h.text.includes('재대결'))) { room.dispose(); continue; }
    const s = view();
    check('재대결에서는 앤티를 다시 걷지 않는다(팟 그대로)', s.pot === 200, `팟 ${s.pot}`);
    check('재대결 첫 행동은 체크(0원)다', s.currentBet === 0, `currentBet ${s.currentBet}`);
    room.dispose();
    return;
  }
  check('동점이 한 번은 나와야 검사할 수 있다', false);
}

async function testBlackjackAnte() {
  console.log('\n=== 블랙잭 ===');
  const { room, ids, view } = open(createBlackjackRoom, ['A', 'B', 'C'], 1000, { disconnectGraceMs: 20 });
  start(room, ids);
  check('카드를 고르기 전에 앤티가 걷힌다', view().phase === 'playing' && view().pot === 3000, `${view().phase} 팟 ${view().pot}`);
  // 카드 선택 중에 한 명이 끊겨 돌아오지 않으면 제외된다 - 낸 앤티는 팟에 남는다.
  const gone = view().turnPlayerId;
  room.disconnect(gone);
  await new Promise((resolve) => setTimeout(resolve, 80));
  for (let i = 0; i < 6 && view(ids.find((id) => id !== gone)).phase === 'playing'; i += 1) {
    room.stand(view(ids.find((id) => id !== gone)).turnPlayerId);
  }
  const watcher = ids.find((id) => id !== gone);
  const s = view(watcher);
  check('배팅 첫 행동은 체크(0원)다', s.phase === 'betting'
    && s.currentBet - s.players.find((p) => p.id === s.turnPlayerId).roundBet === 0, s.phase);
  const folder = s.turnPlayerId;
  room.fold(folder);
  const end = view(watcher);
  const winner = end.result && end.result.winnerId;
  check('폴드한 사람은 앤티를 잃는다', end.players.find((p) => p.id === folder).chips === INITIAL_CHIPS - 1000);
  check('이긴 사람이 끊긴 사람 몫까지 앤티 3,000원을 가져간다', end.result.amount === 3000
    && end.players.find((p) => p.id === winner).chips === INITIAL_CHIPS + 2000, JSON.stringify(end.result));
  room.dispose();
}

testPokerAnte();
testPokerFirstFold();
testPokerRaiseOnTopOfAnte();
testPokerShortAnte();
testPokerTieRematchNoSecondAnte();
testBlackjackAnte().then(() => {
  console.log(`\n앤티: ${pass}개 통과, ${fail}개 실패`);
  if (fail) process.exit(1);
}).catch((e) => { console.error(e); process.exit(1); });
