'use strict';

const { createGameServer } = require('../web/game-server');

// 모듈 인스턴스마다 방 하나를 유지한다. Vercel이 WebSocket 업그레이드를 처리하고,
// 이 서버 객체에는 같은 Function 인스턴스에 배정된 참가자들이 연결된다.
const vercelOrigins = [
  process.env.VERCEL_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL,
  process.env.VERCEL_BRANCH_URL,
].filter(Boolean).map((host) => `https://${host}`);

const game = createGameServer({
  allowedOrigins: (process.env.LIAR_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .concat(vercelOrigins),
});

module.exports = game.getHttpServer();
