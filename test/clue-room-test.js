'use strict';

/**
 * 클루 규칙 시험(web/clue-room.js). 브라우저·소켓 없이 방을 직접 다룬다.
 *
 *   - 보드: 문은 모두 복도 칸이고 모든 방·칸에 갈 수 있다. 막힌 말·막힌 문은 지나갈 수 없다.
 *   - 시작: 인원 제한, 카드는 정답을 뺀 18장을 모두 나눠 가진다(겹침 없음), 차례는 스칼렛부터 정해진 순서.
 *   - 이동: 굴린 눈 안에서만 갈 수 있고, 방에 들어가면 추측 단계, 복도에 서면 끝 단계다. 비밀 통로.
 *   - 추측: 시계 방향으로 첫 반박자, 한 장이면 자동·여러 장이면 고른다, 추측한 사람에게만 카드가 간다,
 *     불려 온 말의 주인은 다음 차례에 굴리지 않고 추측할 수 있다.
 *   - 고발: 틀리면 탈락(카드는 계속 반박에 쓰인다), 맞으면 승리, 한 명만 남으면 승리. 정답은 끝날 때까지 안 나간다.
 *   - 제한시간·연속 시간 초과 퇴장·나가기·재접속.
 *
 * 실행: node test/clue-room-test.js
 */

const { createClueRoom, computeReach, isCorridor, ROOMS, SUSPECTS, WEAPONS, CARDS, MAP, HINT_CELLS } = require('../web/clue-room');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 같은 값이 나오는 난수(시험이 매번 같게 돈다)
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** names 명이 입장·준비·시작한 방. seats는 차례 순서. by(이름)로 자리를 찾는다. */
function game(names, options) {
  const room = createClueRoom({ random: lcg(7), disconnectGraceMs: 40, autoEndMs: 0, ...(options || {}) });
  const joined = {};
  for (const name of names) joined[name] = room.join({ nickname: name });
  for (const name of names) room.setReady(joined[name].playerId, true);
  const err = room.begin(joined[names[0]].playerId);
  const dbg = room._debug();
  return { room, joined, err, dbg, id: (name) => joined[name].playerId, seat: (name) => dbg.seats.find((s) => s.id === joined[name].playerId) };
}
/** 지금 차례인 사람의 이름 */
const turnName = (g) => g.dbg.seats[g.room._debug().turn].nickname;
const state = (g, name) => g.room.stateFor(g.id(name));

