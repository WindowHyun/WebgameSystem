'use strict';

/**
 * 텍사스 홀덤을 실제 소켓으로 붙여 본다(web/game-server.js의 holdem 채널).
 *
 *   - 두 사람이 들어와 준비하고 시작하면 각자 자기 카드만 받는다. 상대 카드는 소켓으로 오는 글자 어디에도 없다.
 *   - 화면이 보내는 요청(콜·레이즈·폴드·올인)이 방까지 닿는다. 형식이 틀린 요청은 방에 닿기 전에 거절된다.
 *   - 한 판이 끝나면 쇼다운에 간 사람의 카드와 패 이름이 모두에게 간다.
 *   - 포털이 홀덤의 인원·상태를 알려 준다. 홀덤에서 누른 보스 키가 다른 사람의 화면도 가린다.
 *
 * 실행: node test/holdem-server-test.js
 */

const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

const PORT = 4711;
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

/** 소켓 하나와 받은 글자(raw) 기록, 마지막 상태를 같이 들고 있는다. */
function connect(game) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?game=${game}`);
    const client = { ws, raw: [], messages: [], state: null, welcome: null, errors: [] };
    ws.on('message', (raw) => {
      const text = String(raw);
      client.raw.push(text);
      const data = JSON.parse(text);
      client.messages.push(data);
      if (data.type === 'holdemState') client.state = data;
      if (data.type === 'welcome') client.welcome = data;
      if (data.type === 'error') client.errors.push(data.message);
    });
    ws.on('open', () => resolve(client));
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
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

(async () => {
  const server = createGameServer({ port: PORT });
  await server.start();
  try {
    const portal = await connect('portal');
    const a = await connect('holdem');
    const b = await connect('holdem');
    send(a, { type: 'join', nickname: '김하늘' });
    send(b, { type: 'join', nickname: '박서준' });
    await until(() => a.welcome && b.welcome && a.state && a.state.players.length === 2, '두 명 입장');
    check('참가하면 홀덤 상태(holdemState)를 받는다', a.state.type === 'holdemState' && a.state.phase === 'lobby' && a.state.you.id === a.welcome.playerId);

    send(a, { type: 'ready', ready: true });
    send(b, { type: 'ready', ready: true });
    await until(() => a.state.canStart, '시작 가능');
    send(a, { type: 'start' });
    await until(() => a.state.phase === 'betting' && b.state.phase === 'betting', '판 시작');

    const mineA = a.state.players.find((p) => p.id === a.welcome.playerId).cards;
    const mineB = b.state.players.find((p) => p.id === b.welcome.playerId).cards;
    check('시작하면 각자 자기 카드 2장을 받는다', mineA.length === 2 && mineA.every((c) => c.rank) && mineB.length === 2 && mineB.every((c) => c.rank));
    check('상대 카드는 뒷면으로 온다', a.state.players.find((p) => p.id === b.welcome.playerId).cards.every((c) => c.hidden));
    const wire = (client) => client.raw.join('\n');
    const secret = (cards) => cards.map((c) => `"rank":${c.rank},"suit":"${c.suit}"`);
    // 상대 카드 두 장의 글자가 내 소켓으로 온 어떤 메시지에도 없어야 한다(공용 카드는 아직 없다).
    check('배팅 중에는 상대 카드의 정보가 소켓으로 오지 않는다', secret(mineB).every((piece) => !wire(a).includes(piece)) && secret(mineA).every((piece) => !wire(b).includes(piece)));
    check('블라인드가 상태에 실리고 딜러(사람)를 가리키는 값은 없다', a.state.pot === 150 && !('dealerId' in a.state) && !!a.state.smallBlindId && !!a.state.bigBlindId && a.state.board.length === 0);

    // 화면이 보내는 요청이 방까지 닿는다.
    const first = a.state.turnPlayerId === a.welcome.playerId ? a : b;
    const second = first === a ? b : a;
    send(second, { type: 'call' });
    await until(() => second.errors.length >= 1, '차례 아님 거절');
    check('차례가 아닌 사람의 요청은 이유와 함께 거절된다', second.errors[0] === '지금은 본인 차례가 아닙니다.');
    send(first, { type: 'raise', amount: '100' });
    await until(() => first.errors.length >= 1, '형식 오류');
    check('형식이 틀린 요청은 방에 닿기 전에 거절된다', first.errors[0] === '잘못된 요청입니다.' && a.state.currentBet === 100);
    send(first, { type: 'raise', amount: 200 });
    await until(() => a.state.currentBet === 300, '레이즈 반영');
    check('레이즈가 방까지 닿아 배팅액이 오른다', a.state.currentBet === 300 && b.state.currentBet === 300);
    send(second, { type: 'call' });
    await until(() => a.state.street === 'flop', '플랍');
    check('거리가 끝나면 공용 카드 3장이 모두에게 간다', a.state.board.length === 3 && b.state.board.length === 3 && a.state.pot === 600);

    // 끝까지 체크로 간다.
    for (const street of ['flop', 'turn', 'river']) {
      for (let i = 0; i < 2; i += 1) {
        await until(() => a.state.street === street || a.state.phase === 'result', `${street} 차례`);
        if (a.state.phase === 'result' || a.state.street !== street) break;
        const mover = a.state.turnPlayerId === a.welcome.playerId ? a : b;
        send(mover, { type: 'call' });
        await settle();
      }
    }
    await until(() => a.state.phase === 'result' && b.state.phase === 'result', '결과');
    check('끝까지 가면 결과에 이긴 사람과 패 이름이 있다', a.state.result.revealed && a.state.result.winners.length >= 1 && a.state.result.winners.every((w) => typeof w.handName === 'string'));
    check('쇼다운에 간 두 사람의 카드가 모두에게 공개된다', a.state.result.hands.length === 2 && a.state.players.every((p) => p.cards && p.cards.every((c) => c.rank)));
    check('결과 뒤 칩 총합은 그대로다', a.state.players.reduce((sum, p) => sum + p.chips, 0) === 2000000);

    // 포털과 보스 키.
    await until(() => portal.messages.some((m) => m.type === 'games' && m.games.holdem), '포털 상태');
    const games = portal.messages.filter((m) => m.type === 'games').pop().games;
    check('포털이 홀덤의 이름·인원·상태를 알려 준다', games.holdem.label === '텍사스 홀덤' && games.holdem.playerCount === 2 && ['진행 대기중', '진행중', '대기중'].includes(games.holdem.status), JSON.stringify(games.holdem));
    const covered = new Promise((resolve) => portal.ws.on('message', (raw) => { if (JSON.parse(raw).type === 'cover') resolve(true); }));
    send(a, { type: 'cover' });
    check('홀덤에서 누른 보스 키가 포털 화면도 가린다', await Promise.race([covered, new Promise((r) => setTimeout(() => r(false), 1500))]));
    check('보스 키를 누른 사람 자신에게는 가림 알림이 되돌아오지 않는다', !a.messages.some((m) => m.type === 'cover'));

    // 나가기.
    send(b, { type: 'leave' });
    await until(() => b.messages.some((m) => m.type === 'left'), '나가기');
    await until(() => a.state.players.length === 1, '나간 뒤 목록');
    check('나가면 목록에서 빠진다', a.state.players.length === 1);

    // 라이어나 다른 게임 채널과 섞이지 않는다.
    const stranger = await connect('holdem');
    send(stranger, { type: 'hit' });
    await until(() => stranger.errors.length >= 1, '다른 게임 요청');
    check('다른 게임의 요청(블랙잭 hit)은 거절된다', stranger.errors[0] === '잘못된 요청입니다.');

    [portal, a, b, stranger].forEach((c) => c.ws.close());
  } finally {
    await server.stop();
  }
  console.log(`\n홀덤 서버: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
