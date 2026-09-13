'use strict';

const WebSocket = require('ws');
const server = require('../api/ws');

function waitFor(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('메시지 대기 시간 초과')), 3000);
    function onMessage(raw) {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

async function connect(port, nickname) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const welcome = waitFor(ws, (message) => message.type === 'welcome');
  ws.send(JSON.stringify({ type: 'join', nickname, token: null, spectator: false }));
  await welcome;
  return ws;
}

async function main() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  const first = await connect(port, '첫째');
  const stateWithTwo = waitFor(first, (message) => message.type === 'state' && message.players.length === 2);
  const second = await connect(port, '둘째');
  await stateWithTwo;

  first.close();
  second.close();
  await new Promise((resolve) => server.close(resolve));
  console.log('Vercel 어댑터: 2명 WebSocket 연결 통과');
}

main().catch((err) => {
  console.error(`Vercel 어댑터 실패: ${err.stack || err}`);
  process.exitCode = 1;
  try { server.close(); } catch { /* 이미 닫힘 */ }
});

