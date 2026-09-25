'use strict';

/**
 * 공통 연결 관리(public/game-socket.js) - 카드 게임 세 개와 포털이 같이 쓴다.
 *
 *   - 네 화면 모두 공통 연결로 붙는다(예전 화면별 연결 코드가 남아 두 번 붙지 않는다)
 *   - 보스 키를 한 번 누르면 서버에 정확히 한 번 간다(공통 모듈과 화면이 둘 다 보내지 않는다)
 *   - 나가기(←)가 서버에 전해지고 목록으로 돌아간다. 남은 사람 화면에서도 빠진다
 *   - 참가 토큰은 게임마다 따로(탭 단위 sessionStorage) 저장된다
 *
 * 실행: node test/game-socket-test.js
 */

const { chromium } = require('playwright');
const { createGameServer } = require('../web/game-server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

(async () => {
  const port = 4641;
  const serverLog = [];
  const original = console.error;
  console.error = (...args) => { serverLog.push(args.join(' ')); };
  const server = createGameServer({ port, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  const errors = [];
  const sockets = [];

  async function enter(game, name) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    page.on('websocket', (ws) => sockets.push({ name, url: ws.url() }));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.fill('#nickname', name);
    await page.press('#nickname', 'Enter');
    if (game) {
      await page.click(`.game-card.${game}`);
      await page.waitForSelector('#players .player', { timeout: 15000 });
    }
    await wait(400);
    page.label = name;
    return page;
  }
  const coverLogs = () => serverLog.filter((line) => line.includes('[보스 키]')).length;

  try {
    const pages = {};
    for (const game of ['poker', 'blackjack', 'mind']) pages[game] = await enter(game, `${game}-갑`);
    pages.portal = await enter(null, '포털-을');

    for (const [game, page] of Object.entries(pages)) {
      const mine = sockets.filter((s) => s.name === page.label && s.url.includes(`game=${game}`));
      check(`${game}: 공통 연결로 한 번만 붙는다`, mine.length === 1 && await page.evaluate(() => typeof window.GameSocket === 'object'),
        mine.map((s) => s.url).join(', '));
    }

    for (const [game, page] of Object.entries(pages)) {
      const before = coverLogs();
      await page.mouse.click(640, 400, { button: 'right' });
      await wait(400);
      check(`${game}: 보스 키를 한 번 누르면 서버에 한 번만 간다`, coverLogs() - before === 1, `${coverLogs() - before}번`);
      for (const p of Object.values(pages)) if (await p.evaluate(() => window.bossCover.isShown())) { await p.keyboard.press('Escape'); await wait(50); }
    }

    for (const game of ['poker', 'blackjack', 'mind']) {
      const token = await pages[game].evaluate((key) => sessionStorage.getItem(key), `${game}-game-token`);
      check(`${game}: 참가 토큰이 게임별 키로 저장된다`, typeof token === 'string' && token.length >= 16, String(token));
    }

    for (const game of ['poker', 'blackjack', 'mind']) {
      const other = await enter(game, `${game}-병`);
      const seen = () => other.evaluate(() => document.querySelectorAll('#players .player').length);
      const countBefore = await seen();
      await pages[game].click('#leave');
      await pages[game].waitForURL(`http://127.0.0.1:${port}/`, { timeout: 5000 }).catch(() => {});
      await wait(400);
      check(`${game}: 나가기를 누르면 목록으로 돌아간다`, new URL(pages[game].url()).pathname === '/', pages[game].url());
      check(`${game}: 남은 사람 화면에서도 바로 빠진다(서버에 나가기가 전해졌다)`, (await seen()) === countBefore - 1, `${countBefore} → ${await seen()}`);
    }

    check('브라우저 오류 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
    console.error = original;
  }
  console.log(`\n공통 연결 관리: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
