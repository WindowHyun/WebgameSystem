'use strict';

/**
 * 자동 준비: 이전 판에 참여한 사람은 판이 끝나면 다음 판도 자동으로 준비되고,
 * 구경한 사람·새로 온 사람은 다음 판 준비를 직접 누른다. 빠지려면 준비를 취소한다.
 * (포커·블랙잭·홀덤·더 마인드·갈팡질팡)
 *
 * 실행: node test/auto-ready-test.js
 */

const { createPokerRoom } = require('../web/poker-room');
const { createBlackjackRoom } = require('../web/blackjack-room');
const { createHoldemRoom } = require('../web/holdem-room');
const { createMindRoom } = require('../web/mind-room');
const { createGalpangRoom } = require('../web/galpang-room');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

const readyOf = (room, viewer, id) => room.stateFor(viewer).players.find((p) => p.id === id).ready;

/** 카드 게임 공통: 셋이 준비해 한 판을 하고, 판 도중에 온 넷째는 구경한다. */
function cardGame(label, make, finish) {
  console.log(`\n=== ${label} ===`);
  const room = make({ onChange() {}, actionTimeoutMs: 0, peekMs: 0 });
  const [a, b, c] = ['A', 'B', 'C'].map((nickname) => room.join({ nickname }).playerId);
  for (const id of [a, b, c]) room.setReady(id, true);
  check('시작할 수 있다', room.begin(a) === null);
  const late = room.join({ nickname: '늦게온사람' }).playerId;
  check('판 도중에는 준비 상태를 바꿀 수 없다', typeof room.setReady(late, true) === 'string');

  finish(room, a);
  check('판이 끝났다', room.stateFor(a).phase === 'result');
  check('판에 참여한 사람은 자동으로 준비된다', [a, b, c].every((id) => readyOf(room, a, id) === true));
  check('판 도중에 온 사람은 준비되지 않는다', readyOf(room, a, late) === false);
  check('준비한 수가 참여자 수다', room.stateFor(a).readyCount === 3);

  check('구경한 사람이 다음 판 준비를 누를 수 있다', room.setReady(late, true) === null && readyOf(room, a, late) === true);
  check('자동 준비된 사람도 준비를 취소할 수 있다', room.setReady(b, false) === null && readyOf(room, a, b) === false);
  check('준비 취소한 사람은 다음 판에서 빠진다', room.stateFor(a).readyCount === 3);

  check('다음 판을 준비한 사람끼리 바로 시작한다', room.begin(a) === null);
  const next = room.stateFor(a);
  check('다음 판 참가자는 자동 준비됐던 사람 + 새로 준비한 사람', next.players.filter((p) => p.inRound).map((p) => p.id).sort().join() === [a, c, late].sort().join());
  room.dispose();
}

/** 포커: 차례가 오는 사람이 계속 폴드해 한 명만 남긴다. */
function foldDown(room, viewer) {
  let guard = 0;
  while (room.stateFor(viewer).phase === 'betting' && guard++ < 20) room.fold(room.stateFor(viewer).turnPlayerId);
}

cardGame('포커', createPokerRoom, foldDown);

cardGame('블랙잭', createBlackjackRoom, (room, viewer) => {
  let guard = 0;
  while (room.stateFor(viewer).phase === 'playing' && guard++ < 20) room.stand(room.stateFor(viewer).turnPlayerId);
  foldDown(room, viewer);
});

cardGame('텍사스 홀덤', createHoldemRoom, foldDown);

// ── 칩이 없는 사람은 자동 준비되지 않는다 ─────────────────────
{
  console.log('\n=== 칩이 바닥난 사람 ===');
  // 둘이 올인해 한쪽 칩이 0이 되는 판을 만들 때까지 돌린다(동점이면 환불되어 아무도 0이 되지 않는다).
  let found = null;
  for (let attempt = 0; attempt < 40 && !found; attempt += 1) {
    const room = createPokerRoom({ onChange() {}, actionTimeoutMs: 0 });
    const [a, b] = ['A', 'B'].map((nickname) => room.join({ nickname }).playerId);
    for (const id of [a, b]) room.setReady(id, true);
    room.begin(a);
    room.allin(room.stateFor(a).turnPlayerId);
    let guard = 0;
    while (room.stateFor(a).phase === 'betting' && guard++ < 10) room.call(room.stateFor(a).turnPlayerId);
    const s = room.stateFor(a);
    if (s.phase === 'result' && s.players.some((p) => p.chips <= 0)) found = s;
    room.dispose();
  }
  check('칩이 0이 되는 판이 나왔다', !!found);
  if (found) {
    check('칩이 0인 사람은 자동 준비되지 않고, 칩이 남은 사람은 준비된다', found.players.every((p) => p.ready === (p.chips > 0)), JSON.stringify(found.players.map((p) => [p.chips, p.ready])));
    check('준비한 수에서 칩 없는 사람이 빠진다', found.readyCount === 1 && found.canStart === false);
  }
}

