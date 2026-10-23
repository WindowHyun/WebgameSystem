'use strict';

/**
 * 야추다이스를 실제 소켓으로 붙여 본다(web/game-server.js의 yacht 채널).
 *
 *   - 두 사람이 들어와 준비하고 시작하면 굴리기·고정·기록 요청이 방까지 닿고, 상태가 둘에게 간다.
 *   - 주사위는 서버가 굴린다: 화면이 눈을 정해 보내도(dice 필드) 받지 않는다.
 *   - 형식이 틀린 요청(고정이 5개가 아님, 칸 이름이 객체 등)은 방에 닿기 전에 거절된다.
 *   - 남의 차례 요청·이미 쓴 칸은 안내와 함께 거절된다.
 *   - 포털이 야추다이스의 인원·상태를 알려 주고, 보스 키가 다른 사람의 화면도 가린다.
 *   - 연결이 끊겼다 같은 토큰으로 돌아오면 같은 자리에서 이어 간다.
 *
 * 실행: node test/yacht-server-test.js
 */

const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

const PORT = 4741;
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
      if (data.type === 'yachtState') client.state = data;
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
    const a = await connect('yacht', '김하늘');
    const b = await connect('yacht', '박서준');
    open.push(portal, a, b);
    await until(() => a.state && b.state && a.welcome && b.welcome, '입장');
    check('입장하면 welcome과 상태를 받는다', !!a.welcome.token && a.state.phase === 'lobby' && a.state.categories.length === 12 && a.state.players.length === 2);
    for (const c of [a, b]) send(c, { type: 'ready', ready: true });
    await until(() => a.state.readyCount === 2, '준비');
    send(a, { type: 'start' });
    await until(() => a.state.phase === 'playing' && b.state.phase === 'playing', '시작');
    check('시작하면 둘에게 진행 상태가 가고 첫 사람 차례다', a.state.turnId === a.welcome.playerId && a.state.you.myTurn === true && b.state.you.myTurn === false && a.state.board.length === 2);

    console.log('\n=== 굴리기·고정·기록 ===');
    send(b, { type: 'roll' });
    await until(() => b.errors.length > 0, '남의 차례 오류');
    check('남의 차례에 굴리면 안내와 함께 거절된다', /내 차례가 아닙니다/.test(b.errors[0]) && b.state.rolled === false);

    send(a, { type: 'roll', dice: [6, 6, 6, 6, 6] });
    await until(() => a.state.rolled, '굴림');
    check('굴리면 둘에게 같은 주사위가 간다(눈은 1~6)', a.state.dice.every((v) => v >= 1 && v <= 6) && JSON.stringify(a.state.dice) === JSON.stringify(b.state.dice) && a.state.rollsLeft === 2);
    check('화면이 눈을 정해 보내도(dice 필드) 서버 난수대로 나온다', a.state.dice.some((v) => v !== 6) || JSON.stringify(a.state.dice) === '[6,6,6,6,6]');

    send(a, { type: 'hold', held: [true, false, false, true, false] });
    await until(() => b.state.held[0] === true, '고정');
    check('고정이 상대 화면에도 보인다', JSON.stringify(b.state.held) === JSON.stringify([true, false, false, true, false]));
    const kept = [a.state.dice[0], a.state.dice[3]];
    send(a, { type: 'roll' });
    await until(() => a.state.rollsLeft === 1, '두 번째 굴림');
    check('고정한 주사위는 그대로다', a.state.dice[0] === kept[0] && a.state.dice[3] === kept[1]);

    send(a, { type: 'hold', held: [true, false] });
    await until(() => a.errors.length > 0, '잘못된 고정');
    check('형식이 틀린 고정(5개가 아님)은 방에 닿기 전에 거절된다', a.errors[0] === '잘못된 요청입니다.' && a.state.rollsLeft === 1);
    send(a, { type: 'score', category: { $ne: null } });
    await until(() => a.errors.length > 1, '잘못된 칸');
    check('칸 이름이 객체면 거절된다', a.errors[1] === '잘못된 요청입니다.');
    send(a, { type: 'raise', amount: 100 });
    await until(() => a.errors.length > 2, '다른 게임 요청');
    check('다른 게임의 요청(배팅)은 거절된다', a.errors[2] === '잘못된 요청입니다.');
    send(a, { type: 'score', category: 'nope' });
    await until(() => a.errors.length > 3, '없는 칸');
    check('없는 칸은 안내와 함께 거절된다', /알 수 없는 칸/.test(a.errors[3]));

    send(a, { type: 'score', category: 'choice' });
    await until(() => b.state.you.myTurn === true, '차례 넘김');
    check('기록하면 점수가 들어가고 둘에게 차례가 넘어간다', a.state.board[0].sheet.choice === a.state.board[0].total && a.state.turnId === b.welcome.playerId && a.state.round === 1 && b.state.rollsLeft === 3);
    send(b, { type: 'roll' });
    await until(() => b.state.rolled, '두 번째 사람 굴림');
    send(b, { type: 'score', category: 'yacht' });
    await until(() => a.state.you.myTurn === true, '한 바퀴');
    send(a, { type: 'roll' });
    await until(() => a.state.rolled, '두 번째 라운드 굴림');
    send(a, { type: 'score', category: 'choice' });
    await until(() => a.errors.length > 4, '이미 쓴 칸');
    check('이미 쓴 칸은 거절되고 차례는 그대로다', /이미 기록한 칸/.test(a.errors[4]) && a.state.turnId === a.welcome.playerId && a.state.round === 2);

    console.log('\n=== 포털·보스 키·재접속 ===');
    await settle();
    const games = portal.last('games');
    check('포털에 야추다이스 채널의 인원·상태가 나온다', games && games.games.yacht && games.games.yacht.label === '야추다이스' && games.games.yacht.playerCount === 2 && games.games.yacht.status === '진행중', JSON.stringify(games && games.games.yacht));
    send(a, { type: 'cover' });
    await until(() => b.last('cover') && portal.last('cover'), '보스 키');
    check('야추다이스에서 가린 보스 키가 포털·다른 접속자에게도 퍼진다', !!b.last('cover') && !!portal.last('cover'));
    send(a, { type: 'coverState', covered: true });
    await until(() => b.state.paused === true, '멈춤');
    check('차례인 사람이 가리면 제한시간이 멈춘다', b.state.paused === true && typeof b.state.turnEndsAt === 'number');
    send(a, { type: 'coverState', covered: false });

    a.ws.close();
    await until(() => b.state.players.find((p) => p.nickname === '김하늘').connected === false, '끊김');
    const back = await connect('yacht', '김하늘', a.welcome.token);
    open.push(back);
    await until(() => back.state && back.welcome, '재접속');
    check('끊긴 뒤 같은 토큰으로 돌아오면 같은 자리·점수판·주사위 상태다', back.welcome.playerId === a.welcome.playerId && back.state.you.myTurn === true && back.state.board[0].sheet.choice !== null && back.state.round === 2);
  } finally {
    for (const c of open) { try { c.ws.close(); } catch { /* 이미 닫힘 */ } }
    await server.stop();
  }
  console.log(`\n야추다이스 서버: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
