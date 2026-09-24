'use strict';

/**
 * [이슈] 카드 게임에서 끊기거나 나가도 돈이 엉뚱하게 사라지지 않는가.
 *
 *   1. 잠깐 끊겨도(새로고침·폰 화면 잠금·와이파이 전환) 곧바로 폴드되지 않는다.
 *      예전에는 끊기는 순간 폴드해서, 50만 원을 콜해 둔 사람이 자기 차례도 아닌데
 *      새로고침 한 번에 건 돈을 전부 잃었다. 이제 자리 유예 동안 돌아오면 그대로 이어서
 *      하고, 돌아오지 않으면 그때 폴드한다. 올인한 사람은 판이 끝날 때까지 남는다.
 *   2. 판이 승자 없이 무효로 끝나 돌려줄 때(블랙잭 "모두 21 초과" 등), 중간에 떠난 사람의
 *      몫도 돌려준다. 예전에는 남은 사람만 돌려받고 떠난 사람의 앤티는 사라졌다.
 *   3. 나갔다 같은 토큰으로 돌아오면 칩을 그대로 되찾는다(보관 칩).
 *   4. 블랙잭 카드 선택 중 이미 스탠드한 사람의 자리가 정리돼도 차례가 밀리지 않는다.
 *
 * 어느 경우든 방 전체의 칩 + 팟 + 보관 칩은 시작 총액과 같아야 한다.
 */

const { createPokerRoom, INITIAL_CHIPS } = require('../web/poker-room');
const { createBlackjackRoom } = require('../web/blackjack-room');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const GRACE = 60;
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

function seat(make, names, extra) {
  const room = make(Object.assign({ onChange() {}, actionTimeoutMs: 0, proposalTimeoutMs: 0, disconnectGraceMs: GRACE }, extra || {}));
  const joined = names.map((nickname) => room.join({ nickname }));
  return { room, joined, ids: joined.map((p) => p.playerId) };
}
function setBaseBet(room, ids, amount) {
  (room.setBaseBet || room.proposeBaseBet)(ids[0], amount);
  const proposal = room.stateFor(ids[1]).baseBetProposal;
  for (const id of ids.slice(1)) room.voteBaseBet(id, proposal.id, true);
}
function start(room, ids) {
  for (const id of ids) room.setReady(id, true);
  room.begin(ids[0]);
}
const me = (room, id) => room.stateFor(id).players.find((p) => p.id === id) || { isFolded: true, roundBet: 0, chips: 0 };
const lastNote = (room, id) => room.stateFor(id).history.slice(-1)[0].text;

// ─────────────────────────────── 1 ───────────────────────────────

async function testPokerBlip() {
  console.log('\n=== 1. 포커: 잠깐 끊겼다 돌아오면 ===');
  const { room, joined, ids } = seat(createPokerRoom, ['갑', '을', '병']);
  start(room, ids);
  const view = () => room.stateFor(ids[0]);
  room.raise(view().turnPlayerId, 500000);
  const caller = view().turnPlayerId;
  room.call(caller);
  const seatOf = joined.find((p) => p.playerId === caller);
  const bet = me(room, caller).roundBet;
  room.disconnect(caller);
  const watcher = ids.find((id) => id !== caller);
  check('[제보] 콜해 둔 사람이 끊겨도 곧바로 폴드되지 않는다', (room.stateFor(watcher).players.find((p) => p.id === caller) || { isFolded: true }).isFolded === false);
  check('남은 사람에게 끊겼고 언제 폴드되는지 알린다', /연결이 끊겼습니다\. \d+초 안에 돌아오지 않으면 폴드됩니다/.test(lastNote(room, watcher)), lastNote(room, watcher));
  await wait(GRACE / 3);
  room.join({ nickname: '을', token: seatOf.token }); // 새로고침 뒤 다시 붙음
  await wait(GRACE * 2);
  const back = me(room, caller);
  check('유예 안에 돌아오면 폴드되지 않고 건 돈도 그대로다', !back.isFolded && back.roundBet === bet, JSON.stringify(back));
  // 판을 끝까지 치른다.
  for (let i = 0; i < 6 && view().phase === 'betting'; i += 1) room.call(view().turnPlayerId);
  check('판이 끝까지 진행된다', view().phase === 'result', view().phase);
  room.dispose();
}

