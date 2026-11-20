'use strict';

/**
 * "다음 판 참가하기": 판이 진행 중일 때 들어온(이번 판을 안 뛰는) 사람이 미리 다음 판 참가(준비)를 눌러 둘 수 있다.
 * 카드 게임 일곱 개(포커·블랙잭·홀덤·더 마인드·갈팡질팡·야추다이스·클루)를 같은 기준으로 본다.
 *
 *   - 판 도중에 들어온 사람은 setReady(true)가 받아들여지고, 상태의 you.ready에 반영된다.
 *   - 이번 판을 뛰는 사람은 여전히 판이 끝난 뒤에만 바꿀 수 있다(기존 규칙).
 *   - 판이 끝나도 미리 눌러 둔 준비는 사라지지 않고, 뛴 사람의 자동 준비와 함께 이어진다.
 *   - 화면(public/join-next.js)이 쓰는 you.inRound/inGame 필드가 안 뛰는 사람에게 false로 온다.
 *
 * 실행: node test/join-next-test.js
 */

const { createPokerRoom } = require('../web/poker-room');
const { createBlackjackRoom } = require('../web/blackjack-room');
const { createHoldemRoom } = require('../web/holdem-room');
const { createMindRoom } = require('../web/mind-room');
const { createGalpangRoom } = require('../web/galpang-room');
const { createYachtRoom } = require('../web/yacht-room');
const { createClueRoom } = require('../web/clue-room');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

/** n명이 입장·준비·시작한 방. 시작 뒤에 late(중간 입장자)를 하나 더 들인다. */
function startRoom(create, count, options) {
  const room = create({ onChange() {}, onAction() {}, ...(options || {}) });
  const ids = [];
  for (let i = 0; i < count; i += 1) ids.push(room.join({ nickname: `참가${i + 1}` }).playerId);
  for (const id of ids) room.setReady(id, true);
  const error = room.begin(ids[0]);
  const late = room.join({ nickname: '중간입장' }).playerId;
  return { room, ids, late, error };
}
const you = (room, id) => room.stateFor(id).you;
const inPlay = (state) => (typeof state.inRound === 'boolean' ? state.inRound : state.inGame);

const GAMES = [
  ['포커', createPokerRoom, 2],
  ['블랙잭', createBlackjackRoom, 2],
  ['홀덤', createHoldemRoom, 2],
  ['더 마인드', createMindRoom, 2],
  ['야추다이스', createYachtRoom, 2],
  ['클루', createClueRoom, 2],
];

for (const [name, create, count] of GAMES) {
  console.log(`\n=== ${name} ===`);
  const g = startRoom(create, count);
  check('판이 시작된다', g.error === null);
  check('중간에 들어온 사람은 이번 판을 뛰지 않는 것으로 온다(화면이 버튼을 띄우는 기준)', inPlay(you(g.room, g.late)) === false && inPlay(you(g.room, g.ids[0])) === true);
  check('중간 입장자는 진행 중에도 다음 판 참가를 눌러 둘 수 있다', g.room.setReady(g.late, true) === null && you(g.room, g.late).ready === true);
  check('누른 것을 취소할 수도 있다', g.room.setReady(g.late, false) === null && you(g.room, g.late).ready === false);
  check('이번 판을 뛰는 사람은 여전히 진행 중에 바꿀 수 없다', typeof g.room.setReady(g.ids[0], false) === 'string');
  check('모르는 참가자는 거절된다', typeof g.room.setReady('nobody', true) === 'string');
  g.room.setReady(g.late, true);
  if (g.room.dispose) g.room.dispose();
}

