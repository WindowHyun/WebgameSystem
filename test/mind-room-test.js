'use strict';

/**
 * 더 마인드 규칙(web/mind-room.js).
 *
 * 손패는 섞어서 나누므로, 판정을 정확히 보려는 곳에서는 _debug()로 손패를 직접 정한다.
 * "모두 이기는 한 판"은 섞지 않는 덱(random이 늘 1에 가깝게 → 1,2,3… 순서)으로 친다.
 */

const WebSocket = require('ws');
const { createMindRoom, LEVELS_BY_COUNT } = require('../web/mind-room');
const { createGameServer } = require('../web/game-server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

function open(names, extra) {
  const lines = [];
  const room = createMindRoom(Object.assign({ onChange() {}, onAction: (who, what) => lines.push(`${who} > ${what}`),
    proposalTimeoutMs: 1000, disconnectGraceMs: 50 }, extra || {}));
  const joined = names.map((nickname) => room.join({ nickname }));
  const ids = joined.map((p) => p.playerId);
  const view = (id) => room.stateFor(id || ids[0]);
  const seat = (id) => room._debug().players.find((p) => p.id === id);
  const setHands = (...hands) => hands.forEach((hand, i) => { seat(ids[i]).hand = hand.slice(); });
  const focusAll = () => { for (const id of room._debug().roster) room.focus(id, true); };
  const start = () => { for (const id of ids) room.setReady(id, true); return room.begin(ids[0]); };
  return { room, joined, ids, view, seat, setHands, focusAll, start, lines };
}
const hasNote = (s, text) => s.history.some((h) => h.text.includes(text));

function testStart() {
  console.log('\n=== 시작 ===');
  for (const n of [2, 3, 4]) {
    const { room, view, start } = open(['가', '나', '다', '라'].slice(0, n));
    check(`${n}명: 시작할 수 있다`, start() === null);
    const s = view();
    check(`${n}명: ${LEVELS_BY_COUNT[n]}레벨, 목숨 ${n}, 수리검 1, 레벨 1`, s.levels === LEVELS_BY_COUNT[n] && s.lives === n && s.stars === 1 && s.level === 1,
      JSON.stringify({ levels: s.levels, lives: s.lives, stars: s.stars, level: s.level }));
    check(`${n}명: 각자 1장씩 받고 집중 단계에서 시작한다`, s.phase === 'focus' && s.you.hand.length === 1 && s.players.every((p) => p.cardCount === 1));
    room.dispose();
  }
  const five = open(['가', '나', '다', '라', '마']);
  check('5명이 준비하면 시작하지 않는다(원작 2~4명)', /4명까지/.test(five.start() || ''));
  five.room.dispose();
  const one = open(['가']);
  check('혼자서는 시작하지 않는다', /2명 이상/.test(one.start() || ''));
  one.room.dispose();
}

function testFocusAndOrder() {
  console.log('\n=== 집중·오름차순 ===');
  const { room, ids, view, setHands, focusAll, start } = open(['가', '나']);
  start();
  setHands([10], [20]);
  check('모두 집중하기 전에는 낼 수 없다', /집중한 뒤/.test(room.play(ids[0]) || ''));
  room.focus(ids[0], true);
  check('한 명만 집중하면 아직 집중 단계다', view().phase === 'focus');
  room.focus(ids[1], true);
  check('모두 집중하면 진행한다', view().phase === 'playing');
  room.play(ids[0]);
  check('작은 수부터 내면 그대로 쌓인다', view().pile.map((c) => c.value).join() === '10' && view().lives === 2);
  room.play(ids[1]);
  const s = view();
  check('모두 다 내면 다음 레벨로 간다(각자 2장)', s.level === 2 && s.phase === 'focus' && s.you.hand.length === 2, `${s.level} ${s.phase}`);
  check('레벨 1은 보상이 없다', s.lives === 2 && s.stars === 1);
  setHands([1, 2], [3, 4]);
  focusAll();
  for (const id of [ids[0], ids[0], ids[1], ids[1]]) room.play(id);
  check('레벨 2를 깨면 수리검 +1', view().level === 3 && view().stars === 2, `${view().level} ${view().stars}`);
  setHands([1, 2, 3], [4, 5, 6]);
  focusAll();
  for (const id of [ids[0], ids[0], ids[0], ids[1], ids[1], ids[1]]) room.play(id);
  check('레벨 3을 깨면 목숨 +1', view().level === 4 && view().lives === 3, `${view().level} ${view().lives}`);
  room.dispose();
}

function testMistake() {
  console.log('\n=== 실수 ===');
  const { room, ids, view, setHands, focusAll, start, seat } = open(['가', '나', '다']);
  start();
  room._debug().setLevel(3);
  setHands([30, 70, 90], [10, 20, 50], [40, 60, 80]);
  focusAll();
  room.play(ids[0]); // 30을 냈는데 나에게 10·20이 있었다
  const s = view();
  check('더 작은 카드가 있었으면 목숨을 1개 잃는다', s.lives === 2, `${s.lives}`);
  check('그보다 작은 카드는 공개하고 버린다', s.discarded.map((d) => d.value).sort((a, b) => a - b).join() === '10,20'
    && s.discarded.every((d) => d.reason === 'mistake' && d.owner === '나'), JSON.stringify(s.discarded));
  check('버린 사람 손에는 더 큰 카드만 남는다', seat(ids[1]).hand.join() === '50');
  check('실수한 뒤에는 다시 집중한다', s.phase === 'focus' && hasNote(s, '목숨을 1개 잃고'), s.phase);
  check('남은 사람에게 무엇이 버려졌는지 알린다', s.lastEvent && s.lastEvent.kind === 'mistake' && /10, 20/.test(s.lastEvent.text), JSON.stringify(s.lastEvent));
  focusAll();
  room.play(ids[2]); // 40 - 나(50)보다 작으니 괜찮다
  room.play(ids[0]); // 70 - 나에게 50, 다에게 60이 있었다
  const t = view();
  check('두 번째 실수: 목숨 1', t.lives === 1 && t.discarded.length === 4, `${t.lives} ${JSON.stringify(t.discarded)}`);
  focusAll();
  room.play(ids[0]); // 90 - 다에게 80이 있었다 → 목숨 0
  const u = view();
  check('목숨이 0이 되면 진다', u.phase === 'result' && u.result && u.result.won === false && /목숨을 모두/.test(u.result.message), JSON.stringify(u.result));
  check('끝나면 남은 카드를 모두에게 공개한다', u.players.every((p) => Array.isArray(p.hand)));
  room.dispose();
}

function testMistakeEndsLevel() {
  // 실수로 남은 카드가 모두 버려져 레벨이 끝나도, 무엇이 버려졌는지 안내에 남아야 한다.
  const { room, ids, view, setHands, focusAll, start } = open(['가', '나']);
  start();
  setHands([50], [10]);
  focusAll();
  room.play(ids[0]);
  const s = view();
  check('실수로 레벨이 끝나도 다음 레벨로 간다', s.level === 2 && s.lives === 1, `${s.level} ${s.lives}`);
  check('그때도 실수 내용(버려진 카드)이 안내에 남는다', s.lastEvent.kind === 'mistake' && /10/.test(s.lastEvent.text) && /레벨 1 통과/.test(s.lastEvent.text),
    JSON.stringify(s.lastEvent));
  room.dispose();
}

async function testStar() {
  console.log('\n=== 수리검 ===');
  const { room, ids, view, setHands, focusAll, start } = open(['가', '나', '다']);
  start();
  room._debug().setLevel(2);
  setHands([5, 60], [30, 70], [45, 80]);
  focusAll();
  check('수리검 제안', room.proposeStar(ids[0]) === null && view().starVote && view().starVote.agreed === 1);
  check('투표 중에는 카드를 낼 수 없다', /투표 중/.test(room.play(ids[1]) || ''));
  room.voteStar(ids[1], view().starVote.id, true);
  check('모두 동의하기 전에는 쓰지 않는다', view().stars === 1 && view().starVote.agreed === 2);
  room.voteStar(ids[2], view().starVote.id, true);
  const s = view();
  check('모두 동의하면 수리검 1개를 쓰고 각자 가장 작은 카드를 버린다',
    s.stars === 0 && s.discarded.map((d) => d.value).join() === '5,30,45' && s.discarded.every((d) => d.reason === 'star'), JSON.stringify(s.discarded));
  check('수리검은 목숨을 잃지 않는다', s.lives === 3);
  check('남은 수리검이 없으면 제안할 수 없다', /없습니다/.test(room.proposeStar(ids[0]) || ''));
  room.dispose();

  const second = open(['가', '나']);
  second.start();
  second.focusAll();
  second.room.proposeStar(second.ids[0]);
  second.room.voteStar(second.ids[1], second.view().starVote.id, false);
  check('한 명이라도 반대하면 쓰지 않는다', !second.view().starVote && second.view().stars === 1);
  second.room.proposeStar(second.ids[1]);
  await wait(1100);
  check('투표 시간이 지나면 취소된다', !second.view().starVote && second.view().stars === 1);
  second.room.dispose();
}

function testWinWholeGame() {
  console.log('\n=== 한 판을 끝까지 ===');
  // 섞지 않는 덱: 먼저 들어온 사람이 늘 작은 카드를 받는다. 그 순서대로 내면 전부 성공이다.
  const { room, ids, view, focusAll, start, seat } = open(['가', '나'], { random: () => 0.999999 });
  start();
  for (let guard = 0; guard < 20 && view().phase !== 'result'; guard += 1) {
    focusAll();
    const level = view().level;
    // 마지막 카드를 내는 순간 다음 레벨 손패가 나오므로, 이 레벨이 진행 중인 동안만 낸다.
    for (const id of ids) {
      while (view().phase === 'playing' && view().level === level && seat(id).hand.length) room.play(id);
    }
  }
  const s = view();
  check('2명이 12레벨을 모두 깨면 이긴다', s.phase === 'result' && s.result.won === true && s.level === 12, JSON.stringify(s.result));
  check('보상은 상한까지만 쌓인다(목숨 2+3=5, 수리검 1+3=4 → 3)', s.lives === 5 && s.stars === 3, `${s.lives} ${s.stars}`);
  room.setReady(ids[0], true); room.setReady(ids[1], true);
  check('끝난 뒤 다시 준비하면 새 게임을 시작할 수 있다', room.begin(ids[1]) === null && view().level === 1 && view().lives === 2);
  room.dispose();
}

function testPauseAndCover() {
  console.log('\n=== 멈춤·화면 가림 ===');
  const { room, ids, view, focusAll, start } = open(['가', '나']);
  start();
  focusAll();
  check('누구든 잠깐 멈출 수 있다', room.pause(ids[1]) === null && view().phase === 'focus' && /잠깐 멈췄/.test(view().pauseReason));
  focusAll();
  room.setCovered(ids[0], true);
  check('레벨 도중 누가 화면을 가리면 멈춘다', view().phase === 'focus' && /화면이 가려져/.test(view().pauseReason), view().pauseReason);
  room.dispose();
}

async function testDisconnectAndLeave() {
  console.log('\n=== 끊김·나가기 ===');
  {
    const { room, joined, ids, view, focusAll, start } = open(['가', '나', '다']);
    start();
    focusAll();
    room.disconnect(ids[2]);
    check('레벨 도중 누가 끊기면 멈추고 알린다', view().phase === 'focus' && hasNote(view(), '연결이 끊겼습니다'));
    check('끊긴 사람이 없으면 모두 집중해도 시작하지 않는다', (focusAll(), view().phase === 'focus'));
    room.join({ nickname: '다', token: joined[2].token });
    await wait(100);
    check('유예 안에 돌아오면 그대로 게임에 남는다', view().players.find((p) => p.id === ids[2]).inGame === true);
    focusAll();
    check('돌아온 뒤 모두 집중하면 이어 간다', view().phase === 'playing');
    room.disconnect(ids[2]);
    await wait(150);
    const s = view();
    check('돌아오지 않으면 그 사람 카드를 버리고 남은 사람끼리 이어 간다',
      !s.players.some((p) => p.id === ids[2]) && s.discarded.some((d) => d.reason === 'left') && s.phase === 'focus', JSON.stringify(s.discarded));
    check('목숨은 잃지 않는다', s.lives === 3);
    room.leave(ids[1]);
    const t = view();
    check('두 명 아래로 줄면 게임을 마친다', t.phase === 'result' && t.result.ended === true, JSON.stringify(t.result));
    room.dispose();
  }
  {
    const { room, ids, view, focusAll, start } = open(['가', '나']);
    start();
    focusAll();
    const late = room.join({ nickname: '늦음' });
    const lv = room.stateFor(late.playerId);
    check('진행 중에 들어온 사람은 구경만 한다', lv.you.inGame === false && lv.you.hand.length === 0);
    check('구경하는 사람은 카드를 낼 수 없다', /참가자가 아닙니다/.test(room.play(late.playerId) || ''));
    check('남의 카드는 숫자 없이 장수만 보인다', view().players.filter((p) => p.id !== ids[0] && p.inGame).every((p) => p.hand === null && p.cardCount === 1));
    room.dispose();
  }
}

function testLogsHideHands() {
  console.log('\n=== 관리 로그 ===');
  const { room, ids, lines, start, seat } = open(['가', '나', '다', '라']);
  start();
  // 로그의 다른 숫자(레벨 1/8, 4명, 목숨 4 …)와 헷갈리지 않게 13 이상인 카드만 본다.
  const dealt = ids.map((id) => seat(id).hand[0]).filter((v) => v >= 13);
  const logged = lines.join('\n');
  check('나눠 준 손패 숫자는 관리 로그에 남지 않는다', dealt.every((v) => !new RegExp(`(^|[^0-9])${v}([^0-9]|$)`).test(logged)), `${dealt} / ${logged}`);
  for (const id of room._debug().roster) room.focus(id, true);
  const value = seat(ids[0]).hand[0];
  room.play(ids[0]);
  check('낸 카드는 남는다', lines.some((l) => l.endsWith(`> 카드 ${value} 냄`)), lines.slice(-2).join(' / '));
  room.dispose();
}

async function testServer() {
  console.log('\n=== 실제 서버 ===');
  const original = console.error;
  console.error = () => {};
  const port = 4541;
  const server = createGameServer({ port, host: '127.0.0.1' });
  const sockets = [];
  try {
    await server.start();
    const connect = async (game, nickname) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?game=${game}`, { origin: `http://127.0.0.1:${port}` });
      const inbox = [];
      ws.on('message', (raw) => inbox.push(JSON.parse(String(raw))));
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      if (nickname) ws.send(JSON.stringify({ type: 'join', nickname }));
      sockets.push(ws);
      await wait(80);
      const last = (type) => inbox.filter((m) => m.type === type).slice(-1)[0];
      return { ws, inbox, last, send: (m) => ws.send(JSON.stringify(m)) };
    };
    const portal = await connect('portal');
    const a = await connect('mind', '갑');
    const b = await connect('mind', '을');
    for (const s of [a, b]) s.send({ type: 'ready', ready: true });
    await wait(80);
    a.send({ type: 'start' });
    await wait(120);
    check('게임이 시작되고 각자 카드를 받는다', a.last('mindState').phase === 'focus' && a.last('mindState').you.hand.length === 1);
    for (const s of [a, b]) s.send({ type: 'focus', focused: true });
    await wait(120);
    check('모두 집중하면 진행 중이 된다', a.last('mindState').phase === 'playing');
    const lowFirst = a.last('mindState').you.hand[0] < b.last('mindState').you.hand[0] ? a : b;
    const other = lowFirst === a ? b : a;
    lowFirst.send({ type: 'play' });
    await wait(80);
    other.send({ type: 'play' });
    await wait(150);
    check('작은 수부터 내면 레벨 2로 넘어간다', a.last('mindState').level === 2, `${a.last('mindState').level}`);
    const games = portal.last('games');
    check('포털 목록에 더 마인드가 진행중으로 보인다', !!games && games.games.mind && games.games.mind.status === '진행중' && games.games.mind.playerCount === 2,
      JSON.stringify(games && games.games.mind));
    a.send({ type: 'nonsense' });
    await wait(80);
    check('모르는 요청은 거절한다', a.inbox.some((m) => m.type === 'error' && /지원하지 않는/.test(m.message)));
  } finally {
    for (const ws of sockets) ws.close();
    await wait(100);
    await server.stop();
    console.error = original;
  }
}

async function main() {
  testStart();
  testFocusAndOrder();
  testMistake();
  testMistakeEndsLevel();
  await testStar();
  testWinWholeGame();
  testPauseAndCover();
  await testDisconnectAndLeave();
  testLogsHideHands();
  await testServer();
  console.log(`\n더 마인드: ${pass}개 통과, ${fail}개 실패`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