async function testPokerGone() {
  console.log('\n=== 1. 포커: 끊긴 채 돌아오지 않으면 ===');
  const { room, ids } = seat(createPokerRoom, ['갑', '을', '병']);
  start(room, ids);
  const view = (id) => room.stateFor(id || ids[0]);
  const actor = view().turnPlayerId;
  room.disconnect(actor); // 자기 차례에 끊겼다
  const watcher = ids.find((id) => id !== actor);
  check('차례인 사람이 끊겨도 차례를 곧바로 빼앗지 않는다', view(watcher).turnPlayerId === actor);
  await wait(GRACE * 3);
  const s = view(watcher);
  check('유예가 지나도록 안 돌아오면 폴드되고 자리도 정리된다', !s.players.some((p) => p.id === actor)
    && s.history.some((h) => h.text.includes('돌아오지 않아 폴드')), s.history.slice(-3).map((h) => h.text).join(' / '));
  check('차례가 남은 사람에게 넘어가 판이 이어진다', s.phase === 'betting' && s.turnPlayerId && s.turnPlayerId !== actor, `${s.phase} ${s.turnPlayerId}`);
  const total = s.players.reduce((sum, p) => sum + p.chips, 0) + s.pot + (INITIAL_CHIPS - 100); // 떠난 사람: 앤티만 냄
  check('칩 총액이 그대로다', total === INITIAL_CHIPS * 3, `${total}`);
  room.dispose();
}

async function testBlackjackBlip() {
  console.log('\n=== 1. 블랙잭: 카드 선택 중 끊김 ===');
  {
    const { room, joined, ids } = seat(createBlackjackRoom, ['갑', '을', '병']);
    setBaseBet(room, ids, 50000);
    start(room, ids);
    const turn = room.stateFor(ids[0]).turnPlayerId;
    const waiting = joined.find((p) => p.playerId !== turn);
    room.disconnect(waiting.playerId);
    await wait(GRACE / 3);
    room.join({ nickname: 'x', token: waiting.token });
    await wait(GRACE * 2);
    check('[제보] 남의 차례에 잠깐 끊겼다 돌아오면 폴드되지 않고 앤티도 그대로다',
      !me(room, waiting.playerId).isFolded && me(room, waiting.playerId).roundBet === 50000, JSON.stringify(me(room, waiting.playerId)));
    room.dispose();
  }
}

async function testBlackjackAllInStand() {
  // 앤티로 올인한 사람: 카드 선택 중 끊겨 안 돌아오면 폴드 대신 스탠드(이미 전부 걸었다).
  // 기본 배팅금을 칩 전부(100만 원)로 올리면 모두 앤티로 올인한다.
  const { room, ids } = seat(createBlackjackRoom, ['갑', '을', '병']);
  setBaseBet(room, ids, INITIAL_CHIPS);
  start(room, ids);
  const view = (id) => room.stateFor(id || ids[0]);
  const target = ids.find((id) => id !== view().turnPlayerId);
  const watcher = ids.find((id) => id !== target);
  check('모두 앤티로 올인했다', view().players.every((p) => p.isAllIn), JSON.stringify(view().players.map((p) => p.isAllIn)));
  room.disconnect(target);
  await wait(GRACE * 3);
  const t = view(watcher).players.find((p) => p.id === target);
  check('카드 선택 중 끊긴 올인은 돌아오지 않아도 폴드가 아니라 스탠드', !!t && !t.isFolded && t.isStanding, JSON.stringify(t));
  // 나머지가 스탠드하면 판이 끝난다(모두 올인이라 배팅할 것이 없다).
  for (let i = 0; i < 6 && view(watcher).phase === 'playing'; i += 1) room.stand(view(watcher).turnPlayerId);
  check('판이 카드 비교로 끝난다', view(watcher).phase === 'result', view(watcher).phase);
  room.dispose();
}

// ─────────────────────────────── 2 ───────────────────────────────

