'use strict';

/**
 * 운영자 화면 /order를 실제 브라우저로 본다(web/game-server.js, public/order.*).
 *
 *   - 열쇠 없이 들어가면 바로 접속자·칩이 보인다.
 *   - 닉네임은 글자 그대로 나온다(태그가 해석되지 않는다).
 *   - 입금하면 확인 창 뒤에 그 사람의 칩이 늘어나고 안내가 뜬다. 좁은 폰 화면에서도 가로로 넘치지 않는다.
 *   - 화면 스크립트가 CSP에 막히거나 오류를 내지 않는다.
 *
 * 실행: node test/order-ui-test.js (Playwright 필요)
 */

const { chromium } = require('playwright');
const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

const PORT = 4733;
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const server = createGameServer({ port: PORT, host: '127.0.0.1' });
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws?game=holdem`);
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify({ type: 'join', nickname: '<b>홍길동</b>' }));
  await wait(200);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/401|status of 4\d\d/.test(m.text())) errors.push(m.text()); });
    page.on('dialog', (dialog) => dialog.accept());

    await page.goto(`http://127.0.0.1:${PORT}/order`);
    await page.waitForSelector('.game');
    check('열쇠 없이 바로 접속자 수와 게임별 목록이 보인다', (await page.textContent('#sum-online')) === '1' && (await page.locator('.game').count()) === 7);
    check('닉네임은 태그가 해석되지 않고 글자 그대로 나온다', (await page.locator('.name').first().textContent()) === '<b>홍길동</b>' && (await page.locator('.name b').count()) === 0);
    check('칩을 쓰는 게임의 참가자에게만 입금칸이 있다', (await page.locator('.deposit').count()) === 1 && /1,000,000원/.test(await page.locator('.row').first().innerText()));

    await page.fill('.deposit input', '0');
    await page.click('.deposit button');
    check('0원 입금은 보내기 전에 막는다', /1 이상의 정수/.test(await page.textContent('#notice')) && /1,000,000원/.test(await page.locator('.row').first().innerText()));

    await page.fill('.deposit input', '250000');
    await page.click('.deposit button');
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('입금했습니다'));
    check('입금하면 안내가 뜨고 그 사람의 칩이 늘어난다', /1,250,000원/.test(await page.locator('.row').first().innerText()), await page.locator('.row').first().innerText());

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('좁은 폰 화면에서도 가로로 넘치지 않는다', overflow <= 0, String(overflow));

    check('브라우저 오류·CSP 위반 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    ws.close();
    await server.stop();
  }
  console.log(`\n운영자 화면(브라우저): ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
