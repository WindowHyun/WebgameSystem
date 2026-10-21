'use strict';

/**
 * 운영자 화면 /order (web/game-server.js).
 *
 *   - 열쇠(X-Order-Key)가 없거나 틀리면 접속자·칩 목록도 입금도 안 된다. 많이 틀리면 잠시 막힌다.
 *   - 열쇠가 맞으면 게임별 접속자·진행 상태·보유 칩을 본다(카드나 정답은 내려오지 않는다).
 *   - 입금은 기부가 아니라 칩을 새로 넣는 것이다: 받은 사람 칩만 늘고 다른 사람 칩은 그대로다.
 *   - 칩이 없는 게임(라이어·마인드·갈팡질팡)이나 잘못된 금액·참가자는 거절된다.
 *
 * 실행: node test/order-test.js
 */

const http = require('http');
const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

const PORT = 4731;
const KEY = 'test-order-key';
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(method, path, { key, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (key !== undefined) headers['X-Order-Key'] = key;
    const data = raw !== undefined ? raw : (body === undefined ? null : JSON.stringify(body));
    if (data !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* html 등 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

function join(game, nickname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?game=${game}`);
    const client = { ws, state: null, welcome: null, raw: [] };
    ws.on('message', (raw) => {
      client.raw.push(String(raw));
      const data = JSON.parse(String(raw));
      if (data.type === 'welcome') client.welcome = data;
      if (/state$/i.test(data.type)) client.state = data;
    });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'join', nickname })); });
    ws.on('error', reject);
    const started = Date.now();
    const timer = setInterval(() => {
      if (client.welcome && client.state) { clearInterval(timer); resolve(client); }
      else if (Date.now() - started > 3000) { clearInterval(timer); reject(new Error(`${game} 입장 시간 초과`)); }
    }, 20);
  });
}

(async () => {
  const server = createGameServer({ port: PORT, orderKey: KEY });
  await server.start();
  const sockets = [];
  try {
    console.log('\n=== 화면과 열쇠 ===');
    const page = await request('GET', '/order');
    check('/order는 운영자 화면(html)을 준다', page.status === 200 && /text\/html/.test(page.headers['content-type']) && page.text.includes('order.js'));
    const script = await request('GET', '/order.js');
    check('화면 스크립트·스타일도 같은 서버가 준다', script.status === 200 && (await request('GET', '/order.css')).status === 200);
    check('열쇠가 없으면 목록을 주지 않는다', (await request('GET', '/order/api/state')).status === 401);
    check('틀린 열쇠도 거절한다', (await request('GET', '/order/api/state', { key: 'nope' })).status === 401);

    const poker = await join('poker', '가나다');
    const poker2 = await join('poker', '라마바');
    const blackjack = await join('blackjack', '사아자');
    const liar = await join('liar', '차카타');
    sockets.push(poker, poker2, blackjack, liar);
    await wait(150);

    console.log('\n=== 접속자·칩 목록 ===');
    const snap = await request('GET', '/order/api/state', { key: KEY });
    const games = snap.json && snap.json.games;
    const byKey = (key) => games.find((g) => g.key === key);
    check('열쇠가 맞으면 목록이 온다', snap.status === 200 && Array.isArray(games) && games.length === 6, snap.text.slice(0, 120));
    check('게임별 접속자와 보유 칩이 나온다', byKey('poker').players.length === 2 && byKey('poker').players.every((p) => p.connected && p.chips === 1000000 && p.chips !== null) && byKey('poker').chips === true);
    check('칩이 없는 게임은 입금 대상이 아니라고 알려 준다', byKey('liar').chips === false && byKey('mind').chips === false && byKey('galpang').chips === false && byKey('liar').players.length === 1);
    check('아직 시작 전이라 진행 중인 게임은 없다', games.every((g) => g.running === false));
    check('목록에는 카드·정답·토큰 같은 정보가 없다', !/token|hole|"hand"|answer|"card"/.test(snap.text), snap.text.slice(0, 200));

    console.log('\n=== 진행 중 표시 ===');
    for (const c of [poker, poker2]) c.ws.send(JSON.stringify({ type: 'ready', ready: true }));
    await wait(100);
    poker.ws.send(JSON.stringify({ type: 'start' }));
    await wait(200);
    const running = await request('GET', '/order/api/state', { key: KEY });
    check('포커를 시작하면 진행중으로 나오고 참여자가 표시된다', running.json.games.find((g) => g.key === 'poker').running === true && running.json.games.find((g) => g.key === 'poker').players.every((p) => p.inRound));

    console.log('\n=== 입금 ===');
    const target = byKey('poker').players.find((p) => p.nickname === '가나다');
    const other = byKey('poker').players.find((p) => p.nickname === '라마바');
    const deposit = (body, key) => request('POST', '/order/api/deposit', { key: key === undefined ? KEY : key, body });
    const before = (await request('GET', '/order/api/state', { key: KEY })).json.games.find((g) => g.key === 'poker').players;
    const done = await deposit({ game: 'poker', playerId: target.id, amount: 500000 });
    const afterGame = done.json && done.json.state.games.find((g) => g.key === 'poker');
    const chipsOf = (list, id) => list.find((p) => p.id === id).chips;
    check('입금하면 받은 사람의 칩만 그 금액만큼 늘고 다른 사람은 그대로다(기부가 아니다)',
      done.status === 200 && chipsOf(afterGame.players, target.id) === chipsOf(before, target.id) + 500000 && chipsOf(afterGame.players, other.id) === chipsOf(before, other.id), done.text.slice(0, 160));
    await wait(100);
    check('받은 사람의 게임 화면에도 바로 반영된다', poker.state.you.chips === chipsOf(before, target.id) + 500000, String(poker.state.you.chips));
    check('판이 진행 중이어도 넣을 수 있다', poker.state.phase === 'betting');

    const bjTarget = byKey('blackjack').players[0];
    const bj = await deposit({ game: 'blackjack', playerId: bjTarget.id, amount: 1234 });
    check('블랙잭에도 입금할 수 있다', bj.status === 200 && bj.json.state.games.find((g) => g.key === 'blackjack').players[0].chips === 1000000 + 1234);

    console.log('\n=== 거절 ===');
    const chipsNow = () => request('GET', '/order/api/state', { key: KEY }).then((r) => r.json.games.find((g) => g.key === 'poker').players.map((p) => p.chips).join());
    const snapshotBefore = await chipsNow();
    const bad = {
      '열쇠 없이': await deposit({ game: 'poker', playerId: target.id, amount: 100 }, ''),
      '틀린 열쇠로': await deposit({ game: 'poker', playerId: target.id, amount: 100 }, 'x'),
      '0원': await deposit({ game: 'poker', playerId: target.id, amount: 0 }),
      '음수': await deposit({ game: 'poker', playerId: target.id, amount: -500 }),
      '소수': await deposit({ game: 'poker', playerId: target.id, amount: 1.5 }),
      '문자열 금액': await deposit({ game: 'poker', playerId: target.id, amount: '500' }),
      '한도 초과': await deposit({ game: 'poker', playerId: target.id, amount: 2000000000 }),
      '없는 참가자': await deposit({ game: 'poker', playerId: 'nobody', amount: 100 }),
      '칩이 없는 게임(라이어)': await deposit({ game: 'liar', playerId: liar.welcome.playerId, amount: 100 }),
      '칩이 없는 게임(마인드)': await deposit({ game: 'mind', playerId: 'x', amount: 100 }),
      '없는 게임': await deposit({ game: 'nothing', playerId: 'x', amount: 100 }),
      '프로토타입 이름(constructor)': await deposit({ game: 'constructor', playerId: 'x', amount: 100 }),
      '참가자가 문자열이 아님': await deposit({ game: 'poker', playerId: { a: 1 }, amount: 100 }),
    };
    for (const [name, res] of Object.entries(bad)) check(`${name} 입금은 거절된다`, res.status >= 400 && res.status < 500, `${res.status} ${res.text.slice(0, 80)}`);
    const broken = await request('POST', '/order/api/deposit', { key: KEY, raw: '{not json' });
    check('깨진 JSON은 거절된다', broken.status === 400);
    const huge = await request('POST', '/order/api/deposit', { key: KEY, raw: JSON.stringify({ game: 'poker', pad: 'x'.repeat(5000) }) }).then((r) => r.status, () => 'closed');
    check('너무 큰 요청은 받지 않는다', huge === 'closed' || huge >= 400, String(huge));
    check('거절된 요청으로는 칩이 하나도 바뀌지 않았다', (await chipsNow()) === snapshotBefore);
    check('GET으로는 입금할 수 없다', (await request('GET', '/order/api/deposit', { key: KEY })).status === 404);

    console.log('\n=== 열쇠 추측 제한 ===');
    let limited = false;
    for (let i = 0; i < 30 && !limited; i += 1) limited = (await request('GET', '/order/api/state', { key: `guess-${i}` })).status === 429;
    check('열쇠를 많이 틀리면 잠시 막힌다', limited);
    check('막혀 있는 동안은 맞는 열쇠도 받지 않는다(추측 속도를 못 높인다)', (await request('GET', '/order/api/state', { key: KEY })).status === 429);
  } finally {
    for (const c of sockets) { try { c.ws.close(); } catch { /* 이미 닫힘 */ } }
    await server.stop();
  }
  console.log(`\n운영자 화면: ${pass}개 통과, ${fail}개 실패`);
  if (fail) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
