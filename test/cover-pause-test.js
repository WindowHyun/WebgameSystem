'use strict';

/**
 * [보스 키] 화면을 가린 동안 제한시간이 멈추는가(web/cover-pause.js).
 *
 * 예전에는 보스 키로 모두의 화면이 가려져도 제한시간이 그대로 흘렀다. 가려 둔 사이에
 * 차례가 온 사람은 30초 뒤 자동 폴드·자동 스탠드되었고, 라이어 게임에서는 설명 차례를
 * 넘기거나 정답 시간을 놓쳤다.
 *
 *   - 제한시간이 기다리는 사람이 가리고 있으면 멈춘다. 상관없는 사람이 가린 것은 멈추지 않는다.
 *   - 돌아오면 남은 시간부터 다시 흐른다(처음부터 다시 주지 않는다).
 *   - 가린 채 자리를 비워도 게임이 영영 멈추지 않도록, 제한시간 하나(한 차례·한 단계)는
 *     정해진 한도까지만 멈춘다. 가렸다 풀었다를 되풀이해도 한도는 늘지 않는다.
 *   - 끊겼다 다시 들어오면 이전 화면의 가림 상태는 버린다.
 *   - 실제 서버: 화면이 보낸 {type:'coverState'}가 방까지 전달된다.
 */

