'use strict';

/**
 * 공통 연결 관리(public/game-socket.js)의 경합 상황 - 브라우저 없이 가짜 소켓·가짜 시계로 돌린다.
 *
 * 실제 폰에서는 "옛 소켓이 늦게 닫힘", "확인(ping) 중에 끊김", "열리다 멈춘 소켓" 같은 순서가
 * 우연히만 나와서 브라우저 테스트로는 재현이 안 된다. 여기서는 순서를 손으로 정해서 돌린다.
 *
 *   - 닫히는 중이던 옛 소켓의 늦은 onclose가 새로 붙은 연결을 "끊김"으로 덮지 않는다
 *     (덮이면 버튼이 전부 막혀 차례를 놓치고 자동 폴드된다)
 *   - 옛 소켓에 걸었던 확인 타이머가 새로 여는 소켓을 죽은 것으로 보고 끊지 않는다
 *   - 옛 소켓이 늦게 전해 준 replaced가 멀쩡한 창을 영구 중단시키지 않는다
 *   - 좀비 연결(OPEN인데 25초 넘게 아무 소식 없음)을 스스로 버리고 새로 붙는다
 *   - 열리다 멈춘 소켓(CONNECTING 8초 넘음)을 버리고 새로 붙는다
 *   - 돌아왔을 때 확인에 답이 오면 그대로 쓰고, 답이 없으면 새로 붙는다
 *   - 나가기로 목록에 갔다가 뒤로 가기(bfcache)로 돌아오면 새로 불러 다시 참가한다
 *
 * 실행: node test/socket-race-test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'game-socket.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

/** game-socket.js를 가짜 브라우저 안에 올린다. 시계는 advance()로만 흐른다. */
function makeBrowser() {
  let now = 1_000_000;
  let nextTimer = 1;
  const timers = new Map();
  const addTimer = (fn, ms, every) => { const id = nextTimer++; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, every }); return id; };
  const clearTimer = (id) => { timers.delete(id); };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      let due = null;
      for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due.t.at || (t.at === due.t.at && id < due.id))) due = { id, t };
      if (!due) break;
      now = due.t.at;
      if (due.t.every) due.t.at += due.t.every; else timers.delete(due.id);
      due.t.fn();
    }
    now = end;
  }

  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.closedByPage = false;
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      sockets.push(this);
    }
    send(data) {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error('열리지 않은 소켓에 보냄');
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.closedByPage = true;
      if (this.readyState < FakeWebSocket.CLOSING) this.readyState = FakeWebSocket.CLOSING;
    }
    // 아래는 테스트가 "네트워크/서버" 역할로 부른다.
    opened() { this.readyState = FakeWebSocket.OPEN; if (this.onopen) this.onopen({}); }
    receive(data) { if (this.onmessage) this.onmessage({ data: JSON.stringify(data) }); }
    closing() { this.readyState = FakeWebSocket.CLOSING; }
    closed() { this.readyState = FakeWebSocket.CLOSED; if (this.onclose) this.onclose({}); }
    types() { return this.sent.map((m) => m.type); }
  }
  Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  const listeners = { document: {}, window: {} };
  const on = (bucket) => (type, fn) => { (bucket[type] = bucket[type] || []).push(fn); };
  const bodyAttributes = new Set();
  const appended = [];
  const document = {
    visibilityState: 'visible',
    addEventListener: on(listeners.document),
    createElement: (tag) => ({ tag, textContent: '', setAttribute() {}, appendChild() {} }),
    body: {
      setAttribute: (name) => bodyAttributes.add(name),
      removeAttribute: (name) => bodyAttributes.delete(name),
      appendChild: (el) => appended.push(el),
    },
  };
  const window = { addEventListener: on(listeners.window) };
  const location = { protocol: 'https:', host: 'game.test', href: 'https://game.test/poker.html', reloads: 0, reload() { this.reloads += 1; } };
  const stored = new Map();
  const sessionStorage = {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => stored.set(k, String(v)),
    removeItem: (k) => stored.delete(k),
  };
  const fakeMath = Object.create(Math);
  fakeMath.random = () => 0.5; // 재시도 지터를 없앤다(대기 = 기본 간격 그대로)

  const context = vm.createContext({
    window, document, location, sessionStorage, WebSocket: FakeWebSocket,
    setTimeout: (fn, ms) => addTimer(fn, ms, 0), clearTimeout: clearTimer,
    setInterval: (fn, ms) => addTimer(fn, ms, Number(ms) || 1), clearInterval: clearTimer,
    Date: { now: () => now }, Math: fakeMath, JSON, Object,
  });
  vm.runInContext(SOURCE, context, { filename: 'game-socket.js' });

  const fire = (bucket, type, event) => { for (const fn of listeners[bucket][type] || []) fn(event || {}); };
  const messages = [];
  const socket = window.GameSocket.open({
    game: 'poker', tokenKey: 'poker-game-token', nickname: '갑',
    onMessage: (data) => messages.push(data),
  });
  return {
    socket, sockets, messages, location, advance,
    offline: () => bodyAttributes.has('data-offline'),
    fatal: () => appended.some((el) => el.id === 'fatal'),
    last: () => sockets[sockets.length - 1],
    focus: () => fire('window', 'focus'),
    hide: () => { document.visibilityState = 'hidden'; fire('document', 'visibilitychange'); },
    show: () => { document.visibilityState = 'visible'; fire('document', 'visibilitychange'); },
    pageshow: (persisted) => fire('window', 'pageshow', { persisted }),
  };
}

