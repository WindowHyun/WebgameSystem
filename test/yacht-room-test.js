'use strict';

/**
 * 야추다이스 규칙(web/yacht-room.js).
 *
 *   - 점수 계산: 12칸마다 대표 주사위로 기대한 점수, 경계(5개가 같으면 풀 하우스가 아니다, 포 카인드는 4개만 센다 등)
 *   - 최대 점수는 297점이다.
 *   - 진행: 굴리기 3번, 고정한 주사위는 다시 굴리지 않는다, 굴리기 전에는 고정·기록 불가, 남의 차례·이미 쓴 칸 거절
 *   - 12라운드를 채우면 끝나고 순위·공동 1위·혼자 하기가 맞다
 *   - 제한시간이 지나면 점수가 가장 높은 칸에 자동 기록한다
 *   - 끊기거나 나가면 게임에서 빠지고 남은 사람이 이어 간다 / 보스 키로 화면을 가리면 제한시간이 멈춘다
 *   - 끝나면 이번 판을 뛴 사람은 자동으로 준비된다
 *
 * 실행: node test/yacht-room-test.js
 */

const { createYachtRoom, scoreOf, CATEGORIES, MAX_SCORE, MAX_PLAYERS, ROUNDS, ROLLS } = require('../web/yacht-room');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 나올 눈(1~6)을 차례로 정해 주는 난수. 다 쓰면 1부터 다시 돈다. */
function rolls(...faces) {
  let i = 0;
  return () => { const face = faces[i % faces.length]; i += 1; return (face - 1) / 6 + 0.01; };
}

function open(names, extra) {
  const lines = [];
  const room = createYachtRoom(Object.assign({ onChange() {}, onAction: (who, what) => lines.push(`${who} > ${what}`), turnTimeoutMs: 0, disconnectGraceMs: 40 }, extra || {}));
  const ids = names.map((nickname) => room.join({ nickname }).playerId);
  const view = (id) => room.stateFor(id || ids[0]);
  const start = () => { for (const id of ids) room.setReady(id, true); return room.begin(ids[0]); };
  const turnId = () => view().turnId;
  const turnIndex = () => ids.indexOf(turnId());
  return { room, ids, view, start, turnId, turnIndex, lines };
}

