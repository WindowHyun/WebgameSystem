'use strict';

/**
 * [S-4][S-7] 배포 환경(Render + Cloudflare) 앞단에서만 드러나는 두 가지를 확인한다.
 *
 *   1. 모든 HTTP 응답에 보안 헤더가 붙는가. CSP는 이 앱에 인라인 <script>/style=/onclick=이
 *      하나도 없다는 전제 위에 서 있어서, 누군가 인라인을 넣으면 화면이 조용히 깨진다.
 *      여기서 헤더 자체를 고정해 두면 최소한 "왜 깨졌는지"는 바로 드러난다.
 *   2. 동시 연결 수를 세는 IP를 어디서 읽는가. X-Forwarded-For는 클라이언트가 먼저 채워
 *      보내면 그 값이 맨 앞에 남는 헤더라, 그것만 믿으면 캡이 한 줄로 무력화된다.
 */

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

const PORT = 4198;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, headers: headers || {} }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 핸드셰이크는 통과시키고 정원 초과일 때만 끊으므로, 잠깐 기다렸다 상태를 본다. */
function openSocket(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?game=portal`, {
      origin: `http://127.0.0.1:${PORT}`,
      headers: headers || {},
    });
    ws.on('error', () => {});
    ws.on('open', () => resolve(ws));
    ws.on('close', () => resolve(ws));
    setTimeout(() => resolve(ws), 3000);
  });
}

async function main() {
  // 캡을 2로 낮춰 잡아야 적은 연결로 경계를 볼 수 있다.
  const server = createGameServer({ port: PORT, host: '127.0.0.1', maxConnectionsPerIp: 2 });
  await server.start();
  const sockets = [];
  try {
    // ── 1. 보안 헤더 ────────────────────────────────────────────────
    const page = await request('/index.html');
    assert.equal(page.statusCode, 200);
    const csp = page.headers['content-security-policy'];
    assert.ok(csp, '정적 파일 응답에 CSP가 있어야 합니다.');
    for (const directive of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "connect-src 'self'"]) {
      assert.ok(csp.includes(directive), `CSP에 ${directive}가 있어야 합니다. (받은 값: ${csp})`);
    }
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');

    // 304(재검증)에서도 헤더가 빠지면 안 된다. 브라우저는 캐시된 본문을 그대로 쓰므로
    // 이 응답의 헤더가 곧 그 화면에 적용되는 정책이 된다.
    const revalidated = await request('/index.html', { 'If-None-Match': page.headers.etag });
    assert.equal(revalidated.statusCode, 304);
    assert.ok(revalidated.headers['content-security-policy'], '304 응답에도 CSP가 있어야 합니다.');
    assert.equal(revalidated.headers['x-content-type-options'], 'nosniff');

    const missing = await request('/no-such-file.js');
    assert.equal(missing.statusCode, 404);
    assert.ok(missing.headers['content-security-policy'], '404 응답에도 CSP가 있어야 합니다.');

    const health = await request('/healthz');
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers['x-content-type-options'], 'nosniff');

    // HSTS는 원래 요청이 https였을 때만. LAN/Electron은 http라 걸면 접속이 막힌다.
    assert.equal(page.headers['strict-transport-security'], undefined, '평문 HTTP에는 HSTS를 붙이지 않습니다.');
    const secure = await request('/index.html', { 'X-Forwarded-Proto': 'https' });
    assert.ok(secure.headers['strict-transport-security'], 'https로 들어온 요청에는 HSTS를 붙입니다.');
    console.log('보안 헤더: CSP·nosniff·Referrer-Policy가 200/304/404/healthz에 모두 붙고, HSTS는 https에서만 붙는다');

    // ── 2. Cloudflare가 알려 준 IP로 사람을 구분한다 ──────────────────
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      sockets.push(await openSocket({ 'CF-Connecting-IP': ip }));
    }
    await wait(200);
    assert.equal(sockets.filter((ws) => ws.readyState === WebSocket.OPEN).length, 3,
      '서로 다른 클라이언트 IP는 각자 정원을 쓰므로 캡이 2여도 3개가 모두 살아 있어야 합니다.');

    // 같은 IP 3개 - 3번째는 1013으로 끊긴다.
    const same = [];
    for (let i = 0; i < 3; i += 1) same.push(await openSocket({ 'CF-Connecting-IP': '198.51.100.7' }));
    sockets.push(...same);
    await wait(200);
    assert.equal(same.filter((ws) => ws.readyState === WebSocket.OPEN).length, 2,
      '같은 IP에서는 캡(2)을 넘는 연결이 끊겨야 합니다.');

    // X-Forwarded-For만 다르게 위조해도 CF-Connecting-IP가 같으면 같은 사람으로 센다.
    const spoofed = [];
    for (let i = 0; i < 3; i += 1) {
      spoofed.push(await openSocket({ 'CF-Connecting-IP': '198.51.100.9', 'X-Forwarded-For': `10.0.0.${i}` }));
    }
    sockets.push(...spoofed);
    await wait(200);
    assert.equal(spoofed.filter((ws) => ws.readyState === WebSocket.OPEN).length, 2,
      'X-Forwarded-For를 손으로 바꿔 보내도 캡을 넘지 못해야 합니다.');

    // IP 모양이 아닌 값(로그 위조·키 폭증 시도)은 전부 한 칸('unknown')으로 몰린다.
    // 한글 등 비ASCII는 Node가 헤더 값으로 내보내는 것 자체를 막으므로, 실제로 보낼 수
    // 있는 ASCII 위조 문자열로 확인한다.
    const junk = [];
    for (let i = 0; i < 3; i += 1) {
      junk.push(await openSocket({ 'CF-Connecting-IP': `not-an-ip-${i} [JOIN] forged log line` }));
    }
    sockets.push(...junk);
    await wait(200);
    assert.equal(junk.filter((ws) => ws.readyState === WebSocket.OPEN).length, 2,
      'IP 형식이 아닌 값은 한 칸으로 몰아넣어 캡을 우회하지 못하게 해야 합니다.');
    console.log('연결 IP: CF-Connecting-IP로 사람을 구분하고, XFF 위조·형식 위반 값으로는 캡을 넘지 못한다');
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch { /* 이미 닫힘 */ } }
    await server.stop();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