function scenario(name, run) {
  try { run(); } catch (error) { check(name, false, error.stack.split('\n').slice(0, 3).join(' | ')); }
}

scenario('처음 연결', () => {
  const b = makeBrowser();
  check('처음 연결: 소켓 하나를 연다', b.sockets.length === 1 && b.sockets[0].url === 'wss://game.test/api/ws?game=poker', b.sockets.map((s) => s.url).join());
  b.sockets[0].opened();
  check('처음 연결: 열리면 참가 요청을 보낸다', b.sockets[0].types().join() === 'join' && b.sockets[0].sent[0].nickname === '갑', b.sockets[0].types().join());
  check('처음 연결: 끊김 표시가 없다', !b.offline());
});

scenario('옛 소켓의 늦은 onclose', () => {
  const b = makeBrowser();
  const a = b.sockets[0];
  a.opened();
  a.closing(); // 서버가 닫기 시작했다(onclose는 아직)
  b.focus(); // 그 사이 돌아와서 새로 붙는다
  const fresh = b.last();
  check('늦은 onclose: 닫히는 중인 옛 소켓 대신 새 소켓을 연다', b.sockets.length === 2 && fresh !== a, `${b.sockets.length}개`);
  fresh.opened();
  a.closed(); // 이제서야 옛 소켓의 닫힘이 도착한다
  b.advance(6000);
  check('늦은 onclose: 새 연결 위에 끊김 표시가 뜨지 않는다', !b.offline());
  check('늦은 onclose: 멀쩡한 새 연결을 버리고 또 붙지 않는다', b.sockets.length === 2 && !fresh.closedByPage, `${b.sockets.length}개`);
  b.socket.send('call');
  check('늦은 onclose: 보내기는 새 연결로 간다', fresh.types().includes('call'), fresh.types().join());
});

scenario('옛 소켓의 늦은 replaced', () => {
  const b = makeBrowser();
  const a = b.sockets[0];
  a.opened();
  a.closing();
  b.focus();
  const fresh = b.last();
  fresh.opened();
  a.receive({ type: 'replaced' }); // 옛 연결이 서버의 "자리를 넘겼다"를 늦게 전한다
  check('늦은 replaced: 새로 붙은 창이 중단되지 않는다', !b.fatal() && !b.offline());
  b.advance(10000); // 다음 확인(ping)이 새 연결로 나간다
  check('늦은 replaced: 새 연결을 계속 쓴다', b.sockets.length === 2 && fresh.types().includes('ping'), `${b.sockets.length}개, ${fresh.types().join()}`);
});