const WebSocket = require('ws');
const { createPokerRoom } = require('../web/poker-room');
const { createBlackjackRoom } = require('../web/blackjack-room');
const { createRoom } = require('../web/room');
const { createGameServer } = require('../web/game-server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

const ACTION_MS = 200;

/** 두 명이 앉아 판을 시작한 카드 방. */
function cardRoom(make, extra) {
  const lines = [];
  const room = make(Object.assign({ onChange() {}, onAction: (who, what) => lines.push(`${who} > ${what}`),
    actionTimeoutMs: ACTION_MS, proposalTimeoutMs: 0 }, extra || {}));
  const joined = ['갑', '을'].map((nickname) => room.join({ nickname }));
  const ids = joined.map((p) => p.playerId);
  for (const id of ids) room.setReady(id, true);
  room.begin(ids[0]);
  const view = () => room.stateFor(ids[0]);
  const turn = () => view().turnPlayerId;
  const other = (id) => ids.find((x) => x !== id);
  return { room, joined, ids, view, turn, other, lines };
}
const autoActed = (view, word) => view().history.some((h) => h.text.includes(word));

// ─────────────────────────────── 포커 ───────────────────────────────

async function testPoker() {
  console.log('\n=== 포커 ===');
  {
    const { room, view, turn, lines } = cardRoom(createPokerRoom);
    const actor = turn();
    room.setCovered(actor, true);
    check('차례인 사람이 가리면 멈춤 표시가 뜬다', view().paused === true);
    await wait(ACTION_MS * 3);
    check('가린 동안에는 제한시간이 지나도 자동 폴드되지 않는다', !autoActed(view, '자동 폴드') && turn() === actor,
      view().history.map((h) => h.text).slice(-2).join(' / '));
    room.setCovered(actor, false);
    check('돌아오면 멈춤 표시가 사라진다', view().paused === false);
    await wait(ACTION_MS + 150);
    check('돌아온 뒤에는 다시 흘러 제한시간에 걸린다', autoActed(view, '자동 폴드'));
    check('관리 로그에 멈춘 사람과 다시 흐른 것이 남는다',
      lines.some((l) => l.endsWith('> 화면 가림 - 제한시간 멈춤')) && lines.some((l) => /진행 > 제한시간 다시 흐름 \(\d+초 멈춤\)/.test(l)),
      lines.filter((l) => l.includes('제한시간')).join(' / '));
    room.dispose();
  }
  {
    // 남은 시간부터 다시 흐르는가: 절반쯤 지나서 가리고, 돌아온 뒤 남은 절반만에 끝나야 한다.
    const { room, view, turn } = cardRoom(createPokerRoom);
    const actor = turn();
    await wait(ACTION_MS / 2);
    room.setCovered(actor, true);
    await wait(ACTION_MS * 2);
    room.setCovered(actor, false);
    await wait(30);
    check('돌아오자마자 끝나지는 않는다(남은 시간이 있다)', !autoActed(view, '자동 폴드'));
    await wait(ACTION_MS / 2 + 80);
    check('처음부터 다시 주지 않고 남은 시간만큼만 기다린다', autoActed(view, '자동 폴드'));
    room.dispose();
  }
  {
    const { room, view, turn, other } = cardRoom(createPokerRoom);
    room.setCovered(other(turn()), true);
    check('차례가 아닌 사람이 가린 것은 멈추지 않는다', view().paused === false);
    await wait(ACTION_MS + 150);
    check('그래서 차례인 사람은 제한시간에 걸린다', autoActed(view, '자동 폴드'));
    room.dispose();
  }
  {
    // 가려 둔 사람에게 차례가 넘어오면 그때부터 멈춘다.
    const { room, view, turn, other } = cardRoom(createPokerRoom);
    const next = other(turn());
    room.setCovered(next, true);
    room.call(turn());
    check('가려 둔 사람에게 차례가 오면 그때 멈춘다', turn() === next && view().paused === true);
    await wait(ACTION_MS * 3);
    check('그 사람은 자동 폴드되지 않는다', !autoActed(view, '자동 폴드'));
    room.dispose();
  }
  {
    // 가린 채 자리를 비운 경우: 최대 멈춤 시간이 지나면 다시 흐른다.
    const { room, view, turn } = cardRoom(createPokerRoom, { maxCoverPauseMs: 150 });
    room.setCovered(turn(), true);
    await wait(100);
    check('최대 멈춤 시간 전에는 멈춰 있다', view().paused === true && !autoActed(view, '자동 폴드'));
    await wait(ACTION_MS + 250);
    check('가린 채 최대 멈춤 시간이 지나면 다시 흘러 제한시간에 걸린다', autoActed(view, '자동 폴드'));
    room.dispose();
  }
  {
    // 끊겼다 다시 들어오면 이전 화면의 가림 상태는 버린다(새 화면이 다시 알려 준다).
    const room = createPokerRoom({ onChange() {}, actionTimeoutMs: ACTION_MS, proposalTimeoutMs: 0 });
    const a = room.join({ nickname: '갑' });
    const b = room.join({ nickname: '을' });
    room.setCovered(a.playerId, true);
    room.setCovered(b.playerId, true);
    room.join({ nickname: '갑', token: a.token }); // 새 연결이 먼저 도착한 재접속
    room.disconnect(b.playerId);
    room.join({ nickname: '을', token: b.token });
    for (const p of [a, b]) room.setReady(p.playerId, true);
    room.begin(a.playerId);
    check('다시 들어온 사람의 예전 가림 상태로 멈추지 않는다', room.stateFor(a.playerId).paused === false);
    room.dispose();
  }
}

// ─────────────────────────────── 블랙잭 ───────────────────────────────

async function testBlackjack() {
  console.log('\n=== 블랙잭 ===');
  const { room, view, turn, other } = cardRoom(createBlackjackRoom);
  const actor = turn();
  room.setCovered(actor, true);
  check('카드 선택 차례인 사람이 가리면 멈춘다', view().paused === true);
  await wait(ACTION_MS * 3);
  check('가린 동안 자동 스탠드되지 않는다', !autoActed(view, '자동 스탠드') && turn() === actor);
  room.setCovered(actor, false);
  room.stand(actor);
  room.stand(turn());
  check('배팅 단계로 넘어갔다', view().phase === 'betting', view().phase);
  const bettor = turn();
  room.setCovered(bettor, true);
  await wait(ACTION_MS * 3);
  check('배팅 차례인 사람이 가린 동안 자동 폴드되지 않는다', !autoActed(view, '자동 폴드') && view().phase === 'betting');
  room.setCovered(bettor, false);
  room.setCovered(other(bettor), true);
  check('차례가 아닌 사람이 가린 것은 멈추지 않는다', view().paused === false);
  await wait(ACTION_MS + 150);
  check('돌아온 뒤에는 제한시간에 걸린다', autoActed(view, '자동 폴드'));
  room.dispose();
}

// ─────────────────────────────── 라이어 ───────────────────────────────

// 라이어 방은 제한시간이 길어(설명 60초) 가상 시계로 본다(test/web-room-test.js와 같은 방식).
let clock = 0;
let seq = 0;
let timers = [];
const setTimer = (fn, ms) => { seq += 1; const t = { id: seq, at: clock + (ms || 0), fn }; timers.push(t); return t; };
const clearTimer = (t) => { if (!t) return; const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
const now = () => clock;
function advance(ms) {
  const target = clock + ms;
  for (let guard = 0; guard < 1000; guard += 1) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    if (timers.length === 0 || timers[0].at > target) break;
    const t = timers.shift();
    clock = t.at;
    t.fn();
  }
  clock = target;
}
function liarRoom(extra) {
  clock = 0; timers = []; seq = 0;
  const room = createRoom(Object.assign({ setTimer, clearTimer, now, random: () => 0 }, extra || {}));
  const ids = ['가', '나', '다'].map((n) => room.join({ nickname: n }).playerId);
  room.start(ids[0]);
  return { room, ids, view: () => room.stateFor(ids[0]), debug: () => room._debug() };
}

function testLiar() {
  console.log('\n=== 라이어 ===');
  {
    const { room, view, debug, ids } = liarRoom();
    const speaker = view().round.speaker.id;
    advance(10000); // 60초 중 10초가 지났다
    room.setCovered(speaker, true);
    const frozen = view();
    check('설명 차례인 사람이 가리면 멈춘 시각이 화면에 간다', frozen.pausedAt === 10000, `${frozen.pausedAt}`);
    check('화면이 멈춘 시각 기준으로 세면 남은 시간이 50초다', frozen.round.speakEndsAt - frozen.pausedAt === 50000,
      `${frozen.round.speakEndsAt - frozen.pausedAt}`);
    advance(120000);
    check('가린 동안 2분이 지나도 차례를 넘기지 않는다', debug().phase === 'turn' && view().round.speaker.id === speaker);
    room.setCovered(speaker, false);
    const resumed = view();
    check('돌아오면 멈춤이 풀리고 남은 50초부터 다시 센다', resumed.pausedAt === null && resumed.round.speakEndsAt === clock + 50000,
      `${resumed.round.speakEndsAt} vs ${clock + 50000}`);
    advance(49000);
    check('남은 시간 전에는 그대로다', view().round.speaker && view().round.speaker.id === speaker);
    advance(1000);
    check('남은 시간이 다 되면 차례가 넘어간다', !view().round.speaker || view().round.speaker.id !== speaker);
    const other = ids.find((id) => id !== (view().round.speaker || {}).id);
    room.setCovered(other, true);
    check('설명 차례가 아닌 사람이 가린 것은 멈추지 않는다', view().pausedAt === null);
    room.dispose();
  }
  {
    // 투표: 아직 안 던진 사람이 가리면 멈추고, 이미 던진 사람이 가린 것은 상관없다.
    const { room, ids, debug, view } = liarRoom();
    for (let i = 0; i < 3; i += 1) { const d = debug(); room.say(d.round.speakOrder[d.round.speakIndex], '설명'); }
    for (const id of ids) room.respondProposal(id, false);
    check('투표 단계다', debug().phase === 'voting', debug().phase);
    const liar = debug().round.liarId;
    const [first, second] = ids.filter((id) => id !== liar);
    room.vote(first, liar);
    room.setCovered(first, true);
    check('이미 투표한 사람이 가린 것은 멈추지 않는다', view().pausedAt === null);
    room.setCovered(second, true);
    check('아직 투표하지 않은 사람이 가리면 멈춘다', view().pausedAt !== null);
    advance(120000);
    check('가린 동안에는 투표 시간이 끝나지 않는다', debug().phase === 'voting');
    room.setCovered(second, false);
    room.vote(second, liar);
    room.vote(liar, first);
    check('정답 맞히기 단계다', debug().phase === 'guess', debug().phase);
    room.setCovered(liar, true);
    advance(120000);
    check('지목된 사람이 가린 동안에는 정답 시간이 끝나지 않는다', debug().phase === 'guess');
    room.setCovered(liar, false);
    advance(30000);
    check('돌아온 뒤 남은 시간이 지나면 정답 시간 초과로 끝난다', debug().phase === 'result' && debug().result.reason === 'guessTimeout',
      debug().result && debug().result.reason);
    room.dispose();
  }
  {
    // 가린 채 자리를 비운 경우: 최대 멈춤 시간이 지나면 다시 흐른다.
    const { room, view, debug } = liarRoom({ maxCoverPauseMs: 90000 });
    const speaker = view().round.speaker.id;
    room.setCovered(speaker, true);
    advance(89000);
    check('최대 멈춤 시간 전에는 멈춰 있다', view().pausedAt !== null && view().round.speaker.id === speaker);
    advance(1000);
    check('최대 멈춤 시간이 지나면 다시 흐른다', view().pausedAt === null);
    advance(60000);
    check('그 뒤로는 제한시간에 걸려 차례가 넘어간다', debug().phase !== 'turn' || view().round.speaker.id !== speaker);
    room.dispose();
  }
  {
    // 한도는 사람이 아니라 제한시간에 붙는다: 가렸다 풀었다를 되풀이해도 늘어나지 않는다.
    const { room, view, debug } = liarRoom({ maxCoverPauseMs: 90000 });
    const speaker = view().round.speaker.id;
    room.setCovered(speaker, true);
    advance(60000);                  // 60초 멈춤(한도 90초 중)
    room.setCovered(speaker, false);
    advance(10000);                  // 설명 60초 중 10초가 흐름 - 50초 남음
    room.setCovered(speaker, true);  // 다시 가림 - 남은 한도는 30초
    advance(29000);
    check('다시 가리면 남은 한도만큼은 멈춘다', view().pausedAt !== null);
    advance(1000);
    check('가렸다 풀었다를 되풀이해도 한 차례에 멈추는 시간은 한도를 넘지 않는다', view().pausedAt === null);
    room.setCovered(speaker, false);
    room.setCovered(speaker, true);
    check('한도를 다 쓴 차례에서는 다시 가려도 멈추지 않는다', view().pausedAt === null);
    advance(50000);
    const next = view().round.speaker;
    check('남은 50초가 지나면 차례가 넘어간다', debug().phase !== 'turn' || (next && next.id !== speaker));
    if (next && debug().phase === 'turn') {
      room.setCovered(next.id, true);
      check('다음 차례는 멈출 수 있는 시간을 새로 받는다', view().pausedAt !== null);
    }
    room.dispose();
  }
  {
    const { room, view } = liarRoom();
    const speaker = view().round.speaker.id;
    room.setCovered(speaker, true);
    room.disconnect(speaker);
    check('가린 사람의 연결이 끊기면 가림 상태도 지운다', view().pausedAt === null);
    room.dispose();
  }
}

// ─────────────────────────────── 실제 서버 ───────────────────────────────

async function testServer() {
  console.log('\n=== 실제 서버 ===');
  const original = console.error;
  console.error = () => {};
  const port = 4533;
  const server = createGameServer({ port, host: '127.0.0.1' });
  const sockets = [];
  try {
    await server.start();
    const open = async (nickname) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?game=poker`, { origin: `http://127.0.0.1:${port}` });
      const inbox = [];
      ws.on('message', (raw) => inbox.push(JSON.parse(String(raw))));
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'join', nickname }));
      sockets.push(ws);
      await wait(100);
      const welcome = inbox.find((m) => m.type === 'welcome');
      return { ws, inbox, id: welcome && welcome.playerId, last: () => inbox.filter((m) => m.type === 'pokerState').slice(-1)[0] };
    };
    const a = await open('갑');
    const b = await open('을');
    for (const s of [a, b]) s.ws.send(JSON.stringify({ type: 'ready', ready: true }));
    await wait(100);
    a.ws.send(JSON.stringify({ type: 'start' }));
    await wait(150);
    const state = a.last();
    check('판이 시작되었다', state && state.phase === 'betting', state && state.phase);
    const actor = [a, b].find((s) => s.id === state.turnPlayerId);
    actor.ws.send(JSON.stringify({ type: 'coverState', covered: true }));
    await wait(150);
    check('화면이 보낸 가림 알림으로 모두의 화면에 멈춤이 뜬다', a.last().paused === true && b.last().paused === true);
    actor.ws.send(JSON.stringify({ type: 'coverState', covered: false }));
    await wait(150);
    check('돌아옴 알림으로 멈춤이 풀린다', a.last().paused === false);
  } finally {
    for (const ws of sockets) ws.close();
    await wait(100);
    await server.stop();
    console.error = original;
  }
}

