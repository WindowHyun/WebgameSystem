'use strict';

/**
 * 클루를 실제 소켓으로 붙여 본다(web/game-server.js의 clue 채널).
 *
 *   - 두 사람이 들어와 준비하고 시작하면 굴리기·이동·추측·카드 보여 주기·고발 요청이 방까지 닿는다.
 *   - 카드·정답이 남의 화면에 가지 않는다(내 카드는 나에게만, 정답은 끝날 때까지 아무에게도).
 *   - 주사위는 서버가 굴린다: 화면이 눈을 정해 보내도(dice 필드) 받지 않는다.
 *   - 형식이 틀린 요청(이동 칸이 소수, 추측에 흉기 없음 등)은 방에 닿기 전에 거절된다.
 *   - 남의 차례 요청·갈 수 없는 칸은 안내와 함께 거절된다.
 *   - 포털이 클루의 인원·상태를 알려 주고, 보스 키가 다른 사람의 화면도 가린다.
 *   - 연결이 끊겼다 같은 토큰으로 돌아오면 같은 자리·같은 카드로 이어 간다.
 *
 * 실행: node test/clue-server-test.js
 */

const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

const PORT = 4743;
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

function connect(game, nickname, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?game=${game}`);
    const client = { ws, messages: [], state: null, welcome: null, errors: [], last: (type) => [...client.messages].reverse().find((m) => m.type === type) };
    ws.on('message', (raw) => {
      const data = JSON.parse(String(raw));
      client.messages.push(data);
      if (data.type === 'clueState') client.state = data;
      if (data.type === 'welcome') client.welcome = data;
      if (data.type === 'error') client.errors.push(data.message);
    });
    ws.on('open', () => { if (nickname) ws.send(JSON.stringify({ type: 'join', nickname, token })); resolve(client); });
    ws.on('error', reject);
  });
}
const send = (client, message) => client.ws.send(JSON.stringify(message));
async function until(condition, label) {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`기다리다 시간 초과: ${label}`);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

(async () => {
  const server = createGameServer({ port: PORT, host: '127.0.0.1' });
  await server.start();
  const open = [];
  try {
    console.log('\n=== 입장·시작 ===');
    const portal = await connect('portal');
    const a = await connect('clue', '김하늘');
    const b = await connect('clue', '박서준');
    open.push(portal, a, b);
    await until(() => a.state && b.state && a.welcome && b.welcome, '입장');
    check('입장하면 welcome과 상태를 받는다', !!a.welcome.token && a.state.phase === 'lobby' && a.state.players.length === 2 && a.state.map.rooms.length === 9);
    send(a, { type: 'start' });
    await until(() => a.errors.length > 0, '준비 없이 시작');
    check('준비한 사람이 없으면 시작이 거절된다', /2명 이상/.test(a.errors[0]));
    for (const c of [a, b]) send(c, { type: 'ready', ready: true });
    await until(() => a.state.readyCount === 2, '준비');
    send(a, { type: 'start' });
    await until(() => a.state.phase === 'playing' && b.state.phase === 'playing', '시작');
    check('시작하면 둘에게 진행 상태가 가고, 카드는 각자 9장씩이다', a.state.you.hand.length === 9 && b.state.you.hand.length === 9 && a.state.board.length === 2);
    check('내 카드는 나에게만 가고 겹치지 않는다', a.state.you.hand.every((c) => !b.state.you.hand.includes(c)) && !JSON.stringify(b.state).includes(JSON.stringify(a.state.you.hand)));
    check('정답은 진행 중 어느 화면에도 없다', a.state.result === null && b.state.result === null && !JSON.stringify([a.state, b.state]).includes('"solution"'));

    const byId = { [a.welcome.playerId]: a, [b.welcome.playerId]: b };
    const mover = () => byId[a.state.turnId];
    const other = () => (mover() === a ? b : a);

    console.log('\n=== 굴리기·이동 ===');
    const lastError = (c) => c.errors[c.errors.length - 1];
    let seen = other().errors.length;
    send(other(), { type: 'roll' });
    await until(() => other().errors.length > seen, '남의 차례 오류');
    check('남의 차례에 굴리면 안내와 함께 거절된다', /내 차례가 아닙니다/.test(lastError(other())));
    seen = mover().errors.length;
    send(mover(), { type: 'move', x: 5, y: 5 });
    await until(() => mover().errors.length > seen, '굴리기 전 이동');
    check('굴리기 전 이동은 거절된다', /먼저 주사위/.test(lastError(mover())));

    send(mover(), { type: 'roll', dice: [6, 6] });
    await until(() => a.state.dice && b.state.dice, '굴림');
    check('굴리면 둘에게 같은 주사위가 가고 눈은 1~6이다', a.state.dice.length === 2 && a.state.dice.every((v) => v >= 1 && v <= 6) && JSON.stringify(a.state.dice) === JSON.stringify(b.state.dice) && a.state.step === 'move');
    check('갈 수 있는 곳은 굴린 사람에게만 간다', !!mover().state.you.reach && mover().state.you.reach.cells.length > 0 && other().state.you.reach === null);

    const errorsBefore = mover().errors.length;
    send(mover(), { type: 'move', x: 1.5, y: 2 });
    send(mover(), { type: 'move' });
    send(mover(), { type: 'suggest', suspect: 'plum' });
    await until(() => mover().errors.length >= errorsBefore + 3, '형식 오류');
    check('형식이 틀린 요청(소수 칸·목적지 없음·흉기 없음)은 방에 닿기 전에 거절된다', mover().errors.slice(errorsBefore).every((m) => m === '잘못된 요청입니다.'));
    send(mover(), { type: 'raise', amount: 100 });
    await until(() => mover().errors.length >= errorsBefore + 4, '다른 게임 요청');
    check('다른 게임의 요청(배팅)은 거절된다', mover().errors[errorsBefore + 3] === '잘못된 요청입니다.');
    send(mover(), { type: 'move', x: 0, y: 0 });
    await until(() => mover().errors.length >= errorsBefore + 5, '갈 수 없는 칸');
    check('갈 수 없는 칸은 안내와 함께 거절된다', /갈 수 없습니다/.test(mover().errors[errorsBefore + 4]));

    const first = mover();
    const cell = first.state.you.reach.cells[0];
    send(first, { type: 'move', x: cell.x, y: cell.y });
    await until(() => a.state.step === 'end', '이동');
    const mine = first.state.positions[first.state.you.suspect];
    check('복도 칸으로 이동하면 둘에게 같은 위치가 보이고 끝 단계가 된다', mine.x === cell.x && mine.y === cell.y && JSON.stringify(a.state.positions) === JSON.stringify(b.state.positions));
    send(first, { type: 'endTurn' });
    await until(() => a.state.turnId !== first.welcome.playerId, '차례 넘김');
    check('차례 끝내기로 다음 사람에게 차례가 넘어간다', mover() !== first && mover().state.you.myTurn === true && a.state.step === 'start');

    console.log('\n=== 포털·보스 키·재접속 ===');
    await settle();
    const games = portal.last('games');
    check('포털에 클루 채널의 인원·상태가 나온다', games && games.games.clue && games.games.clue.label === '클루' && games.games.clue.playerCount === 2 && games.games.clue.status === '진행중', JSON.stringify(games && games.games.clue));
    const waiting = mover();
    send(waiting, { type: 'cover' });
    await until(() => other().last('cover') && portal.last('cover'), '보스 키');
    check('클루에서 가린 보스 키가 포털·다른 접속자에게도 퍼진다', !!other().last('cover') && !!portal.last('cover'));
    send(waiting, { type: 'coverState', covered: true });
    await until(() => other().state.paused === true, '멈춤');
    check('차례인 사람이 가리면 제한시간이 멈춘다', other().state.paused === true && typeof other().state.turnEndsAt === 'number');
    send(waiting, { type: 'coverState', covered: false });

    const handBefore = waiting.state.you.hand.slice();
    const idBefore = waiting.welcome.playerId;
    waiting.ws.close();
    await until(() => other().state.players.find((p) => p.id === idBefore).connected === false, '끊김');
    const back = await connect('clue', waiting === a ? '김하늘' : '박서준', waiting.welcome.token);
    open.push(back);
    await until(() => back.state && back.welcome, '재접속');
    check('끊긴 뒤 같은 토큰으로 돌아오면 같은 자리·같은 카드·같은 차례다', back.welcome.playerId === idBefore && JSON.stringify(back.state.you.hand) === JSON.stringify(handBefore) && back.state.you.myTurn === true && back.state.step === 'start');
  } finally {
    for (const c of open) { try { c.ws.close(); } catch { /* 이미 닫힘 */ } }
    await server.stop();
  }
  console.log(`\n클루 서버: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