scenario('확인 중에 끊김', () => {
  const b = makeBrowser();
  const a = b.sockets[0];
  a.opened();
  b.hide();
  b.show(); // 돌아왔다 - 확인(ping)을 보내고 2.5초 기다린다
  check('확인 중 끊김: 돌아오면 확인을 보낸다', a.types().includes('ping'), a.types().join());
  b.advance(100);
  a.closed(); // 확인 중에 옛 연결이 닫혔다
  b.advance(500); // 재시도(0.5초 뒤)로 새 소켓을 연다 - 아직 CONNECTING
  const fresh = b.last();
  check('확인 중 끊김: 재시도가 새 소켓을 연다', b.sockets.length === 2 && fresh.readyState === 0, `${b.sockets.length}개`);
  b.advance(2500); // 옛 확인 타이머가 남아 있었다면 여기서 새 소켓을 끊는다
  check('확인 중 끊김: 옛 확인 타이머가 새로 여는 소켓을 끊지 않는다', !fresh.closedByPage && b.sockets.length === 2, `${b.sockets.length}개, 끊김=${fresh.closedByPage}`);
  fresh.opened();
  check('확인 중 끊김: 새 연결이 열리면 끊김 표시가 사라진다', !b.offline());
});

scenario('돌아와서 확인', () => {
  const b = makeBrowser();
  const a = b.sockets[0];
  a.opened();
  b.hide();
  b.show();
  b.advance(300);
  a.receive({ type: 'pong' });
  b.advance(5000);
  check('확인 성공: 답이 오면 그 연결을 그대로 쓴다', b.sockets.length === 1 && !a.closedByPage && !b.offline(), `${b.sockets.length}개`);

  const c = makeBrowser();
  const z = c.sockets[0];
  z.opened();
  c.hide();
  c.show();
  c.advance(700);
  check('확인 실패: 0.6초 넘게 답이 없으면 다시 연결 중으로 보인다', c.offline());
  c.advance(2000);
  check('확인 실패: 2.5초 안에 답이 없으면 버리고 새로 붙는다', z.closedByPage && c.sockets.length === 2, `${c.sockets.length}개`);
  c.last().opened();
  check('확인 실패: 새 연결로 다시 참가한다', c.last().types().join() === 'join' && !c.offline(), c.last().types().join());
});

scenario('좀비 연결', () => {
  const b = makeBrowser();
  const a = b.sockets[0];
  a.opened();
  b.advance(10000);
  check('좀비: 10초마다 살아 있는지 물어본다', a.types().filter((t) => t === 'ping').length === 1, a.types().join());
  b.advance(20000); // 30초 동안 아무 답이 없다
  check('좀비: 25초 넘게 소식이 없으면 버리고 새로 붙는다', a.closedByPage && b.sockets.length === 2, `${b.sockets.length}개`);
});

scenario('열리다 멈춘 소켓', () => {
  const b = makeBrowser();
  const a = b.sockets[0]; // 영영 열리지 않는다
  b.advance(10000);
  check('멈춘 소켓: 8초 넘게 열리지 않으면 버린다', a.closedByPage, `상태=${a.readyState}`);
  check('멈춘 소켓: 끊김으로 표시한다', b.offline());
  b.advance(1000);
  check('멈춘 소켓: 곧 새로 붙는다', b.sockets.length === 2, `${b.sockets.length}개`);
});

scenario('돌아오기 직전에 연 소켓', () => {
  const b = makeBrowser();
  const a = b.sockets[0];
  a.opened();
  b.hide();
  a.closed();
  b.advance(500); // 숨겨진 동안 재시도 - 통신이 끊긴 채 연 소켓
  const stale = b.last();
  b.show();
  check('숨겨진 동안 연 소켓: 돌아오면 기다리지 않고 새로 연다', stale.closedByPage && b.sockets.length === 3, `${b.sockets.length}개`);
});

scenario('나가기 뒤 뒤로 가기', () => {
  const b = makeBrowser();
  b.sockets[0].opened();
  b.socket.leave();
  check('나가기: 서버에 나가기를 보낸다', b.sockets[0].types().includes('leave'), b.sockets[0].types().join());
  b.sockets[0].receive({ type: 'left' });
  check('나가기: 목록으로 간다', b.location.href === '/', b.location.href);
  b.pageshow(true); // 뒤로 가기 - 브라우저가 얼려 둔 이 페이지를 그대로 꺼낸다
  check('뒤로 가기: 얼려 둔 나간 화면을 새로 불러 다시 참가한다', b.location.reloads === 1, `${b.location.reloads}번`);
  const c = makeBrowser();
  c.sockets[0].opened();
  c.pageshow(false);
  check('보통 pageshow: 새로 불러오지 않는다', c.location.reloads === 0);
});

console.log(`\n연결 경합: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