/**
 * [이슈] 보스 키 남용 방지. 예전에는 사이트에 접속만 하면(포털에 있거나 게임에 참가하지
 * 않은 연결이어도) 누구든 1초마다 모두의 화면을 가릴 수 있었다.
 */
async function testCoverAbuse() {
  console.log('\n=== 보스 키 남용 방지 ===');
  const original = console.error;
  console.error = () => {};
  const port = 4534;
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
      return { ws, covers: () => inbox.filter((m) => m.type === 'cover').length, cover: () => ws.send(JSON.stringify({ type: 'cover' })) };
    };
    const a = await connect('poker', '갑');
    const b = await connect('blackjack', '을');
    const portal = await connect('portal');
    const stranger = await connect('liar'); // 이름을 넣기 전(참가하지 않은) 라이어 연결
    portal.cover(); await wait(150);
    check('포털에만 있는 사람의 우클릭은 남의 화면을 가리지 않는다', a.covers() === 0 && b.covers() === 0);
    stranger.cover(); await wait(150);
    check('게임에 참가하지 않은 연결도 남의 화면을 가리지 않는다', a.covers() === 0 && b.covers() === 0);
    a.cover(); await wait(150);
    check('게임에 참가한 사람이 가리면 다른 게임에 있는 사람과 포털 화면도 가려진다',
      b.covers() === 1 && portal.covers() === 1 && stranger.covers() === 1, `${b.covers()} ${portal.covers()} ${stranger.covers()}`);
    await wait(1100); // 전체 쿨다운(1초)은 지났다
    a.cover(); await wait(150);
    check('같은 사람은 3초 안에 다시 퍼뜨리지 못한다', b.covers() === 1, `${b.covers()}`);
    b.cover(); await wait(150);
    check('다른 사람은 퍼뜨릴 수 있다', a.covers() === 1, `${a.covers()}`);
  } finally {
    for (const ws of sockets) ws.close();
    await wait(100);
    await server.stop();
    console.error = original;
  }
}

async function main() {
  await testPoker();
  await testBlackjack();
  testLiar();
  await testServer();
  await testCoverAbuse();
  console.log(`\n보스 키 제한시간 멈춤·남용 방지: ${pass}개 통과, ${fail}개 실패`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