(async () => {
  console.log('\n=== 보드 ===');
  check('방 9곳·범인 6명·흉기 6개·카드 21장', ROOMS.length === 9 && SUSPECTS.length === 6 && WEAPONS.length === 6 && CARDS.length === 21);
  check('모든 문은 복도 칸이다', ROOMS.every((r) => r.doors.every(([x, y]) => isCorridor(x, y))));
  check('모든 말의 시작 칸은 복도이고 서로 다르다', SUSPECTS.every((s) => isCorridor(s.start.x, s.start.y)) && new Set(SUSPECTS.map((s) => `${s.start.x},${s.start.y}`)).size === 6);
  const everywhere = computeReach({ x: SUSPECTS[0].start.x, y: SUSPECTS[0].start.y }, 200);
  let corridors = 0;
  for (let y = 0; y < MAP.h; y += 1) for (let x = 0; x < MAP.w; x += 1) if (isCorridor(x, y)) corridors += 1;
  check('시작 칸에서 모든 방(정답 봉투 방 포함)과 모든 복도 칸에 갈 수 있다', everywhere.rooms.length === 10 && everywhere.rooms.includes('envelope') && everywhere.cells.length + 1 === corridors, `${everywhere.rooms.length}방 ${everywhere.cells.length + 1}/${corridors}칸`);
  check('비밀 통로는 서로 마주 보는 모서리 방이다', ROOMS.filter((r) => r.passage).every((r) => ROOMS.find((o) => o.key === r.passage).passage === r.key) && ROOMS.filter((r) => r.passage).length === 4);

  console.log('\n=== 이동 계산 ===');
  const door = { x: 7, y: 3 }; // 무도회장 왼쪽 문
  check('문 칸에서 1칸이면 방에 들어갈 수 있다', computeReach(door, 1).rooms.includes('ballroom'));
  check('0칸이면 아무 데도 못 간다', computeReach(door, 0).cells.length === 0 && computeReach(door, 0).rooms.length === 0);
  check('방에서는 문 칸으로 나가는 것이 한 칸이다', computeReach({ room: 'ballroom' }, 1).cells.length === 3 && computeReach({ room: 'ballroom' }, 1).rooms.length === 0);
  check('서 있는 방은 결과에 없다', !computeReach({ room: 'ballroom' }, 12).rooms.includes('ballroom'));
  check('다른 말이 선 칸은 지나갈 수 없다', !computeReach({ x: 6, y: 3 }, 1, new Set(['7,3'])).cells.some((c) => c.x === 7 && c.y === 3) && !computeReach({ x: 6, y: 3 }, 2, new Set(['7,3'])).rooms.includes('ballroom'));
  check('문 칸이 막히면 그 문으로는 못 들어가지만 다른 문으로는 들어간다', computeReach({ x: 11, y: 8 + 0 }, 0).cells.length === 0
    && !computeReach({ x: 11, y: 7 }, 1, new Set([])).rooms.includes('kitchen')
    && computeReach({ x: 10, y: 7 }, 2, new Set(['11,7'])).rooms.includes('ballroom') === false);
  check('복도에서는 벽(방 안쪽)으로 걸어 들어갈 수 없다', !computeReach({ x: 6, y: 3 }, 1).cells.some((c) => c.x === 5 && c.y === 3));

  console.log('\n=== 시작·카드 나누기 ===');
  const solo = createClueRoom({ random: lcg(1) });
  const only = solo.join({ nickname: '혼자' });
  solo.setReady(only.playerId, true);
  check('혼자서는 시작할 수 없다', /2명 이상/.test(solo.begin(only.playerId) || ''));
  solo.dispose();

  for (const count of [2, 3, 4, 5, 6]) {
    const names = ['가', '나', '다', '라', '마', '바'].slice(0, count);
    const g = game(names);
    const dealt = g.dbg.seats.flatMap((s) => s.hand);
    const sol = g.dbg.solution;
    check(`${count}명: 정답을 뺀 18장을 겹침 없이 모두 나눠 가진다`, g.err === null && dealt.length === 18 && new Set(dealt).size === 18 && ![sol.suspect, sol.weapon, sol.room].some((c) => dealt.includes(c)), `${dealt.length}장`);
    check(`${count}명: 카드 수는 서로 1장 넘게 차이 나지 않는다`, Math.max(...g.dbg.seats.map((s) => s.hand.length)) - Math.min(...g.dbg.seats.map((s) => s.hand.length)) <= 1);
    check(`${count}명: 정답은 범인·흉기·장소 한 장씩이다`, SUSPECTS.some((s) => s.key === sol.suspect) && WEAPONS.some((w) => w.key === sol.weapon) && ROOMS.some((r) => r.key === sol.room));
    g.room.dispose();
  }
  const seven = createClueRoom({ random: lcg(2) });
  const ids = ['1', '2', '3', '4', '5', '6', '7'].map((n) => seven.join({ nickname: n }).playerId);
  ids.forEach((id) => seven.setReady(id, true));
  check('7명이 준비하면 시작할 수 없다', /6명까지/.test(seven.begin(ids[0]) || ''));
  seven.dispose();

  const g3 = game(['가', '나', '다']);
  const order = g3.dbg.seats.map((s) => SUSPECTS.findIndex((x) => x.key === s.suspect));
  check('차례는 스칼렛부터 정해진 순서(말 번호가 오름차순)다', order.every((n, i) => i === 0 || n > order[i - 1]) && g3.dbg.turn === 0);
  check('세 사람이 서로 다른 말을 쥔다', new Set(g3.dbg.seats.map((s) => s.suspect)).size === 3);
  check('시작하면 말은 모두 시작 칸에 서고, 흉기는 서로 다른 방에 있다', SUSPECTS.every((s) => g3.dbg.positions[s.key].x === s.start.x && g3.dbg.positions[s.key].y === s.start.y) && new Set(Object.values(g3.dbg.weaponRooms)).size === 6);

  console.log('\n=== 비밀 보호 ===');
  const a = g3.dbg.seats[0].nickname; const b = g3.dbg.seats[1].nickname;
  const sa = state(g3, a); const sb = state(g3, b);
  check('내 카드는 나에게만 간다', JSON.stringify(sa.you.hand) === JSON.stringify(g3.dbg.seats[0].hand) && JSON.stringify(sb.you.hand) === JSON.stringify(g3.dbg.seats[1].hand) && JSON.stringify(sa.you.hand) !== JSON.stringify(sb.you.hand));
  check('남의 카드는 장수만 보인다(점수판에 카드 이름이 없다)', sa.board.every((x) => typeof x.cards === 'number' && x.hand === undefined));
  check('게임 중에는 정답이 상태 어디에도 없다', sa.result === null && !JSON.stringify(sa).includes('"solution"'));
  check('구경꾼(다른 방 사람)도 카드를 못 본다', (() => { const watcher = g3.room.join({ nickname: '구경' }); const sw = g3.room.stateFor(watcher.playerId); return sw.you.hand.length === 0 && sw.you.inGame === false; })());

  console.log('\n=== 굴리기·이동 ===');
  check('남의 차례에 굴리면 거절된다', /내 차례가 아닙니다/.test(g3.room.roll(g3.id(b)) || ''));
  check('굴리기 전에는 이동할 수 없다', /먼저 주사위/.test(g3.room.move(g3.id(a), { x: 17, y: 1 }) || ''));
  check('굴리면 두 주사위가 1~6이고 합만큼 이동 단계가 된다', g3.room.roll(g3.id(a)) === null && g3.room._debug().dice.every((v) => v >= 1 && v <= 6) && g3.room._debug().step === 'move' && g3.room._debug().moveLeft === g3.room._debug().dice[0] + g3.room._debug().dice[1]);
  check('한 차례에 두 번 굴릴 수 없다', /이미 주사위를 굴렸습니다/.test(g3.room.roll(g3.id(a)) || ''));
  check('이동 단계에는 갈 수 있는 곳을 알려 준다(나에게만)', !!state(g3, a).you.reach && state(g3, a).you.reach.cells.length > 0 && state(g3, b).you.reach === null);
  const mySuspect = g3.seat(a).suspect;
  g3.room._debug().setDice([1, 1]);
  const startAt = g3.room._debug().positions[mySuspect];
  const bad = g3.room.move(g3.id(a), { x: startAt.x, y: startAt.y + 5 });
  check('눈이 모자라는 먼 칸은 거절된다', /갈 수 없습니다/.test(bad || ''));
  check('벽·방 안쪽 칸은 거절된다', /갈 수 없습니다/.test(g3.room.move(g3.id(a), { x: 3, y: 3 }) || ''));
  check('모르는 방·형식이 틀린 칸은 거절된다', /갈 수 없습니다/.test(g3.room.move(g3.id(a), { room: 'nowhere' }) || '') && /갈 수 없습니다/.test(g3.room.move(g3.id(a), { x: 1.5, y: 2 }) || ''));
  const cell = state(g3, a).you.reach.cells[0];
  check('갈 수 있는 복도 칸으로 이동하면 끝 단계가 된다', g3.room.move(g3.id(a), cell) === null && g3.room._debug().step === 'end' && g3.room._debug().positions[mySuspect].x === cell.x);
  check('복도에서는 추측할 수 없다', /방 안에서만/.test(g3.room.suggest(g3.id(a), 'plum', 'rope') || ''));
  check('차례 끝내기로 다음 사람 차례가 된다', g3.room.endTurn(g3.id(a)) === null && turnName(g3) === b && g3.room._debug().step === 'start' && g3.room._debug().dice === null);
  g3.room.dispose();

  console.log('\n=== 방 들어가기·비밀 통로 ===');
  const g4 = game(['가', '나', '다']);
  let cur = turnName(g4); let cs = g4.seat(cur);
  g4.room._debug().setPosition(cs.suspect, { x: 7, y: 3 }); // 무도회장 문 앞
  g4.room.roll(g4.id(cur)); g4.room._debug().setDice([1, 2]);
  check('방에 들어가면 추측 단계다', g4.room.move(g4.id(cur), { room: 'ballroom' }) === null && g4.room._debug().step === 'suggest' && g4.room._debug().positions[cs.suspect].room === 'ballroom');
  check('이동이 끝나면 더 움직일 수 없다', /이미 움직였습니다/.test(g4.room.move(g4.id(cur), { x: 7, y: 3 }) || ''));
  check('추측 단계에서 내 상태는 추측 가능·고발 불가(봉투 방이 아님)·차례 끝내기 가능이다', (() => { const y = state(g4, cur).you; return y.canSuggest && !y.canAccuse && y.canEnd && !y.canRoll; })());
  g4.room.endTurn(g4.id(cur));

  cur = turnName(g4); cs = g4.seat(cur);
  g4.room._debug().setPosition(cs.suspect, { room: 'kitchen' });
  check('주방에서 비밀 통로로 연구실에 건너가면 추측 단계다', g4.room.passage(g4.id(cur)) === null && g4.room._debug().positions[cs.suspect].room === 'study' && g4.room._debug().step === 'suggest');
  g4.room.endTurn(g4.id(cur));
  cur = turnName(g4); cs = g4.seat(cur);
  g4.room._debug().setPosition(cs.suspect, { room: 'hall' });
  check('통로가 없는 방에서는 비밀 통로를 쓸 수 없다', /모서리 방/.test(g4.room.passage(g4.id(cur)) || ''));
  g4.room._debug().setPosition(cs.suspect, { room: 'conservatory' });
  g4.room.roll(g4.id(cur));
  check('굴린 뒤에는 비밀 통로를 쓸 수 없다', /굴리기 전/.test(g4.room.passage(g4.id(cur)) || ''));
  g4.room.dispose();

  console.log('\n=== 추측·카드 보여 주기 ===');
  const g5 = game(['가', '나', '다']);
  const [s0, s1, s2] = g5.dbg.seats;
  // 카드를 정해 준다: 0번은 아무것도 없고, 1번은 촛대+서재, 2번은 플럼. 정답은 나머지에서.
  g5.room._debug().setSolution({ suspect: 'green', weapon: 'rope', room: 'kitchen' });
  g5.room._debug().setHand(s0.id, ['mustard', 'dagger', 'dining']);
  g5.room._debug().setHand(s1.id, ['candlestick', 'library', 'wrench']);
  g5.room._debug().setHand(s2.id, ['plum', 'revolver', 'hall']);
  g5.room._debug().setPosition(s0.suspect, { room: 'library' });
  check('방 밖에서 추측하면 거절된다', /추측할 수 없습니다|방 안에서만/.test(g5.room.suggest(s0.id, 'plum', 'rope') || ''));
  g5.room.roll(s0.id); g5.room._debug().setDice([1, 1]);
  g5.room._debug().setPosition(s0.suspect, { x: 16, y: 17 });
  g5.room.move(s0.id, { room: 'library' });
  check('모르는 범인·흉기로는 추측할 수 없다', /알 수 없는 범인/.test(g5.room.suggest(s0.id, 'nobody', 'rope') || '') && /알 수 없는 흉기/.test(g5.room.suggest(s0.id, 'plum', 'gun') || ''));
  // 촛대+서재가 1번, 플럼이 2번에게 있다. 시계 방향으로 1번이 먼저 반박하는데 두 장이라 고른다.
  check('추측하면 둘 이상 가진 첫 사람이 고르는 단계가 된다', g5.room.suggest(s0.id, 'plum', 'candlestick') === null && g5.room._debug().step === 'disprove');
  const sd0 = g5.room.stateFor(s0.id); const sd1 = g5.room.stateFor(s1.id); const sd2 = g5.room.stateFor(s2.id);
  check('고를 수 있는 카드는 반박할 사람에게만 보인다(추측에 나온 카드만)', sd1.you.disprove && JSON.stringify(sd1.you.disprove.options.sort()) === JSON.stringify(['candlestick', 'library']) && sd0.you.disprove === null && sd2.you.disprove === null);
  check('추측한 말과 흉기가 그 방으로 불려 온다', g5.room._debug().positions.plum.room === 'library' && g5.room._debug().weaponRooms.candlestick === 'library');
  check('불려 온 말의 주인은 다음 차례에 굴리지 않고 추측할 수 있다', g5.room._debug().seats[2].summoned === true);
  check('고르는 동안 다른 사람은 조작할 수 없다', /카드를 고르는 중/.test(g5.room.endTurn(s0.id) || '') && /카드를 고르는 중/.test(g5.room.accuse(s0.id, 'green', 'rope', 'kitchen') || ''));
  check('반박할 사람이 아닌 사람은 보여 줄 수 없다', /내가 카드를 보여 줄 차례가 아닙니다/.test(g5.room.show(s2.id, 'plum') || ''));
  check('추측에 나오지 않은 카드는 보여 줄 수 없다', /보여 줄 수 있는 카드가 아닙니다/.test(g5.room.show(s1.id, 'wrench') || '') && /보여 줄 수 있는 카드가 아닙니다/.test(g5.room.show(s1.id, 'mustard') || ''));
  check('카드를 고르면 추측한 사람에게만 간다', g5.room.show(s1.id, 'library') === null && g5.room.stateFor(s0.id).you.seen.length === 1 && g5.room.stateFor(s0.id).you.seen[0].card === 'library' && g5.room.stateFor(s1.id).you.seen.length === 0 && g5.room.stateFor(s2.id).you.seen.length === 0);
  check('공개 정보에는 누가 보여 줬는지만 있고 카드는 없다', (() => { const last = g5.room.stateFor(s2.id).lastSuggestion; return last.shownBy === s1.id && !JSON.stringify(last).includes('"card"') && !g5.room.stateFor(s2.id).history.some((h) => /library|서재 카드/.test(h.text) && /보여 주었습니다/.test(h.text) && /서재를/.test(h.text)); })());
  check('보여 주기가 끝나면 추측 뒤 단계다', g5.room._debug().step === 'end' && g5.room._debug().pending === null);
  check('한 차례에 두 번 추측할 수 없다', /추측할 수 없습니다/.test(g5.room.suggest(s0.id, 'plum', 'rope') || ''));
  g5.room.endTurn(s0.id);

  // 불려 온 2번 차례: 굴리지 않고 바로 추측(플럼이 서재에 있다)
  g5.room.endTurn(s1.id); // 1번은 건너뛴다
  check('2번 차례에 추측 가능 표시가 켜진다(굴리기 전)', g5.room.stateFor(s2.id).you.canSuggest === true && g5.room.stateFor(s2.id).you.canRoll === true);
  // 서재 카드를 가진 사람이 없게 하고, 아무도 반박 못 하는 조합으로 추측한다
  g5.room._debug().setHand(s1.id, ['candlestick', 'wrench']);
  check('서재에서 아무도 반박 못 하는 추측이면 보여 주는 사람이 없다', g5.room.suggest(s2.id, 'white', 'rope') === null && g5.room.stateFor(s2.id).lastSuggestion.shownBy === null && g5.room._debug().step === 'end');
  check('불려 온 표시는 쓰고 나면 사라진다', g5.room._debug().seats[2].summoned === false);
  g5.room.endTurn(s2.id);

  // 한 장만 가진 경우는 자동으로 보여 준다
  g5.room._debug().setPosition(s0.suspect, { room: 'study' });
  g5.room._debug().setPosition('white', { room: 'study' }); // 어디든
  g5.room._debug().seats[0].summoned = true;
  check('가진 카드가 한 장뿐이어도 자동으로 보여 주지 않고 가진 사람이 직접 고른다', g5.room.suggest(s0.id, 'plum', 'rope') === null && g5.room._debug().step === 'disprove' && g5.room._debug().pending.disproverId === s2.id && g5.room._debug().pending.options.length === 1 && g5.room.stateFor(s0.id).you.seen.length === 1);
  check('한 장이어도 고르는 창은 반박할 사람에게만 간다', !!g5.room.stateFor(s2.id).you.disprove && g5.room.stateFor(s2.id).you.disprove.options.length === 1 && g5.room.stateFor(s1.id).you.disprove === null && g5.room.stateFor(s0.id).you.disprove === null);
  check('한 장짜리도 눌러서 보여 주면 추측한 사람에게 간다', g5.room.show(s2.id, 'plum') === null && g5.room.stateFor(s0.id).you.seen.some((x) => x.card === 'plum' && x.byId === s2.id) && g5.room._debug().step === 'end');
  g5.room.dispose();

  // 시계 방향 순서: 0번이 추측하면 1번 → 2번 순서로 본다
  const g6 = game(['가', '나', '다', '라']);
  const q = g6.dbg.seats;
  g6.room._debug().setSolution({ suspect: 'green', weapon: 'rope', room: 'kitchen' });
  g6.room._debug().setHand(q[0].id, ['mustard']);
  g6.room._debug().setHand(q[1].id, ['dagger']);
  g6.room._debug().setHand(q[2].id, ['plum']);
  g6.room._debug().setHand(q[3].id, ['revolver']);
  g6.room._debug().setPosition(q[0].suspect, { room: 'hall' });
  g6.room._debug().seats[0].summoned = true;
  g6.room.suggest(q[0].id, 'plum', 'dagger');
  g6.room.show(q[1].id, 'dagger');
  check('추측한 사람 다음부터 시계 방향으로 첫 사람이 보여 준다(둘 다 가졌으면 가까운 쪽)', g6.room.stateFor(q[0].id).you.seen[0].byId === q[1].id && g6.room.stateFor(q[0].id).lastSuggestion.passed.length === 0);
  g6.room.endTurn(q[0].id);
  g6.room._debug().setPosition(q[1].suspect, { room: 'hall' });
  g6.room._debug().seats[1].summoned = true;
  g6.room.suggest(q[1].id, 'white', 'revolver');
  g6.room.show(q[3].id, 'revolver');
  check('앞사람이 못 보여 주면 지나치고 그다음 사람이 보여 준다(지나친 사람이 공개된다)', g6.room.stateFor(q[1].id).you.seen[0].byId === q[3].id && JSON.stringify(g6.room.stateFor(q[0].id).lastSuggestion.passed) === JSON.stringify([q[2].id]));
  g6.room.dispose();
  console.log('\n=== 제자리에 있기 ===');
  const gs = game(['가', '나', '다']);
  const st = gs.dbg.seats;
  check('굴리기 전에는 제자리에 있을 수 없다', /먼저 주사위/.test(gs.room.stay(st[0].id) || ''));
  gs.room.roll(st[0].id);
  check('남의 차례에는 제자리에 있을 수 없다', /내 차례가 아닙니다/.test(gs.room.stay(st[1].id) || ''));
  check('이동 단계에는 제자리에 있기가 켜져 있다(나에게만)', gs.room.stateFor(st[0].id).you.canStay === true && gs.room.stateFor(st[1].id).you.canStay === false);
  check('복도에서 제자리에 있으면 끝 단계가 되고 그 자리에 그대로다', (() => { const before = JSON.stringify(gs.room._debug().positions[st[0].suspect]); return gs.room.stay(st[0].id) === null && gs.room._debug().step === 'end' && JSON.stringify(gs.room._debug().positions[st[0].suspect]) === before; })());
  check('한 차례에 두 번 머물 수 없다', /이미 움직였습니다/.test(gs.room.stay(st[0].id) || '') && /이미 움직였습니다/.test(gs.room.move(st[0].id, { x: 0, y: 0 }) || ''));
  gs.room.endTurn(st[0].id);
  // 방 안에서 머물기: 제자리가 방 안이면 그 방에서 추측을 시작한다(직전에 추측한 방이어도 된다)
  gs.room._debug().setPosition(st[1].suspect, { room: 'hall' });
  gs.room.roll(st[1].id);
  check('방 안에서 제자리에 있으면 그 방에서 추측할 수 있다', gs.room.stay(st[1].id) === null && gs.room._debug().step === 'suggest' && gs.room.stateFor(st[1].id).you.canSuggest === true);
  gs.room.suggest(st[1].id, 'plum', 'rope');
  if (gs.room._debug().step === 'disprove') gs.room.show(gs.room._debug().pending.disproverId, gs.room._debug().pending.options[0]);
  gs.room.endTurn(st[1].id);
  gs.room.endTurn(st[2].id);
  gs.room.roll(st[0].id); gs.room.endTurn(st[0].id);
  gs.room.roll(st[1].id);
  check('직전에 추측한 방에 그대로 머물어도 그 방에서 다시 추측을 시작할 수 있다', gs.room._debug().positions[st[1].suspect].room === 'hall' && gs.room.stay(st[1].id) === null && gs.room._debug().step === 'suggest' && gs.room.stateFor(st[1].id).you.canSuggest === true);
  gs.room.endTurn(st[1].id);
  gs.room.dispose();


  console.log('\n=== 힌트 카드(힌트 칸에서 이동을 마치면 한 장) ===');
  check('힌트 칸은 모두 복도 칸이고 문·말 시작 칸과 겹치지 않는다', HINT_CELLS.every(([x, y]) => isCorridor(x, y) && !ROOMS.some((r) => r.doors.some(([dx, dy]) => dx === x && dy === y)) && !SUSPECTS.some((sp) => sp.start.x === x && sp.start.y === y)));
  check('보드 정보에 힌트 칸이 실린다', MAP.hintCells.length === HINT_CELLS.length);
  const gk2 = game(['가', '나', '다']);
  const hk = gk2.dbg.seats;
  gk2.room._debug().setDeck(['peek', 'extraSuggest', 'extraTurn']); // 뒤에서부터 뽑는다: 턴 한 번 더 -> 추리 한 번 더 -> 같이 보기
  gk2.room._debug().setPosition(hk[0].suspect, { x: 6, y: 3 });
  gk2.room.roll(hk[0].id); gk2.room._debug().setDice([1, 1]);
  check('힌트 칸에서 이동을 마치면 힌트 카드를 한 장 뽑는다', gk2.room.move(hk[0].id, { x: 6, y: 2 }) === null && hk[0].extraTurns === 1 && gk2.room.stateFor(hk[0].id).you.drew.kind === 'extraTurn');
  check('턴 한 번 더는 모두에게 공개되고 바로 쓰인다(남은 횟수가 보인다)', gk2.room.stateFor(hk[1].id).lastHintDraw.kind === 'extraTurn' && gk2.room.stateFor(hk[1].id).board[0].extraTurns === 1 && gk2.room.stateFor(hk[0].id).you.hints.length === 0);
  gk2.room.endTurn(hk[0].id);
  check('차례가 끝나도 같은 사람이 한 번 더 진행한다(턴 한 번 더)', gk2.room._debug().turn === 0 && gk2.room._debug().step === 'start' && hk[0].extraTurns === 0 && gk2.room._debug().dice === null);
  gk2.room._debug().setPosition(hk[0].suspect, { x: 6, y: 3 });
  gk2.room.roll(hk[0].id); gk2.room._debug().setDice([1, 1]);
  gk2.room.move(hk[0].id, { x: 6, y: 2 });
  check('추리 한 번 더는 가진 사람에게만 보이고 남에게는 장수만 간다', JSON.stringify(gk2.room.stateFor(hk[0].id).you.hints) === '["extraSuggest"]' && gk2.room.stateFor(hk[1].id).you.hints.length === 0 && gk2.room.stateFor(hk[1].id).lastHintDraw.kind === null && gk2.room.stateFor(hk[1].id).board[0].hints === 1);
  check('방 밖(복도)에서는 추리 한 번 더를 쓸 수 없다', /방 안/.test(gk2.room.useHint(hk[0].id, 'extraSuggest') || '') && gk2.room.stateFor(hk[0].id).you.canExtraSuggest === false);
  check('지나가기만 하고 힌트 칸에서 멈추지 않으면 뽑지 않는다', (() => {
    const gp = game(['가', '나']);
    const ps = gp.dbg.seats;
    gp.room._debug().setDeck(['peek']);
    gp.room._debug().setPosition(ps[0].suspect, { x: 6, y: 4 });
    gp.room.roll(ps[0].id); gp.room._debug().setDice([1, 1]);
    gp.room.move(ps[0].id, { x: 6, y: 3 }); // 힌트 칸(6,2)의 바로 앞에서 멈춘다
    const ok = ps[0].hints.length === 0 && gp.room._debug().hintDeck().length === 1;
    gp.room.dispose();
    return ok;
  })());
  gk2.room.dispose();

  const gd = game(['가', '나']);
  const dd = gd.dbg.seats;
  gd.room._debug().setPosition(dd[0].suspect, { x: 6, y: 3 });
  gd.room.roll(dd[0].id); gd.room._debug().setDice([1, 1]);
  gd.room.move(dd[0].id, { x: 6, y: 2 });
  const drawnKind = gd.room.stateFor(dd[0].id).you.drew.kind;
  const rest = gd.room._debug().hintDeck();
  const countOf = (kind) => rest.filter((k) => k === kind).length + (drawnKind === kind ? 1 : 0);
  check('덱은 3종 각 4장(12장)을 섞은 것이고 한 장 뽑으면 11장이 남는다', rest.length === 11 && countOf('extraTurn') === 4 && countOf('extraSuggest') === 4 && countOf('peek') === 4);
  gd.room.dispose();

  // 추리 한 번 더
  const gx = game(['가', '나', '다']);
  const xs = gx.dbg.seats;
  for (const seat of xs) gx.room._debug().setHand(seat.id, []);
  gx.room._debug().setPosition(xs[0].suspect, { room: 'hall' });
  gx.room._debug().seats[0].summoned = true;
  gx.room._debug().setHints(xs[0].id, ['extraSuggest']);
  gx.room.suggest(xs[0].id, 'plum', 'rope');
  check('추리가 끝난 뒤 방 안이면 추리 한 번 더를 쓸 수 있다고 알려 준다', gx.room._debug().step === 'end' && gx.room.stateFor(xs[0].id).you.canExtraSuggest === true && gx.room.stateFor(xs[1].id).you.canExtraSuggest === false);
  check('남의 차례에는 쓸 수 없다', /내 차례/.test(gx.room.useHint(xs[1].id, 'extraSuggest') || ''));
  check('추리 한 번 더를 쓰면 카드가 사라지고 같은 방에서 다시 추리할 수 있다', gx.room.useHint(xs[0].id, 'extraSuggest') === null && gx.room._debug().step === 'suggest' && gx.room.stateFor(xs[0].id).you.hints.length === 0 && gx.room.stateFor(xs[0].id).you.canSuggest === true);
  check('쓴 카드는 다시 쓸 수 없다', /추리가 끝난 뒤|없습니다/.test(gx.room.useHint(xs[0].id, 'extraSuggest') || ''));
  check('한 번 더 추리가 기록에 남는다(추측 2건)', gx.room.suggest(xs[0].id, 'white', 'dagger') === null && gx.room.stateFor(xs[1].id).suggestions.length === 2);
  gx.room.dispose();

  // 같이 보기
  const gy = game(['가', '나', '다']);
  const ys = gy.dbg.seats;
  gy.room._debug().setSolution({ suspect: 'green', weapon: 'rope', room: 'kitchen' });
  gy.room._debug().setHand(ys[0].id, ['mustard']);
  gy.room._debug().setHand(ys[1].id, ['dagger']);
  gy.room._debug().setHand(ys[2].id, ['hall']);
  gy.room._debug().setPosition(ys[0].suspect, { room: 'study' });
  gy.room._debug().seats[0].summoned = true;
  for (const seat of ys) gy.room._debug().setHints(seat.id, ['peek']);
  gy.room.suggest(ys[0].id, 'white', 'dagger');
  check('카드를 고르는 중에는 같이 볼 수 없다', gy.room.stateFor(ys[2].id).you.canPeek === false && /같이 볼 수 있는 추리가 없습니다/.test(gy.room.useHint(ys[2].id, 'peek') || ''));
  gy.room.show(ys[1].id, 'dagger');
  check('카드가 보여진 직후에는 추리한 사람·보여 준 사람이 아닌 사람만 같이 볼 수 있다', gy.room.stateFor(ys[2].id).you.canPeek === true && gy.room.stateFor(ys[0].id).you.canPeek === false && gy.room.stateFor(ys[1].id).you.canPeek === false);
  check('추리한 사람은 같이 보기를 쓸 수 없다', /이미 알고/.test(gy.room.useHint(ys[0].id, 'peek') || ''));
  check('같이 보기를 쓰면 그 카드를 보고 카드는 사라진다', gy.room.useHint(ys[2].id, 'peek') === null && gy.room.stateFor(ys[2].id).you.peeked.length === 1 && gy.room.stateFor(ys[2].id).you.peeked[0].card === 'dagger' && gy.room.stateFor(ys[2].id).you.hints.length === 0);
  check('같이 본 카드는 본 사람에게만 간다', gy.room.stateFor(ys[0].id).you.peeked.length === 0 && gy.room.stateFor(ys[1].id).you.peeked.length === 0 && !JSON.stringify(gy.room.stateFor(ys[1].id)).includes('"peeked":[{'));
  check('이미 같이 본 추리는 다시 볼 수 없다', gy.room.stateFor(ys[2].id).you.canPeek === false && /이미|없습니다/.test(gy.room.useHint(ys[2].id, 'peek') || ''));
  gy.room.endTurn(ys[0].id);
  gy.room._debug().setHints(ys[2].id, ['peek']);
  gy.room._debug().setPosition(ys[1].suspect, { room: 'study' });
  gy.room._debug().seats[1].summoned = true;
  for (const seat of ys) gy.room._debug().setHand(seat.id, []);
  gy.room.suggest(ys[1].id, 'plum', 'rope'); // 아무도 못 보여 준다
  check('아무도 카드를 못 보여 준 추리는 같이 볼 카드가 없다', gy.room.stateFor(ys[2].id).you.canPeek === false);
  gy.room.dispose();

  // 추리 한 번 더 카드가 있으면 방 안에서는 자동으로 차례가 끝나지 않는다(버튼을 누를 시간을 준다)
  const ga2 = game(['가', '나'], { autoEndMs: 40 });
  const as = ga2.dbg.seats;
  for (const seat of as) ga2.room._debug().setHand(seat.id, []);
  ga2.room._debug().setPosition(as[0].suspect, { room: 'hall' });
  ga2.room._debug().seats[0].summoned = true;
  ga2.room._debug().setHints(as[0].id, ['extraSuggest']);
  ga2.room.suggest(as[0].id, 'plum', 'rope');
  await sleep(160);
  check('추리 한 번 더 카드를 들고 방 안에 있으면 3초 자동 종료를 하지 않는다', ga2.room._debug().turn === 0 && ga2.room._debug().step === 'end');
  ga2.room.useHint(as[0].id, 'extraSuggest');
  ga2.room.suggest(as[0].id, 'white', 'dagger');
  ga2.room._debug().setHints(as[0].id, []);
  await sleep(160);
  check('카드를 다 쓰면 다시 자동으로 차례가 넘어간다', ga2.room._debug().turn === 1);
  ga2.room.dispose();

  console.log('\n=== 정답 봉투 방(고발은 여기서만) ===');
  const ge = game(['가', '나', '다']);
  const e = ge.dbg.seats;
  ge.room._debug().setSolution({ suspect: 'green', weapon: 'rope', room: 'kitchen' });
  check('봉투 방은 문 칸에서 한 칸이면 들어갈 수 있다(위·아래·좌·우)', [[10, 7], [13, 16], [8, 11], [15, 13]].every(([x, y]) => computeReach({ x, y }, 1).rooms.includes('envelope')));
  check('무도회장 문 칸은 봉투 방 문이 아니다(각자 자기 방으로만 들어간다)', !computeReach({ x: 11, y: 7 }, 1).rooms.includes('envelope') && computeReach({ x: 11, y: 7 }, 1).rooms.includes('ballroom'));
  check('봉투 방에서는 8개 문 칸으로 나갈 수 있다', computeReach({ room: 'envelope' }, 1).cells.length === 8);
  check('복도에서 고발하면 안내와 함께 거절되고 탈락하지 않는다', /정답 봉투 방/.test(ge.room.accuse(e[0].id, 'green', 'rope', 'kitchen') || '') && e[0].eliminated === false);
  check('고발 버튼은 봉투 방에 있을 때만 켜진다', ge.room.stateFor(e[0].id).you.canAccuse === false);
  ge.room._debug().setPosition(e[0].suspect, { x: 10, y: 7 });
  ge.room.roll(e[0].id); ge.room._debug().setDice([1, 1]);
  check('굴려서 봉투 방에 들어가면 끝 단계가 되고 고발할 수 있다', ge.room.move(e[0].id, { room: 'envelope' }) === null && ge.room._debug().step === 'end' && ge.room._debug().positions[e[0].suspect].room === 'envelope' && ge.room.stateFor(e[0].id).you.canAccuse === true);
  check('봉투 방에서는 추측할 수 없다', ge.room.stateFor(e[0].id).you.canSuggest === false && /정답 봉투 방에서는 추측/.test(ge.room.suggest(e[0].id, 'plum', 'rope') || ''));
  check('남의 고발 버튼은 켜지지 않는다', ge.room.stateFor(e[1].id).you.canAccuse === false);
  ge.room.endTurn(e[0].id); ge.room.endTurn(e[1].id); ge.room.endTurn(e[2].id);
  check('봉투 방 안에서 차례를 시작하면 굴리기 전에도 고발할 수 있다', turnName(ge) === e[0].nickname && ge.room.stateFor(e[0].id).you.canAccuse === true && ge.room.stateFor(e[0].id).you.canRoll === true);
  ge.room.roll(e[0].id);
  check('봉투 방에서 제자리에 있으면 추측 없이 끝 단계다', ge.room.stay(e[0].id) === null && ge.room._debug().step === 'end' && ge.room.stateFor(e[0].id).you.canSuggest === false && ge.room.stateFor(e[0].id).you.canAccuse === true);
  check('봉투 방에서 맞게 고발하면 승리한다', ge.room.accuse(e[0].id, 'green', 'rope', 'kitchen') === null && ge.room.stateFor(e[1].id).result.winnerId === e[0].id);
  ge.room.dispose();

  console.log('\n=== 추리 기록(내 추리 / 상대 추리를 따로 볼 수 있게 모두 남긴다) ===');
  const gr = game(['가', '나', '다']);
  const lg = gr.dbg.seats;
  gr.room._debug().setSolution({ suspect: 'green', weapon: 'rope', room: 'kitchen' });
  gr.room._debug().setHand(lg[0].id, ['mustard']);
  gr.room._debug().setHand(lg[1].id, ['dagger']);
  gr.room._debug().setHand(lg[2].id, ['hall']);
  check('처음에는 추리 기록이 비어 있다', gr.room.stateFor(lg[0].id).suggestions.length === 0);
  gr.room._debug().setPosition(lg[0].suspect, { room: 'study' });
  gr.room._debug().seats[0].summoned = true;
  gr.room.suggest(lg[0].id, 'white', 'dagger');
  const pendingLog = gr.room.stateFor(lg[2].id).suggestions;
  check('추측하면 카드를 고르는 중에도 기록에 올라간다(결과는 아직 없음)', pendingLog.length === 1 && pendingLog[0].byId === lg[0].id && pendingLog[0].resolved === false && pendingLog[0].shownBy === null);
  gr.room.show(lg[1].id, 'dagger');
  const doneLog = gr.room.stateFor(lg[2].id).suggestions;
  check('카드를 보여 주면 누가 보여 줬는지가 기록에 반영된다', doneLog[0].resolved === true && doneLog[0].shownBy === lg[1].id && doneLog[0].suspect === 'white' && doneLog[0].weapon === 'dagger' && doneLog[0].room === 'study');
  check('기록에는 카드 이름이 없다(모두에게 보여도 되는 정보만)', !JSON.stringify(doneLog).includes('"card"') && !JSON.stringify(gr.room.stateFor(lg[2].id).suggestions).includes('dagger"') === false);
  check('추측한 사람이 받은 카드는 같은 번호(seq)로 기록과 이어진다', gr.room.stateFor(lg[0].id).you.seen[0].seq === doneLog[0].seq && gr.room.stateFor(lg[2].id).you.seen.length === 0);
  gr.room.endTurn(lg[0].id);
  for (const seat of lg) gr.room._debug().setHand(seat.id, []);
  gr.room._debug().setPosition(lg[1].suspect, { room: 'study' });
  gr.room._debug().seats[1].summoned = true;
  gr.room.suggest(lg[1].id, 'plum', 'rope');
  const twoLog = gr.room.stateFor(lg[0].id).suggestions;
  check('아무도 못 보여 준 추측도 기록에 남는다(보여 준 사람 없음)', twoLog.length === 2 && twoLog[1].byId === lg[1].id && twoLog[1].resolved === true && twoLog[1].shownBy === null);
  check('모두가 같은 기록을 본다(남의 추측도 보인다)', JSON.stringify(gr.room.stateFor(lg[2].id).suggestions) === JSON.stringify(twoLog) && JSON.stringify(gr.room.stateFor(lg[1].id).suggestions) === JSON.stringify(twoLog));
  check('내 추측·남의 추측을 byId로 나눌 수 있다', twoLog.filter((x) => x.byId === lg[0].id).length === 1 && twoLog.filter((x) => x.byId !== lg[0].id).length === 1);
  gr.room.endTurn(lg[1].id);
  gr.room._debug().setPosition(lg[2].suspect, { room: 'envelope' });
  gr.room.accuse(lg[2].id, 'green', 'rope', 'kitchen');
  check('끝난 뒤에도 기록은 남고', gr.room.stateFor(lg[0].id).phase === 'result' && gr.room.stateFor(lg[0].id).suggestions.length === 2);
  check('새 판을 시작하면 기록이 비워진다', gr.room.begin(lg[0].id) === null && gr.room.stateFor(lg[0].id).suggestions.length === 0);
  gr.room.dispose();

  console.log('\n=== 고발 ===');
  const g7 = game(['가', '나', '다']);
  const p = g7.dbg.seats;
  g7.room._debug().setSolution({ suspect: 'green', weapon: 'rope', room: 'kitchen' });
  check('남의 차례에 고발하면 거절된다', /내 차례가 아닙니다/.test(g7.room.accuse(p[1].id, 'green', 'rope', 'kitchen') || ''));
  check('모르는 카드로 고발하면 거절된다', /알 수 없는/.test(g7.room.accuse(p[0].id, 'x', 'rope', 'kitchen') || '') && /알 수 없는 장소/.test(g7.room.accuse(p[0].id, 'green', 'rope', 'moon') || ''));
  check('정답 봉투 방이 아닌 곳(복도)에서는 고발할 수 없다', /정답 봉투 방/.test(g7.room.accuse(p[0].id, 'green', 'rope', 'kitchen') || '') && p[0].eliminated === false && g7.room._debug().phase === 'playing');
  g7.room._debug().setPosition(p[0].suspect, { room: 'hall' });
  check('다른 방 안에서도 고발할 수 없다', /정답 봉투 방/.test(g7.room.accuse(p[0].id, 'green', 'rope', 'kitchen') || '') && p[0].eliminated === false);
  g7.room._debug().setPosition(p[0].suspect, { room: 'envelope' });
  check('틀린 고발은 탈락이고 차례가 넘어간다(정답은 안 알려 준다)', g7.room.accuse(p[0].id, 'plum', 'rope', 'kitchen') === null && p[0].eliminated === true && turnName(g7) === p[1].nickname && g7.room.stateFor(p[1].id).result === null && g7.room.stateFor(p[1].id).phase === 'playing');
  check('오답 고발로 탈락하면 가진 카드가 모두에게 공개된다(다른 사람 화면의 board에도 보인다)', (() => {
    const mine = g7.room._debug().seats[0].hand.slice().sort().join();
    const seen = g7.room.stateFor(p[2].id).board.find((b) => b.id === p[0].id);
    const a = g7.room.stateFor(p[2].id).lastAccusation;
    return mine.length > 0 && seen.eliminated === true && seen.opened.slice().sort().join() === mine && a.opened.slice().sort().join() === mine;
  })());
  check('탈락하지 않은 사람의 카드는 공개되지 않는다', g7.room.stateFor(p[2].id).board.filter((b) => !b.eliminated).every((b) => b.opened.length === 0));
  check('탈락한 사람은 더 조작할 수 없다', /내 차례가 아닙니다/.test(g7.room.roll(p[0].id) || '') && g7.room.stateFor(p[0].id).you.eliminated === true && g7.room.stateFor(p[0].id).you.myTurn === false);
  check('틀린 고발은 누가 무엇으로 고발했고 틀렸는지가 모두에게 보인다(알림용)', (() => {
    const a = g7.room.stateFor(p[2].id).lastAccusation;
    return !!a && a.seq === 1 && a.byId === p[0].id && a.correct === false && a.suspect === 'plum' && a.weapon === 'rope' && a.room === 'kitchen';
  })());
  g7.room.endTurn(p[1].id);
  g7.room.endTurn(p[2].id);
  check('탈락한 사람은 차례에서 건너뛴다', turnName(g7) === p[1].nickname);
  // [규칙] 탈락한 사람은 판에서 빠진다: 카드는 오답 고발 때 모두에게 공개되고, 더 반박하지 않는다.
  g7.room._debug().setHand(p[0].id, ['wrench']);
  g7.room._debug().setHand(p[1].id, ['mustard']);
  g7.room._debug().setHand(p[2].id, ['hall']);
  g7.room._debug().setPosition(p[1].suspect, { room: 'study' });
  g7.room._debug().seats[1].summoned = true;
  g7.room.suggest(p[1].id, 'white', 'wrench');
  check('탈락한 사람은 카드를 갖고 있어도 반박하지 않는다(없는 사람처럼 건너뛴다)', g7.room.stateFor(p[1].id).step !== 'disprove' && !g7.room.stateFor(p[1].id).you.seen.some((x) => x.byId === p[0].id));
  g7.room._debug().setPosition(p[1].suspect, { room: 'envelope' });
  check('맞는 고발이면 승리하고 정답이 공개된다', g7.room.accuse(p[1].id, 'green', 'rope', 'kitchen') === null && g7.room.stateFor(p[2].id).phase === 'result' && g7.room.stateFor(p[2].id).result.winnerId === p[1].id && g7.room.stateFor(p[2].id).result.solution.room === 'kitchen');
  check('맞는 고발도 결과가 모두에게 보인다(번호가 늘고 correct가 true)', (() => {
    const a = g7.room.stateFor(p[2].id).lastAccusation;
    return !!a && a.seq === 2 && a.byId === p[1].id && a.correct === true && g7.room.stateFor(p[0].id).lastAccusation.seq === 2;
  })());
  check('끝난 판의 참가자는 자동으로 준비된다', g7.room.stateFor(p[2].id).you.ready === true && g7.room.stateFor(p[2].id).canStart === true);
  check('끝난 판에서는 더 조작할 수 없다', /진행 중인 게임이 없습니다/.test(g7.room.roll(p[2].id) || ''));
  check('다시 시작하면 새 판이 된다(탈락·카드·정답이 새로 정해진다)', g7.room.begin(p[2].id) === null && g7.room._debug().seats.every((s) => !s.eliminated) && g7.room.stateFor(p[2].id).phase === 'playing' && g7.room.stateFor(p[2].id).lastAccusation === null);
  g7.room.dispose();

  const g8 = game(['가', '나']);
  const duo = g8.dbg.seats;
  g8.room._debug().setSolution({ suspect: 'green', weapon: 'rope', room: 'kitchen' });
  g8.room._debug().setPosition(duo[0].suspect, { room: 'envelope' });
  g8.room.accuse(duo[0].id, 'plum', 'rope', 'kitchen');
  check('둘이 하다 한 명이 틀리면 남은 사람이 이긴다', g8.room.stateFor(duo[1].id).phase === 'result' && g8.room.stateFor(duo[1].id).result.winnerId === duo[1].id && g8.room.stateFor(duo[1].id).result.reason === 'lastStanding');
  g8.room.dispose();

  console.log('\n=== 이동 막힘(말이 선 칸) ===');
  const g9 = game(['가', '나', '다']);
  const w = g9.dbg.seats;
  g9.room._debug().setPosition(w[0].suspect, { x: 6, y: 3 });
  g9.room._debug().setPosition(w[1].suspect, { x: 7, y: 3 }); // 문 칸을 다른 말이 막았다
  g9.room.roll(w[0].id); g9.room._debug().setDice([1, 1]);
  const reach9 = g9.room.stateFor(w[0].id).you.reach;
  check('문 칸에 다른 말이 서 있으면 그 문으로 못 들어가고 칸에도 못 선다', !reach9.rooms.includes('ballroom') && !reach9.cells.some((c) => c.x === 7 && c.y === 3));
  g9.room.dispose();

  console.log('\n=== 시작 전에 말 고르기 ===');
  const gp = createClueRoom({ random: lcg(3), autoEndMs: 0 });
  const pid = ['가', '나', '다'].map((n) => gp.join({ nickname: n }).playerId);
  const ghost = gp.join({ nickname: '구경' }).playerId; // 안 뛰는 사람
  check('시작 전에 말을 고를 수 있고 모두에게 보인다', gp.pickSuspect(pid[0], 'plum') === null && gp.stateFor(pid[0]).you.pick === 'plum' && gp.stateFor(pid[1]).picks.plum.id === pid[0] && gp.stateFor(pid[1]).picks.plum.nickname === '가');
  check('다른 사람이 고른 말은 고를 수 없다', /이미 가님이 골랐습니다/.test(gp.pickSuspect(pid[1], 'plum') || '') && gp.stateFor(pid[1]).you.pick === null);
  check('모르는 말은 거절된다', /알 수 없는 말/.test(gp.pickSuspect(pid[1], 'nobody') || ''));
  check('고른 것을 풀면 다른 사람이 고를 수 있다', gp.pickSuspect(pid[0], null) === null && gp.pickSuspect(pid[1], 'plum') === null && gp.pickSuspect(pid[1], null) === null);
  gp.pickSuspect(pid[0], 'scarlett'); gp.pickSuspect(pid[2], 'green'); gp.pickSuspect(ghost, 'peacock');
  for (const id of pid) gp.setReady(id, true);
  check('시작하면 고른 말을 그대로 받고 안 고른 사람은 남은 말을 받는다(겹침 없음)', (() => {
    if (gp.begin(pid[0]) !== null) return false;
    const seat = (id) => gp._debug().seats.find((x) => x.id === id);
    const got = gp._debug().seats.map((x) => x.suspect);
    return seat(pid[0]).suspect === 'scarlett' && seat(pid[2]).suspect === 'green' && new Set(got).size === 3 && !['scarlett', 'green'].includes(seat(pid[1]).suspect);
  })());
  check('안 뛰는 사람이 골라 둔 말은 피해서 나눈다', gp._debug().seats.every((x) => x.suspect !== 'peacock'));
  check('게임 중에는 말을 바꿀 수 없다', /게임이 끝난 뒤/.test(gp.pickSuspect(pid[0], 'white') || ''));
  gp.dispose();

  console.log('\n=== 자동 차례 종료(방에 안 들어가거나 추측이 끝나면 곧 넘어간다) ===');
  const ga = game(['가', '나', '다'], { autoEndMs: 50 });
  const au = ga.dbg.seats;
  ga.room.roll(au[0].id); ga.room._debug().setDice([1, 1]);
  const cell0 = ga.room.stateFor(au[0].id).you.reach.cells[0];
  ga.room.move(au[0].id, cell0);
  check('복도로 이동하면 자동 종료가 예약되고 남은 시각이 상태에 실린다', ga.room._debug().step === 'end' && typeof ga.room.stateFor(au[1].id).autoEndsAt === 'number');
  await sleep(150);
  check('잠시 뒤 차례가 자동으로 다음 사람에게 넘어간다', ga.room._debug().turn === 1 && ga.room._debug().step === 'start' && ga.room.stateFor(au[1].id).autoEndsAt === null);
  ga.room._debug().setPosition(au[1].suspect, { x: 7, y: 3 });
  ga.room.roll(au[1].id); ga.room._debug().setDice([1, 2]);
  ga.room.move(au[1].id, { room: 'ballroom' });
  await sleep(150);
  check('방에 들어가 추측을 고르는 동안에는 자동으로 넘어가지 않는다', ga.room._debug().turn === 1 && ga.room._debug().step === 'suggest');
  for (const seat of au) ga.room._debug().setHand(seat.id, []);
  ga.room.suggest(au[1].id, 'plum', 'rope');
  check('추측이 끝나면 끝 단계가 되고', ga.room._debug().step === 'end' && typeof ga.room.stateFor(au[1].id).autoEndsAt === 'number');
  await sleep(150);
  check('잠시 뒤 차례가 자동으로 넘어간다(카드를 본 뒤도 마찬가지)', ga.room._debug().turn === 2 && ga.room._debug().step === 'start');
  ga.room._debug().setPosition(au[2].suspect, { x: 10, y: 7 });
  ga.room.roll(au[2].id); ga.room._debug().setDice([1, 1]);
  ga.room.move(au[2].id, { room: 'envelope' });
  await sleep(150);
  check('정답 봉투 방에서는 고발할 수 있게 자동으로 넘어가지 않는다', ga.room._debug().turn === 2 && ga.room._debug().step === 'end' && ga.room.stateFor(au[2].id).you.canAccuse === true && ga.room.stateFor(au[2].id).autoEndsAt === null);
  ga.room.dispose();

  const gm = game(['가', '나'], { autoEndMs: 80 });
  const mm = gm.dbg.seats;
  gm.room.roll(mm[0].id); gm.room._debug().setDice([1, 1]);
  gm.room.move(mm[0].id, gm.room.stateFor(mm[0].id).you.reach.cells[0]);
  gm.room.endTurn(mm[0].id);
  await sleep(200);
  check('직접 차례를 끝내면 예약된 자동 종료가 취소되어 다음 사람 차례를 건드리지 않는다', gm.room._debug().turn === 1 && gm.room._debug().step === 'start');
  gm.room.dispose();

  console.log('\n=== 30초 동안 안 굴리면 서버가 대신 진행 ===');
  const gt = game(['가', '나']);
  check('굴리기 전 제한시간(기본 30초)이 상태에 실린다', gt.room.stateFor(gt.id('가')).autoRollSec === 30 && gt.room.stateFor(gt.id('가')).turnEndsAt - Date.now() <= 30000 + 50 && gt.room.stateFor(gt.id('가')).turnEndsAt - Date.now() > 28000);
  gt.room.dispose();

  // 가장 가까운 방: 눈이 12(6+6)라 주방(3걸음)·무도회장(5걸음) 모두 닿지만 가까운 주방을 고른다
  const gn = game(['가', '나'], { random: () => 0.99, autoRollMs: 40, turnTimeoutMs: 0, disproveTimeoutMs: 0 });
  const nn = gn.dbg.seats;
  gn.room._debug().setPosition(nn[0].suspect, { x: 6, y: 6 });
  await sleep(200);
  const sn = gn.room.stateFor(nn[0].id);
  check('안 굴리면 대신 굴려 가장 가까운 방(주방)으로 들어간다', gn.room._debug().positions[nn[0].suspect].room === 'kitchen' && gn.room._debug().dice.join() === '6,6');
  check('그 방에서 자동으로 추측한다(내가 모르는 범인·흉기로)', !!sn.lastSuggestion && sn.lastSuggestion.byId === nn[0].id && sn.lastSuggestion.room === 'kitchen' && !nn[0].hand.includes(sn.lastSuggestion.suspect) && !nn[0].hand.includes(sn.lastSuggestion.weapon));
  check('자동으로 한 차례는 연속 시간 초과로 센다', nn[0].idle === 1);
  gn.room.dispose();

  // 이미 받은 카드는 피해서 추측한다
  const gk = game(['가', '나'], { random: () => 0.99, autoRollMs: 40, turnTimeoutMs: 0, disproveTimeoutMs: 0 });
  const kk = gk.dbg.seats;
  gk.room._debug().setHand(kk[0].id, ['mustard']);
  kk[0].seen.push({ card: 'plum', by: '나', byId: kk[1].id, suspect: 'plum', weapon: 'rope', room: 'hall' });
  gk.room._debug().setPosition(kk[0].suspect, { x: 6, y: 6 });
  await sleep(200);
  const lk = gk.room.stateFor(kk[0].id).lastSuggestion;
  check('내 카드·받은 카드는 빼고 아직 모르는 것만 골라 추측한다', !!lk && !['mustard', 'plum'].includes(lk.suspect));
  gk.room.dispose();

  // 눈이 낮아 방에 못 들어가면 갈 수 있는 무작위 칸으로 이동한다(눈 1+1=2)
  const gl = game(['가', '나'], { random: () => 0, autoRollMs: 40, turnTimeoutMs: 0, disproveTimeoutMs: 0 });
  const ll = gl.dbg.seats;
  gl.room._debug().setPosition(ll[0].suspect, { x: 0, y: 16 });
  await sleep(200);
  const at = gl.room._debug().positions[ll[0].suspect];
  check('눈이 낮아 방에 못 가면 갈 수 있는 복도 칸으로 이동하고 추측은 하지 않는다', at.x !== undefined && Math.abs(at.x - 0) + Math.abs(at.y - 16) <= 2 && !(at.x === 0 && at.y === 16) && gl.room.stateFor(ll[0].id).lastSuggestion === null && gl.room._debug().step === 'end');
  gl.room.dispose();

  // 직접 굴리면 굴리기 전 타이머는 사라진다(대신 굴리지 않는다)
  const gh = game(['가', '나'], { autoRollMs: 60, turnTimeoutMs: 0 });
  const hh = gh.dbg.seats;
  gh.room.roll(hh[0].id);
  const diceBefore = gh.room._debug().dice.join();
  await sleep(200);
  check('직접 굴린 차례는 대신 진행하지 않는다(굴림이 바뀌지 않고 이동 대기 그대로다)', gh.room._debug().step === 'move' && gh.room._debug().dice.join() === diceBefore && hh[0].idle === 0);
  gh.room.dispose();

  console.log('\n=== 제한시간·퇴장 ===');
  const t = game(['가', '나', '다'], { turnTimeoutMs: 40, disproveTimeoutMs: 40, autoRollMs: 40 });
  const t0 = turnName(t);
  await sleep(400);
  check('차례 제한시간이 지나면 차례가 넘어간다', turnName(t) !== t0 || t.room._debug().phase !== 'playing');
  t.room.dispose();

  const idle = game(['가', '나'], { turnTimeoutMs: 25, disproveTimeoutMs: 25, autoRollMs: 25 });
  await sleep(400);
  const gone = idle.dbg.seats.filter((s) => s.left).length;
  check('3번 연속 시간을 넘기면 게임에서 빠지고, 남은 사람이 이긴다', gone >= 1 && idle.room._debug().phase === 'result' && idle.room.stateFor(idle.id('가')).result.reason === 'lastStanding');
  idle.room.dispose();

  const dc = game(['가', '나', '다']);
  const d = dc.dbg.seats;
  dc.room._debug().setHand(d[1].id, ['dagger', 'candlestick']);
  dc.room._debug().setPosition(d[0].suspect, { room: 'hall' });
  dc.room._debug().seats[0].summoned = true;
  dc.room.suggest(d[0].id, 'plum', 'dagger'); // 1번이 한 장만 가졌어도 직접 눌러 보여 준다
  dc.room.show(d[1].id, 'dagger');
  dc.room._debug().seats[0].summoned = false;
  dc.room.endTurn(d[0].id);
  dc.room.leave(d[2].id);
  check('나가면 게임에서 빠지고 점수판에는 나갔다고 남는다', dc.room.stateFor(d[0].id).board.find((x) => x.id === d[2].id).left === true);
  check('둘이 남아도 계속된다', dc.room.stateFor(d[0].id).phase === 'playing');
  dc.room.leave(d[1].id);
  check('한 명만 남으면 그 사람이 이긴다', dc.room.stateFor(d[0].id).phase === 'result' && dc.room.stateFor(d[0].id).result.winnerId === d[0].id);
  dc.room.dispose();

  // 차례인 사람이 나가면 다음 사람에게 넘어간다
  const lv = game(['가', '나', '다']);
  const l = lv.dbg.seats;
  lv.room.leave(l[0].id);
  check('차례인 사람이 나가면 다음 사람 차례가 된다', lv.room._debug().seats[lv.room._debug().turn].id === l[1].id && lv.room._debug().step === 'start');
  lv.room.dispose();

  // 카드를 고르던 사람이 나가면 서버가 대신 보여 준다
  const ds = game(['가', '나', '다']);
  const m = ds.dbg.seats;
  ds.room._debug().setSolution({ suspect: 'green', weapon: 'rope', room: 'kitchen' });
  ds.room._debug().setHand(m[0].id, ['mustard']);
  ds.room._debug().setHand(m[1].id, ['dagger', 'plum']);
  ds.room._debug().setHand(m[2].id, ['hall']);
  ds.room._debug().setPosition(m[0].suspect, { room: 'study' });
  ds.room._debug().seats[0].summoned = true;
  ds.room.suggest(m[0].id, 'plum', 'dagger');
  check('두 장을 가진 사람이 고르는 단계가 된다', ds.room._debug().step === 'disprove');
  ds.room.leave(m[1].id);
  check('고르던 사람이 나가면 서버가 첫 번째 카드를 대신 보여 주고 이어 간다', ds.room._debug().step === 'end' && ds.room.stateFor(m[0].id).you.seen.length === 1);
  ds.room.dispose();

  console.log('\n=== 입장·재접속 ===');
  const rj = game(['가', '나']);
  const first = rj.dbg.seats[0];
  const token = rj.joined[first.nickname].token;
  rj.room.disconnect(first.id);
  check('끊겼다가 돌아오면 같은 자리·같은 카드로 이어 간다', (() => { const back = rj.room.join({ nickname: first.nickname, token }); return back.restored === true && rj.room.stateFor(first.id).you.hand.length === first.hand.length && rj.room.stateFor(first.id).you.suspect === first.suspect; })());
  rj.room.disconnect(first.id);
  await sleep(120);
  check('유예 안에 안 돌아오면 게임에서 빠진다', rj.dbg.seats.find((s) => s.id === first.id).left === true);
  rj.room.dispose();

  check('이름이 비면 입장할 수 없다', !!createClueRoom().join({ nickname: '   ' }).error);
  const full = createClueRoom();
  for (let i = 0; i < 10; i += 1) full.join({ nickname: `사람${i}` });
  check('방은 10명까지다', /가득/.test(full.join({ nickname: '열한째' }).error || ''));
  full.dispose();

  console.log(`\n${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
