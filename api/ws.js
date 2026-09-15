'use strict';

const { createGameServer } = require('../web/game-server');
const { error } = require('../logger');

// web/server.js(Render 경로)에만 있던 안전망을 이쪽에도 둔다. 이게 없으면 예상 못 한
// 예외 하나가 이 인스턴스를 그대로 죽이고, 붙어 있던 사람 전원이 판 도중에 튕긴다.
process.on('uncaughtException', (err) => {
  error(`[치명적 오류] ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  error(`[처리되지 않은 실패] ${reason && reason.stack ? reason.stack : reason}`);
});

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
