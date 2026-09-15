'use strict';

/**
 * [모바일] 화면을 전환하거나 백그라운드로 내리면 브라우저가 소켓을 조용히 끊는다.
 * 서버는 그걸 ping 실패로만(최대 수십 초 뒤) 알아채므로, 그 전에 새 연결이 같은
 * 토큰으로 먼저 들어올 수 있다. 이때 이전 연결이 서버 입장에서는 아직 "접속 중"으로
 * 보여도, 같은 자리로 인계되어야 한다(포커/블랙잭은 이미 이렇게 동작한다).
 *
 * 실행: node test/liar-reconnect-test.js
 */

const assert = require('assert');
const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

const PORT = 4198;
const URL = `ws://127.0.0.1:${PORT}/api/ws?game=liar`;

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function expect(ws, match) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('응답 없음')), 2000);
    function receive(raw) {
      const data = JSON.parse(raw);
      if (!match(data)) return;
      clearTimeout(timer);
      ws.off('message', receive);
      resolve(data);
    }
    ws.on('message', receive);
  });
}

(async () => {
  const server = createGameServer({ port: PORT });
  await server.start();
  try {
    const first = await open();
    const firstWelcome = expect(first, (data) => data.type === 'welcome');
    first.send(JSON.stringify({ type: 'join', nickname: '같은이름' }));
    const welcome = await firstWelcome;

    // 첫 소켓의 close/terminate 없이(=서버는 아직 "접속 중") 같은 토큰으로 새 연결이
    // 들어온다. Render 재배포·모바일 백그라운드 전환에서 실제로 벌어지는 순서다.
    const second = await open();
    const secondWelcome = expect(second, (data) => data.type === 'welcome');
    const secondState = expect(second, (data) => data.type === 'state');
    const replaced = expect(first, (data) => data.type === 'replaced');
    second.send(JSON.stringify({ type: 'join', nickname: '같은이름', token: welcome.token }));

    const restored = await secondWelcome;
    assert.equal(restored.playerId, welcome.playerId,
      '이전 연결이 아직 살아 있어 보여도 같은 토큰이면 같은 자리로 복구되어야 한다');
    const state = await secondState;
    assert.equal(state.players.length, 1, '참가자가 둘로 늘어나면 안 된다(자리 인계여야 한다)');
    assert.equal((await replaced).type, 'replaced', '밀려난 이전 연결은 알림을 받아야 한다');

    first.close(); second.close();
    console.log('라이어 게임: 아직 접속 중으로 보이는 이전 연결도 같은 토큰으로 자리를 인계받음 - 통과');
  } finally {
    await server.stop();
  }
})().catch((error) => { console.error(error); process.exit(1); });
