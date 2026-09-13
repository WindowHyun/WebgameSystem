'use strict';

const assert = require('assert');
const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

const PORT = 4194;
const URL = `ws://127.0.0.1:${PORT}/api/ws?game=poker`;

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
    const left = expect(first, (data) => data.type === 'left');
    first.send(JSON.stringify({ type: 'leave' }));
    assert.equal((await left).type, 'left');

    const second = await open();
    const secondWelcome = expect(second, (data) => data.type === 'welcome');
    const secondState = expect(second, (data) => data.type === 'pokerState');
    second.send(JSON.stringify({ type: 'join', nickname: '같은이름', token: welcome.token }));
    await secondWelcome;
    const state = await secondState;
    assert.equal(state.players.length, 1);
    assert.equal(state.players[0].nickname, '같은이름');
    first.close(); second.close();
    console.log('카드 게임 명시적 퇴장: 즉시 제거·재입장 중복 방지 통과');
  } finally {
    await server.stop();
  }
})().catch((error) => { console.error(error); process.exit(1); });