/** 블랙잭에서 "모두 21 초과" 환불이 날 때까지 판을 새로 연다. before(room, ids, C)는 판 도중에 C를 떠나게 한다. */
async function bustRefund(label, before) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { room, joined, ids } = seat(createBlackjackRoom, ['A', 'B', 'C']);
    setBaseBet(room, ids, 10000);
    start(room, ids);
    const C = joined[2];
    const watcher = ids[0];
    const after = await before(room, C);
    for (let guard = 0; guard < 40 && room.stateFor(watcher).phase === 'playing'; guard += 1) {
      const t = room.stateFor(watcher).turnPlayerId;
      if (me(room, t).score <= 21) room.hit(t); else room.stand(t);
    }
    for (let guard = 0; guard < 6 && room.stateFor(watcher).phase === 'betting'; guard += 1) room.call(room.stateFor(watcher).turnPlayerId);
    const s = room.stateFor(watcher);
    if (!s.result || !s.result.noWinner || !/21을 초과/.test(s.result.message)) { room.dispose(); continue; }
    const back = after ? after() : room.join({ nickname: 'C', token: C.token });
    const cChips = me(room, back.playerId).chips;
    const all = room.stateFor(watcher).players.filter((p) => p.id !== back.playerId).reduce((sum, p) => sum + p.chips, 0) + cChips;
    check(`${label}: 무효 판에서 떠난 사람도 앤티를 돌려받는다`, cChips === INITIAL_CHIPS, `${cChips.toLocaleString()}`);
    check(`${label}: 칩 총액이 그대로다`, all === INITIAL_CHIPS * 3, `${all}`);
    room.dispose();
    return;
  }
  check(`${label}: "모두 21 초과"가 한 번은 나와야 검사할 수 있다`, false);
}

// ─────────────────────────────── 3·4 ───────────────────────────────

function testLeaveKeepsChips() {
  console.log('\n=== 3. 나갔다 돌아오면 ===');
  for (const [game, make] of [['포커', createPokerRoom], ['블랙잭', createBlackjackRoom]]) {
    const { room, joined, ids } = seat(make, ['갑', '을']);
    start(room, ids);
    const loserSeat = joined[1];
    room.leave(loserSeat.playerId); // 판 도중에 나가면 폴드 - 앤티를 잃는다
    const back = room.join({ nickname: '을', token: loserSeat.token });
    check(`${game}: 같은 토큰으로 돌아오면 보관해 둔 칩을 되찾는다(100만 원으로 되살아나지 않는다)`,
      me(room, back.playerId).chips === INITIAL_CHIPS - 100, `${me(room, back.playerId).chips}`);
    check(`${game}: 되찾은 자리는 같은 토큰을 쓴다(무효 판 환불에서 같은 사람임을 알아본다)`, back.token === loserSeat.token);
    room.dispose();
  }
}

async function testBlackjackDropKeepsTurn() {
  console.log('\n=== 4. 블랙잭: 스탠드한 사람의 자리가 정리돼도 ===');
  const { room, ids } = seat(createBlackjackRoom, ['A', 'B', 'C', 'D'], { actionTimeoutMs: 300 });
  const [a, b, c, d] = ids;
  start(room, ids);
  const name = (id) => (room.stateFor(d).players.find((p) => p.id === id) || {}).nickname;
  room.stand(a); room.stand(b);
  check('C 차례다', room.stateFor(d).turnPlayerId === c, name(room.stateFor(d).turnPlayerId));
  room.disconnect(a);
  await wait(GRACE * 3);
  check('[제보] 이미 스탠드한 A의 자리가 정리돼도 차례는 C 그대로다', room.stateFor(d).turnPlayerId === c, name(room.stateFor(d).turnPlayerId));
  check('C가 스탠드할 수 있다', room.stand(c) === null);
  check('그다음은 D 차례다', room.stateFor(d).turnPlayerId === d);
  await wait(500);
  check('D에게도 제한시간이 걸려 판이 멈추지 않는다', room.stateFor(d).phase !== 'playing', room.stateFor(d).phase);
  room.dispose();
}

async function main() {
  await testPokerBlip();
  await testPokerGone();
  await testBlackjackBlip();
  await testBlackjackAllInStand();
  console.log('\n=== 2. 무효 판 환불 ===');
  await bustRefund('나가기', async (room, C) => { room.leave(C.playerId); });
  await bustRefund('끊겨서 자리 정리', async (room, C) => { room.disconnect(C.playerId); await wait(GRACE * 3); });
  await bustRefund('나갔다가 판이 끝나기 전에 돌아옴', async (room, C) => {
    room.leave(C.playerId);
    const back = room.join({ nickname: 'C', token: C.token }); // 다음 판 대기로 돌아와 있다
    return () => back;
  });
  testLeaveKeepsChips();
  await testBlackjackDropKeepsTurn();
  console.log(`\n끊김·나가기 칩 보호: ${pass}개 통과, ${fail}개 실패`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