// ── 더 마인드 ───────────────────────────────────────────────
{
  console.log('\n=== 더 마인드 ===');
  const room = createMindRoom({ onChange() {}, proposalTimeoutMs: 1000, disconnectGraceMs: 50 });
  const [a, b, c] = ['A', 'B', 'C'].map((nickname) => room.join({ nickname }).playerId);
  const watcher = room.join({ nickname: '구경꾼' }).playerId;
  for (const id of [a, b, c]) room.setReady(id, true);
  check('세 명이 시작한다', room.begin(a) === null);
  const { roster } = room._debug();
  check('구경꾼은 판에 들어가지 않는다', roster.length === 3 && !roster.includes(watcher));

  // 실수로 목숨을 모두 잃게 해 판을 끝낸다: 모두 집중한 뒤 가장 큰 카드부터 낸다.
  let guard = 0;
  while (room.stateFor(a).phase !== 'result' && guard++ < 60) {
    const phase = room.stateFor(a).phase;
    if (phase === 'focus') for (const id of roster) room.focus(id, true);
    else {
      const debug = room._debug();
      const holder = debug.players.filter((p) => roster.includes(p.id) && p.hand.length).sort((x, y) => y.hand[y.hand.length - 1] - x.hand[x.hand.length - 1])[0];
      if (!holder) break;
      room.play(holder.id);
    }
  }
  const s = room.stateFor(a);
  check('판이 끝났다', s.phase === 'result');
  check('판에 참여한 사람은 자동으로 준비된다', roster.every((id) => readyOf(room, a, id) === true));
  check('구경한 사람은 준비되지 않았고 직접 준비할 수 있다', readyOf(room, a, watcher) === false && room.setReady(watcher, true) === null && readyOf(room, a, watcher) === true);
  check('자동 준비된 사람도 준비를 취소할 수 있다', room.setReady(c, false) === null && readyOf(room, a, c) === false);
  check('준비한 사람(A·B·구경꾼)으로 다음 판을 시작한다', room.stateFor(a).readyCount === 3 && room.begin(a) === null
    && [a, b, watcher].every((id) => room._debug().roster.includes(id)) && !room._debug().roster.includes(c));
  room.dispose();
}

// ── 갈팡질팡 ────────────────────────────────────────────────
{
  console.log('\n=== 갈팡질팡 ===');
  const room = createGalpangRoom({ onChange() {}, seed: 7 });
  const [a, b] = ['A', 'B'].map((nickname) => room.join({ nickname }).playerId);
  const watcher = room.join({ nickname: '구경꾼' }).playerId;
  for (const id of [a, b]) room.setReady(id, true);
  check('둘이 시작한다', room.begin(a) === null);
  check('시작하면 준비가 풀린다', room.stateFor(a).players.every((p) => p.ready === false));
  room.command(a, 'quit');
  room.command(a, 'y'); // 포기는 한 번 더 확인한 뒤에야 제안이 된다
  room.vote(b, room.stateFor(b).proposal.id, true);
  const s = room.stateFor(a);
  check('판이 끝났다', s.phase === 'result');
  check('판에 참여한 사람은 자동으로 준비된다', readyOf(room, a, a) === true && readyOf(room, a, b) === true);
  check('구경한 사람은 준비되지 않았고 직접 준비할 수 있다', readyOf(room, a, watcher) === false && room.setReady(watcher, true) === null);
  check('자동 준비된 사람도 준비를 취소할 수 있다', room.setReady(b, false) === null && readyOf(room, a, b) === false);
  check('준비한 사람(A·구경꾼)으로 다음 판을 시작한다', room.stateFor(a).readyCount === 2 && room.begin(a) === null
    && room.stateFor(a).players.filter((p) => p.inGame).map((p) => p.id).sort().join() === [a, watcher].sort().join());
  room.dispose();
}

console.log(`\n${pass} 통과, ${fail} 실패`);
if (fail) process.exit(1);
