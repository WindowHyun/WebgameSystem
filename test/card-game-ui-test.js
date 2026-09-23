'use strict';
const { chromium } = require('playwright');
const { createGameServer } = require('/home/user/WebgameSystem/web/game-server');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name} ${extra || ''}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPlayer(browser, port, game, name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#nickname', name);
  await page.press('#nickname', 'Enter');
  await page.click(`.game-card.${game}`);
  await page.waitForSelector('#players .player', { timeout: 10000 });
  return { ctx, page, errors };
}

(async () => {
  const port = 4411;
  const server = createGameServer({ port, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  try {
    console.log('\n=== 1. 방장 독점 해제 (포커 3명) ===');
    const a = await newPlayer(browser, port, 'poker', '첫째');
    const b = await newPlayer(browser, port, 'poker', '둘째');
    const c = await newPlayer(browser, port, 'poker', '셋째');
    await wait(400);
    const seen = (await a.page.$$('#players .player')).length;
    ok('3명 모두 화면에 보인다', seen === 3, `(실제 ${seen}명)`);

    for (const p of [a, b, c]) { await p.page.click('#ready'); await wait(150); }
    await wait(400);

    const hintBefore = await c.page.textContent('#message');
    ok('시작 조건이 화면 문구로 설명된다', /시작할 수 있습니다/.test(hintBefore), `("${hintBefore}")`);

    ok('방장이 아닌 셋째의 시작 버튼이 활성화돼 있다', !(await c.page.isDisabled('#start')));
    await c.page.click('#start');
    await c.page.click('#start-go'); // 시작 확인 창
    await wait(700);
    const phase = await a.page.textContent('#phase');
    ok('방장이 아닌 사람이 라운드를 시작했다', phase.includes('배팅'), `(phase="${phase}")`);
    const cMsg = await c.page.textContent('#message');
    ok('셋째도 이번 판 참가자다', cMsg.includes('배팅 차례'), `("${cMsg}")`);

    console.log('\n=== 2. 같은 기기 두 탭 토큰 충돌 ===');
    const shared = await browser.newContext();
    const t1 = await shared.newPage();
    await t1.goto(`http://127.0.0.1:${port}/`);
    await t1.fill('#nickname', '탭하나'); await t1.press('#nickname', 'Enter');
    await t1.click('.game-card.blackjack');
    await t1.waitForSelector('#players .player');
    await wait(400);
    const t2 = await shared.newPage();
    await t2.goto(`http://127.0.0.1:${port}/`);
    await t2.fill('#nickname', '탭둘'); await t2.press('#nickname', 'Enter');
    await t2.click('.game-card.blackjack');
    await t2.waitForSelector('#players .player');
    await wait(900);
    ok('첫 번째 탭이 밀려나지 않았다 (#fatal 없음)', (await t1.$('#fatal')) === null);
    const twoSeen = (await t1.$$('#players .player')).length;
    ok('두 탭이 서로 다른 참가자로 보인다', twoSeen === 2, `(${twoSeen}명)`);

    console.log('\n=== 3. 밀려났을 때 복구 UI ===');
    const tokenT1 = await t1.evaluate(() => sessionStorage.getItem('blackjack-game-token'));
    const t3 = await shared.newPage();
    await t3.goto(`http://127.0.0.1:${port}/`);
    await t3.evaluate((tok) => {
      sessionStorage.setItem('game-portal-nickname', '탭복제');
      sessionStorage.setItem('blackjack-game-token', tok);
    }, tokenT1);
    await t3.goto(`http://127.0.0.1:${port}/blackjack.html`);
    await wait(1500);
    ok('밀려난 탭에 사라지지 않는 안내가 뜬다', (await t1.$('#fatal')) !== null);
    const fatalText = (await t1.$('#fatal')) ? await t1.textContent('#fatal') : '';
    ok('안내에 다시 접속 버튼이 있다', fatalText.includes('이 창에서 다시 접속'), `("${fatalText}")`);
    ok('안내에 목록으로 버튼이 있다', fatalText.includes('목록으로'));

    console.log('\n=== 4. CSP / 콘솔 오류 ===');
    const allErrors = [...a.errors, ...b.errors, ...c.errors];
    const csp = allErrors.filter((e) => /Content Security Policy|CSP/i.test(e));
    ok('CSP 위반 없음', csp.length === 0, csp.join(' | '));
    ok('브라우저 콘솔 오류 없음', allErrors.length === 0, allErrors.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
  }
  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('오류:', e); process.exit(1); });
