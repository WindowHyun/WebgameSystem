'use strict';

const assert = require('assert');
const http = require('http');
const { createGameServer } = require('../web/game-server');

const PORT = 4197;

function request(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: PORT, path, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

(async () => {
  const server = createGameServer({ port: PORT });
  await server.start();
  try {
    const health = await request('/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body.toString()), { ok: true });

    const first = await request('/poker.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-encoding'], 'gzip');
    assert.match(first.headers['cache-control'], /max-age=300/);
    assert.ok(first.headers.etag);

    const cached = await request('/poker.js', { 'If-None-Match': first.headers.etag });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);

    const font = await request('/lato-400.woff2');
    assert.match(font.headers['cache-control'], /immutable/);
    console.log('Render HTTP: 상태 확인·메모리 제공·gzip·브라우저 캐시 통과');
  } finally {
    await server.stop();
  }
})().catch((error) => { console.error(error); process.exit(1); });
