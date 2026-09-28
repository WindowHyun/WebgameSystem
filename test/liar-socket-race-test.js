'use strict';

/**
 * 라이어 화면(public/app.js)의 연결 경합 - 브라우저에 가짜 소켓과 가짜 시계를 넣고 순서를 손으로 정한다.
 * (카드 게임 쪽 public/game-socket.js는 test/socket-race-test.js가 같은 것을 본다.)
 *
 *   - 닫히는 중이던 옛 소켓의 늦은 onclose가 새로 붙은 연결 위에 "끊어졌습니다"를 띄우지 않고,
 *     새 연결의 감시기(ping)도 멈추지 않는다
 *   - 옛 소켓에 걸었던 확인 타이머가 새로 여는 소켓을 죽은 것으로 보고 끊지 않는다
 *   - 옛 소켓이 늦게 전해 준 replaced가 멀쩡한 창을 멈추지 않는다
 *
 * 실행: node test/liar-socket-race-test.js
 */

const { chromium } = require('playwright');
const { createGameServer } = require('../web/game-server');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

/** 페이지의 WebSocket을 가짜로 바꾼다. 테스트가 서버 역할로 열고 닫고 보낸다. */
function installFakeSocket() {
  window.__sockets = [];
  Math.random = () => 0.5; // 재시도 지터를 없앤다
  function FakeWebSocket(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closedByPage = false;
    window.__sockets.push(this);
  }
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  FakeWebSocket.prototype.send = function (data) {
    if (this.readyState !== 1) throw new Error('열리지 않은 소켓에 보냄');
    this.sent.push(JSON.parse(data).type);
  };
  FakeWebSocket.prototype.close = function () {
    this.closedByPage = true;
    if (this.readyState < 2) this.readyState = 2;
  };
  window.WebSocket = FakeWebSocket;
  const at = (i) => window.__sockets[i < 0 ? window.__sockets.length + i : i];
  window.__net = {
    count: () => window.__sockets.length,
    open: (i) => { const s = at(i); s.readyState = 1; if (s.onopen) s.onopen({}); },
    closing: (i) => { at(i).readyState = 2; },
    closed: (i) => { const s = at(i); s.readyState = 3; if (s.onclose) s.onclose({}); },
    receive: (i, data) => { const s = at(i); if (s.onmessage) s.onmessage({ data: JSON.stringify(data) }); },
    info: (i) => { const s = at(i); return { readyState: s.readyState, sent: s.sent.slice(), closedByPage: s.closedByPage }; },
  };
}

const VIEW = `(() => ({
  banner: document.getElementById('banner').classList.contains('hidden') ? null : document.getElementById('banner').textContent.trim(),
  hint: document.getElementById('conn-hint').textContent.trim(),
}))()`;

(async () => {
  const port = 4671;
  const server = createGameServer({ port, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const fresh = async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.clock.install();
      await page.addInitScript(installFakeSocket);
      await page.goto(`http://127.0.0.1:${port}/liar.html`);
      await page.waitForFunction(() => window.__net && window.__net.count() === 1);
      const net = (method, ...args) => page.evaluate(([m, a]) => window.__net[m](...a), [method, args]);
      return { page, context, net, view: () => page.evaluate(VIEW) };
    };

    {
      const { page, context, net, view } = await fresh();
      await net('open', 0);
      await net('closing', 0); // 서버가 닫기 시작했다(onclose는 아직)
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // 그 사이 돌아와서 새로 붙는다
      check('늦은 onclose: 닫히는 중인 옛 소켓 대신 새 소켓을 연다', await net('count') === 2, `${await net('count')}개`);
      await net('open', 1);
      await net('closed', 0); // 이제서야 옛 소켓의 닫힘이 도착한다
      await page.clock.runFor(6000);
      const shown = await view();
      check('늦은 onclose: 새 연결 위에 끊김 안내가 뜨지 않는다', shown.banner === null && shown.hint === '', JSON.stringify(shown));
      check('늦은 onclose: 멀쩡한 새 연결을 버리고 또 붙지 않는다', await net('count') === 2 && !(await net('info', 1)).closedByPage, `${await net('count')}개`);
      await page.clock.runFor(5000);
      check('늦은 onclose: 새 연결의 감시기가 계속 돈다(ping)', (await net('info', 1)).sent.includes('ping'), (await net('info', 1)).sent.join());
      await net('receive', 0, { type: 'replaced' }); // 옛 연결이 서버의 "자리를 넘겼다"를 늦게 전한다
      check('늦은 replaced: 새로 붙은 창에 "다른 곳에서 접속" 안내가 뜨지 않는다', (await view()).banner === null, JSON.stringify(await view()));
      await context.close();
    }

    {
      const { page, context, net, view } = await fresh();
      await net('open', 0);
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // 돌아왔다 - 확인(ping)을 보내고 2.5초 기다린다
      check('확인 중 끊김: 돌아오면 확인을 보낸다', (await net('info', 0)).sent.includes('ping'), (await net('info', 0)).sent.join());
      await page.clock.runFor(100);
      await net('closed', 0); // 확인 중에 옛 연결이 닫혔다
      await page.clock.runFor(500); // 재시도로 새 소켓을 연다 - 아직 CONNECTING
      check('확인 중 끊김: 재시도가 새 소켓을 연다', await net('count') === 2 && (await net('info', 1)).readyState === 0, `${await net('count')}개`);
      await page.clock.runFor(2500); // 옛 확인 타이머가 남아 있었다면 여기서 새 소켓을 끊는다
      const second = await net('info', 1);
      check('확인 중 끊김: 옛 확인 타이머가 새로 여는 소켓을 끊지 않는다', !second.closedByPage && await net('count') === 2, `${await net('count')}개, 끊김=${second.closedByPage}`);
      await net('open', 1);
      check('확인 중 끊김: 새 연결이 열리면 끊김 안내가 사라진다', (await view()).banner === null, JSON.stringify(await view()));
      await context.close();
    }

    check('브라우저 오류 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
  }
  console.log(`\n라이어 연결 경합: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