// ── 점수 계산 ────────────────────────────────────────────────
console.log('\n=== 점수 계산 ===');
{
  const table = [
    ['ones', [1, 1, 3, 4, 6], 2], ['ones', [2, 3, 4, 5, 6], 0],
    ['twos', [2, 2, 2, 5, 6], 6], ['threes', [3, 3, 1, 1, 1], 6], ['fours', [4, 4, 4, 4, 4], 20],
    ['fives', [5, 1, 1, 1, 1], 5], ['sixes', [6, 6, 6, 6, 2], 24],
    ['choice', [1, 2, 3, 4, 6], 16], ['choice', [6, 6, 6, 6, 6], 30],
    ['fourKind', [3, 3, 3, 3, 5], 12], ['fourKind', [5, 5, 5, 5, 5], 20], ['fourKind', [3, 3, 3, 5, 5], 0], ['fourKind', [6, 6, 6, 6, 1], 24],
    ['fullHouse', [2, 2, 3, 3, 3], 13], ['fullHouse', [6, 6, 6, 5, 5], 28], ['fullHouse', [4, 4, 4, 4, 4], 0], ['fullHouse', [2, 2, 3, 3, 4], 0], ['fullHouse', [1, 1, 1, 1, 2], 0],
    ['littleStraight', [1, 2, 3, 4, 5], 30], ['littleStraight', [5, 3, 1, 4, 2], 30], ['littleStraight', [2, 3, 4, 5, 6], 0], ['littleStraight', [1, 2, 3, 4, 4], 0],
    ['bigStraight', [2, 3, 4, 5, 6], 30], ['bigStraight', [6, 4, 2, 5, 3], 30], ['bigStraight', [1, 2, 3, 4, 5], 0], ['bigStraight', [3, 4, 5, 6, 6], 0],
    ['yacht', [3, 3, 3, 3, 3], 50], ['yacht', [3, 3, 3, 3, 4], 0],
  ];
  const wrong = table.filter(([key, dice, want]) => scoreOf(key, dice) !== want).map(([key, dice, want]) => `${key} ${dice.join('')} → ${scoreOf(key, dice)} (기대 ${want})`);
  check(`칸별 점수 ${table.length}가지가 규칙과 같다`, wrong.length === 0, wrong.join(' / '));
  check('칸은 12개이고 라운드도 12다', CATEGORIES.length === 12 && ROUNDS === 12 && same(CATEGORIES.map((c) => c.key), ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes', 'choice', 'fourKind', 'fullHouse', 'littleStraight', 'bigStraight', 'yacht']));
  check('알 수 없는 칸이나 잘못된 주사위는 null이다', scoreOf('nope', [1, 1, 1, 1, 1]) === null && scoreOf('yacht', [1, 1, 1]) === null && scoreOf('yacht', null) === null);

  // 모든 5개 눈 조합(7776가지)에서 칸마다 낼 수 있는 최댓값을 구해 합하면 297점이다.
  const best = Object.fromEntries(CATEGORIES.map((c) => [c.key, 0]));
  const dice = [1, 1, 1, 1, 1];
  for (let n = 0; n < 7776; n += 1) {
    let rest = n;
    for (let i = 0; i < 5; i += 1) { dice[i] = (rest % 6) + 1; rest = Math.floor(rest / 6); }
    for (const c of CATEGORIES) best[c.key] = Math.max(best[c.key], scoreOf(c.key, dice));
  }
  const maxTotal = Object.values(best).reduce((a, b) => a + b, 0);
  check('칸마다 낼 수 있는 최댓값을 합하면 297점이다(기본 Yacht 규칙)', maxTotal === 297 && MAX_SCORE === 297, String(maxTotal));
  check('주사위는 1~6만 나온다(모든 조합에서 점수가 음수가 아니고 합계 30을 넘지 않는 칸은 초이스뿐이다)', best.choice === 30 && best.yacht === 50);
}

// ── 시작·준비 ───────────────────────────────────────────────
console.log('\n=== 시작과 준비 ===');
{
  const t = open(['가', '나']);
  check('준비한 사람이 없으면 시작할 수 없다', typeof t.room.begin(t.ids[0]) === 'string' && t.view().canStart === false);
  t.room.setReady(t.ids[0], true);
  check('혼자 준비해도 시작할 수 있다(혼자서도 한다)', t.view().canStart === true && t.view().readyCount === 1);
  t.room.setReady(t.ids[1], true);
  check('둘이 준비하면 시작한다', t.room.begin(t.ids[0]) === null && t.view().phase === 'playing');
  const s = t.view();
  check('시작하면 준비가 풀리고 1라운드·첫 사람 차례다', s.players.every((p) => p.ready === false) && s.round === 1 && s.turnId === t.ids[0] && s.rollsLeft === 3 && s.rolled === false);
  check('주사위는 아직 굴리지 않았다(눈 0) / 점수판은 비어 있다', same(s.dice, [0, 0, 0, 0, 0]) && s.board.length === 2 && s.board.every((b) => b.total === 0 && Object.values(b.sheet).every((v) => v === null)));
  check('진행 중에는 준비를 바꿀 수 없고 다시 시작할 수도 없다', typeof t.room.setReady(t.ids[0], true) === 'string' && typeof t.room.begin(t.ids[0]) === 'string');
  const late = t.room.join({ nickname: '늦게' }).playerId;
  check('중간에 들어온 사람은 구경한다(참가자가 아니다)', t.view(late).you.inGame === false && t.view(late).board.length === 2);
  t.room.dispose();

  const big = open(['1', '2', '3', '4', '5', '6', '7']);
  for (const id of big.ids) big.room.setReady(id, true);
  check(`준비한 사람이 ${MAX_PLAYERS}명을 넘으면 시작하지 않는다`, /6명까지/.test(big.room.begin(big.ids[0]) || ''));
  big.room.setReady(big.ids[6], false);
  check(`${MAX_PLAYERS}명은 시작할 수 있다`, big.room.begin(big.ids[0]) === null && big.view().board.length === 6);
  big.room.dispose();
}

// ── 굴리기·고정·기록 ────────────────────────────────────────
console.log('\n=== 굴리기·고정·기록 ===');
{
  const t = open(['가', '나'], { random: rolls(1, 2, 3, 4, 5, 6) });
  t.start();
  const [a, b] = t.ids;
  check('굴리기 전에는 고정할 수 없다', typeof t.room.hold(a, [true, false, false, false, false]) === 'string');
  check('굴리기 전에는 점수를 기록할 수 없다', typeof t.room.score(a, 'choice') === 'string');
  check('남의 차례에는 굴릴 수 없다', typeof t.room.roll(b) === 'string' && t.view().rollsLeft === 3);
  check('남의 차례에는 고정·기록도 못 한다', typeof t.room.hold(b, [true, true, true, true, true]) === 'string' && typeof t.room.score(b, 'choice') === 'string');

  check('첫 굴림은 5개를 모두 굴린다', t.room.roll(a) === null && same(t.view().dice, [1, 2, 3, 4, 5]) && t.view().rollsLeft === 2 && t.view().rolled === true);
  check('고정하지 않은 상태에서 다시 굴리면 5개가 모두 바뀐다', t.room.roll(a) === null && same(t.view().dice, [6, 1, 2, 3, 4]) && t.view().rollsLeft === 1);
  check('상태에는 내 차례에만 칸별 예상 점수(options)가 온다', t.view(a).you.options && t.view(a).you.options.choice === 16 && t.view(b).you.options === null);
  check('고정은 모두의 화면에 보인다', t.room.hold(a, [true, false, true, false, false]) === null && same(t.view(b).held, [true, false, true, false, false]));
  check('고정한 주사위는 다시 굴리지 않는다', t.room.roll(a) === null && t.view().dice[0] === 6 && t.view().dice[2] === 2 && same(t.view().dice.map((v, i) => (i === 0 || i === 2 ? v : 0)), [6, 0, 2, 0, 0]) && t.view().rollsLeft === 0, JSON.stringify(t.view().dice));
  check('세 번 굴리면 더 못 굴리고 고정도 풀린다', typeof t.room.roll(a) === 'string' && same(t.view().held, [false, false, false, false, false]) && typeof t.room.hold(a, [true, true, true, true, true]) === 'string');
  check('알 수 없는 칸·잘못된 칸 이름은 거절한다', typeof t.room.score(a, 'nope') === 'string' && typeof t.room.score(a, 42) === 'string' && typeof t.room.score(a, '__proto__') === 'string');

  const dice = t.view().dice.slice();
  check('칸에 기록하면 점수가 들어가고 다음 사람 차례가 된다', t.room.score(a, 'choice') === null && t.view().board[0].sheet.choice === dice.reduce((x, y) => x + y, 0) && t.view().turnId === b && t.view().rollsLeft === 3 && same(t.view().dice, [0, 0, 0, 0, 0]));
  check('다음 사람의 주사위·고정은 비어 있다', same(t.view().held, [false, false, false, false, false]) && t.view(b).you.myTurn === true && t.view(a).you.myTurn === false);

  t.room.roll(b);
  t.room.score(b, 'yacht'); // 야추가 아니니 0점
  check('맞지 않는 족보를 기록하면 0점이다', t.view().board[1].sheet.yacht === 0);
  t.room.roll(a);
  check('이미 기록한 칸은 거절한다(차례도 넘어가지 않는다)', typeof t.room.score(a, 'choice') === 'string' && t.view().turnId === a);
  check('두 번째 라운드가 된다', t.view().round === 2);

  // 전부 고정하면 굴릴 게 없다.
  t.room.hold(a, [true, true, true, true, true]);
  check('전부 고정하면 굴릴 수 없다(고정을 풀거나 기록해야 한다)', typeof t.room.roll(a) === 'string' && t.view().rollsLeft === 2 && t.view().you.canRoll === false);
  t.room.hold(a, [true, true, true, true, false]);
  check('고정을 풀면 다시 굴릴 수 있다', t.view().you.canRoll === true && t.room.roll(a) === null);
  check('굴림은 관리 로그에 남는다', t.lines.some((l) => l.includes('굴림 1/3')) && t.lines.some((l) => l.includes('기록 초이스')));
  t.room.dispose();
}

// ── 한 판 끝까지 / 순위 ─────────────────────────────────────
console.log('\n=== 한 판과 순위 ===');
{
  /** 차례가 오는 사람마다 굴려서 빈 칸을 순서대로 채운다. 모든 칸이 차면 끝난다. */
  const playOut = (t, order) => {
    let guard = 0;
    while (t.view().phase === 'playing' && guard++ < 100) {
      const id = t.turnId();
      t.room.roll(id);
      const board = t.view().board.find((b) => b.id === id);
      const key = (order || CATEGORIES.map((c) => c.key)).find((k) => board.sheet[k] === null);
      t.room.score(id, key);
    }
  };
  const t = open(['가', '나']);
  t.start();
  let turns = 0;
  while (t.view().phase === 'playing' && turns < 100) {
    const id = t.turnId();
    t.room.roll(id);
    const board = t.view().board.find((b) => b.id === id);
    t.room.score(id, CATEGORIES.map((c) => c.key).find((k) => board.sheet[k] === null));
    turns += 1;
  }
  const end = t.view();
  check('둘이 12칸씩 24번 기록하면 끝난다', end.phase === 'result' && turns === 24 && end.board.every((b) => Object.values(b.sheet).every((v) => v !== null)), `${turns}번`);
  check('결과에 순위·합계가 있다(점수 높은 순)', end.result && end.result.ranking.length === 2 && end.result.ranking[0].total >= end.result.ranking[1].total && end.result.ranking[0].rank === 1);
  check('합계는 점수판의 합이다', end.board.every((b) => b.total === Object.values(b.sheet).reduce((x, y) => x + y, 0)) && end.result.ranking.every((r) => r.total === end.board.find((b) => b.id === r.id).total));
  check('끝난 뒤에는 굴리기·기록이 거절되고 차례도 없다', typeof t.room.roll(t.ids[0]) === 'string' && end.turnId === null && end.round === 0);
  check('이번 판을 뛴 두 사람은 자동으로 준비된다', end.players.every((p) => p.ready === true) && end.readyCount === 2 && end.canStart === true);
  check('빠지려면 준비를 취소하고 새 판은 그 사람 없이 시작한다', t.room.setReady(t.ids[1], false) === null && t.room.begin(t.ids[0]) === null && t.view().board.length === 1 && t.view().result === null);
  t.room.dispose();

  // 같은 점수는 공동 순위. 같은 주사위만 나오게 해 둘이 똑같이 친다.
  const tie = open(['가', '나'], { random: rolls(2) });
  tie.start();
  playOut(tie);
  const r = tie.view().result;
  check('똑같이 친 두 사람은 공동 1위다', r.ranking.length === 2 && r.ranking[0].total === r.ranking[1].total && r.ranking.every((x) => x.rank === 1) && r.winners.length === 2 && /공동 1위/.test(r.message), JSON.stringify(r.ranking));
  tie.room.dispose();

  // 혼자 하기
  const solo = open(['혼자']);
  solo.start();
  playOut(solo);
  const sr = solo.view().result;
  check('혼자서도 12칸을 채우면 끝나고 점수가 나온다', solo.view().phase === 'result' && sr.ranking.length === 1 && sr.winners[0] === '혼자' && sr.ranking[0].total <= 297 && /점수는/.test(sr.message));
  solo.room.dispose();

  // 점수 순위(1위/2위/3위, 3명 중 공동 2위)는 같은 점수에 같은 순위를 준다
  const three = open(['가', '나', '다']);
  three.start();
  const sheetScores = [100, 80, 80];
  const seats = three.room._debug().seats;
  for (let i = 0; i < 3; i += 1) {
    for (const c of CATEGORIES) seats[i].sheet[c.key] = 0;
    seats[i].sheet.choice = sheetScores[i];
  }
  // 마지막 한 칸만 남기고 기록하면 끝나도록 한 칸을 비워 둔다.
  for (const seat of seats) seat.sheet.yacht = null;
  three.room._debug().setDice([1, 1, 1, 1, 2]);
  for (let n = 0; n < 3; n += 1) { const id = three.turnId(); three.room.roll(id); three.room.score(id, 'yacht'); }
  const rr = three.view().result;
  check('3명 중 같은 점수는 같은 순위다(1, 2, 2)', three.view().phase === 'result' && same(rr.ranking.map((x) => x.rank), [1, 2, 2]) && rr.winners.length === 1, JSON.stringify(rr && rr.ranking));
  three.room.dispose();
}

// ── 제한시간 ────────────────────────────────────────────────
console.log('\n=== 제한시간 ===');
(async () => {
  {
    const t = open(['가', '나'], { turnTimeoutMs: 60, random: rolls(6, 6, 6, 6, 6) });
    t.start();
    check('차례마다 끝나는 시각이 있다(서버 시계 기준)', t.view().turnEndsAt > t.view().serverTime - 5 && t.view().turnEndsAt - t.view().serverTime <= 60);
    await wait(90); // 60ms 뒤 첫 사람이 자동 기록되고, 다음 사람의 시간(60ms)은 아직 안 지났다
    const s = t.view();
    check('굴리지 않고 시간이 지나면 서버가 굴리고 점수가 가장 높은 칸(야추 50점)에 자동 기록한다', s.board[0].sheet.yacht === 50 && s.board[0].total === 50 && s.turnId === t.ids[1], JSON.stringify(s.board[0].sheet));
    check('자동 기록은 로그와 기록에 남는다', t.lines.some((l) => l.includes('시간 초과')) && s.history.some((h) => h.text.includes('자동으로 기록')));
    check('다음 차례의 시간이 새로 시작된다', s.turnEndsAt > s.serverTime);
    await wait(110);
    check('모두 시간을 넘기면 계속 자동으로 진행된다(두 번째 사람도 야추 50점을 기록했다)', t.view().board[1].sheet.yacht === 50 && t.view().board[0].total > 50);
    t.room.dispose();
  }
  {
    // 점수가 모두 0이면 쓸모가 적은 칸(야추)부터 버린다.
    const t = open(['가'], { turnTimeoutMs: 40, random: rolls(1, 2, 3, 4, 6) });
    t.start();
    t.room.roll(t.ids[0]); // 1 2 3 4 6: 초이스 16점이 가장 높다
    await wait(100);
    check('굴린 뒤 시간이 지나면 가장 높은 칸(초이스 16점)에 기록한다', t.view().board[0].sheet.choice === 16, JSON.stringify(t.view().board[0].sheet));
    t.room.dispose();
    const z = open(['가'], { turnTimeoutMs: 40, random: rolls(1, 3, 3, 6, 6) });
    z.start();
    z.room._debug().seats[0].sheet.ones = 0;
    z.room._debug().seats[0].sheet.threes = 0;
    z.room._debug().seats[0].sheet.sixes = 0;
    z.room._debug().seats[0].sheet.choice = 0;
    z.room._debug().seats[0].sheet.fourKind = 0;
    z.room._debug().seats[0].sheet.fullHouse = 0;
    z.room._debug().seats[0].sheet.twos = 0;
    z.room._debug().seats[0].sheet.fours = 0;
    z.room._debug().seats[0].sheet.fives = 0;
    // 남은 칸: 리틀·빅 스트레이트·야추. 1 3 3 6 6은 모두 0점 → 가장 쓸모없는 야추부터 버린다.
    await wait(100);
    check('모든 칸이 0점이면 쓸모가 적은 칸(야추)부터 0점으로 기록한다', z.view().board[0].sheet.yacht === 0, JSON.stringify(z.view().board[0].sheet));
    z.room.dispose();
  }

  // ── 끊김·나가기 ────────────────────────────────────────────
  console.log('\n=== 끊김과 나가기 ===');
  {
    const t = open(['가', '나', '다']);
    t.start();
    t.room.disconnect(t.ids[1]);
    check('끊기면 바로 빠지지 않고 돌아올 틈을 준다', t.view(t.ids[0]).board.every((b) => !b.left) && t.view(t.ids[0]).players.find((p) => p.id === t.ids[1]).connected === false);
    t.room.join({ nickname: '나', token: t.room._debug().players[1].token });
    await wait(80);
    check('유예 안에 같은 토큰으로 돌아오면 자리를 지킨다', t.view().board.every((b) => !b.left));

    t.room.disconnect(t.ids[1]);
    await wait(90);
    const s = t.view();
    check('유예가 지나도록 안 돌아오면 게임에서 빠진다(점수판은 남는다)', s.board.find((b) => b.id === t.ids[1]).left === true && s.board.length === 3);
    // 차례가 가가 → 나(빠짐)를 건너뛰고 다
    t.room.roll(t.ids[0]); t.room.score(t.ids[0], 'choice');
    check('빠진 사람은 차례에서 건너뛴다', t.turnId() === t.ids[2]);
    t.room.leave(t.ids[2]);
    check('차례인 사람이 나가면 다음 사람에게 넘어간다', t.turnId() === t.ids[0] && t.view().phase === 'playing');
    t.room.leave(t.ids[0]);
    check('모두 빠지면(마지막 사람이 나가면) 방이 비워진다', t.room._debug().players.length === 0 || t.room.stateFor(t.ids[0]).phase === 'lobby');
    t.room.dispose();
  }
  {
    // 끝난 판에서 빠진 사람은 순위에 넣지 않는다
    const t = open(['가', '나']);
    t.start();
    t.room.leave(t.ids[1]);
    check('둘 중 한 명이 나가도 남은 사람은 혼자 끝까지 한다', t.view().phase === 'playing' && t.view().turnId === t.ids[0]);
    let guard = 0;
    while (t.view().phase === 'playing' && guard++ < 40) {
      const id = t.turnId();
      t.room.roll(id);
      const board = t.view().board.find((b) => b.id === id);
      t.room.score(id, CATEGORIES.map((c) => c.key).find((k) => board.sheet[k] === null));
    }
    const r = t.view().result;
    check('끝나면 남은 사람만 순위에 올라 우승한다(빠진 사람은 제외)', r && r.ranking.length === 1 && r.winners[0] === '가' && t.view().board.length === 2);
    t.room.dispose();
  }
  {
    const t = open(['가', '나']);
    check('구경만 하는 사람이 끊겨도 진행에 영향이 없다', (() => {
      t.start();
      const late = t.room.join({ nickname: '구경' }).playerId;
      t.room.disconnect(late);
      return t.view().turnId === t.ids[0] && t.view().phase === 'playing';
    })());
    t.room.dispose();
  }

  // ── 보스 키 ────────────────────────────────────────────────
  console.log('\n=== 보스 키(화면 가림) ===');
  {
    const t = open(['가', '나'], { turnTimeoutMs: 120 });
    t.start();
    t.room.setCovered(t.ids[0], true);
    const paused = t.view();
    check('차례인 사람이 화면을 가리면 제한시간이 멈춘다', paused.paused === true && typeof paused.pausedAt === 'number');
    await wait(220);
    check('가려 둔 동안은 시간이 지나도 자동 기록되지 않는다', t.view().turnId === t.ids[0] && t.view().board[0].total === 0);
    t.room.setCovered(t.ids[0], false);
    check('돌아오면 다시 흐른다', t.view().paused === false);
    await wait(200);
    check('다시 흐르면 남은 시간이 지나 자동 기록된다', t.view().turnId === t.ids[1]);
    t.room.setCovered(t.ids[0], true);
    check('차례가 아닌 사람이 가리는 것은 진행을 멈추지 않는다', t.view().paused === false);
    t.room.dispose();
  }

  // ── 접속자 목록 ────────────────────────────────────────────
  console.log('\n=== 접속자 목록(/order) ===');
  {
    const t = open(['가', '나']);
    t.start();
    const list = t.room.rosterList();
    check('접속자 목록에 닉네임·접속·참여가 있고 칩은 없다', list.length === 2 && list.every((p) => p.connected && p.inRound && p.chips === null) && typeof t.room.grant === 'undefined');
    check('status는 진행 중과 접속 인원을 알려 준다', same(t.room.status(), { phase: 'playing', playerCount: 2 }));
    t.room.dispose();
  }
  check('굴림 횟수는 3번이다', ROLLS === 3);

  console.log(`\n야추다이스 규칙: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})();