// 판이 끝나도 미리 눌러 둔 준비가 이어지는지: 끝내기 쉬운 게임으로 본다.
console.log('\n=== 판이 끝난 뒤에도 이어진다 ===');
{
  const g = startRoom(createClueRoom, 2, { autoEndMs: 0 });
  g.room.setReady(g.late, true);
  const d = g.room._debug();
  d.setSolution({ suspect: 'green', weapon: 'rope', room: 'kitchen' });
  const turnSeat = d.seats[d.turn];
  d.setPosition(turnSeat.suspect, { room: 'envelope' });
  check('클루: 정답을 맞혀 판을 끝낸다', g.room.accuse(turnSeat.id, 'green', 'rope', 'kitchen') === null && g.room.stateFor(g.late).phase === 'result');
  check('클루: 미리 눌러 둔 사람과 뛴 사람이 모두 준비된 상태가 된다', you(g.room, g.late).ready === true && d.seats.every((s) => you(g.room, s.id).ready === true) && g.room.stateFor(g.late).readyCount === 3);
  check('클루: 준비 안 하고 구경만 한 사람은 준비되지 않는다', (() => {
    const other = createClueRoom({ onChange() {}, onAction() {}, autoEndMs: 0 });
    const ids = ['가', '나'].map((n) => other.join({ nickname: n }).playerId);
    ids.forEach((id) => other.setReady(id, true));
    other.begin(ids[0]);
    const watcher = other.join({ nickname: '구경' }).playerId;
    const od = other._debug();
    const seat = od.seats[od.turn];
    od.setSolution({ suspect: 'green', weapon: 'rope', room: 'kitchen' });
    od.setPosition(seat.suspect, { room: 'envelope' });
    other.accuse(seat.id, 'green', 'rope', 'kitchen');
    const ok = other.stateFor(watcher).you.ready === false && other.stateFor(watcher).readyCount === 2;
    other.dispose();
    return ok;
  })());
  g.room.dispose();
}
{
  const g = startRoom(createYachtRoom, 2, { turnTimeoutMs: 0 });
  g.room.setReady(g.late, true);
  // 12칸을 모두 채워 판을 끝낸다
  for (let round = 0; round < 24 && g.room.stateFor(g.late).phase === 'playing'; round += 1) {
    const live = g.room._debug(); // 차례 번호는 값이라 매번 다시 가져온다
    const turnSeat = live.seats[live.turn];
    g.room.roll(turnSeat.id);
    const open = g.room.stateFor(turnSeat.id).you.options;
    g.room.score(turnSeat.id, Object.keys(open)[0]);
  }
  check('야추다이스: 판이 끝나면 미리 눌러 둔 사람도 준비된 상태로 이어진다', g.room.stateFor(g.late).phase === 'result' && you(g.room, g.late).ready === true && g.room.stateFor(g.late).readyCount === 3);
  g.room.dispose();
}
{
  // 포커: 한 명이 폴드하면 판이 끝난다
  const g = startRoom(createPokerRoom, 2);
  g.room.setReady(g.late, true);
  const turnId = g.room.stateFor(g.ids[0]).turnPlayerId;
  g.room.fold(turnId);
  check('포커: 판이 끝나면 미리 눌러 둔 사람도 준비된 상태로 이어진다', g.room.stateFor(g.late).phase === 'result' && you(g.room, g.late).ready === true);
  if (g.room.dispose) g.room.dispose();
}

// 갈팡질팡은 진행 중 규칙만 본다(끝내려면 정답을 맞혀야 해서 판을 끝까지 돌리지 않는다)
console.log('\n=== 갈팡질팡 ===');
{
  const room = createGalpangRoom({ onChange() {}, onAction() {}, seed: 1 });
  const a = room.join({ nickname: '가' }).playerId;
  const b = room.join({ nickname: '나' }).playerId;
  room.setReady(a, true); room.setReady(b, true);
  check('판이 시작된다', room.begin(a) === null && room.status().phase === 'playing');
  const late = room.join({ nickname: '중간입장' }).playerId;
  const view = room.stateFor(late).you;
  check('중간에 들어온 사람은 이번 판을 뛰지 않는 것으로 온다', view.inGame === false && room.stateFor(a).you.inGame === true);
  check('중간 입장자는 진행 중에도 다음 판 참가를 눌러 둘 수 있다', room.setReady(late, true) === null && room.stateFor(late).you.ready === true);
  check('이번 판을 뛰는 사람은 여전히 진행 중에 바꿀 수 없다', typeof room.setReady(a, false) === 'string');
  if (room.dispose) room.dispose();
}

console.log(`\n다음 판 참가하기: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
