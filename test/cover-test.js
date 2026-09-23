'use strict';

/**
 * [요청] 보스 키 - 우클릭하면 화면 전체가 업무 화면처럼 보이는 그림으로 덮인다.
 *
 *   - 모든 페이지(포털·라이어·포커·블랙잭)에서 우클릭 한 번에 덮이고, 그림이 실제로 뜬다
 *   - 브라우저 탭 제목도 게임 이름 대신 그림에 맞는 제목으로 바뀐다
 *   - 다시 우클릭하거나 Esc를 누르면 원래 화면·제목으로 돌아온다
 *   - 가려진 동안 누른 키는 게임으로 새지 않는다
 *   - 라이어 참가자 목록 우클릭(강퇴 메뉴)은 그대로 둔다
 *   - 카드 게임 기부 창은 왼쪽 클릭으로 계속 열린다
 *   - 폰 길게 누르기로는 덮이지 않는다
 */

const { chromium, devices } = require('playwright');
const { createGameServer } = require('../web/game-server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const COVER = `(() => {
  const el = document.getElementById('boss-cover');
  if (!el) return null;
  const img = el.querySelector('img');
  const box = el.getBoundingClientRect();
  return { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0,
    full: box.width === innerWidth && box.height === innerHeight, title: document.title };
})()`;

async function enter(browser, port, game, name, options) {
  const context = await browser.newContext(options || { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#nickname', name);
  await page.press('#nickname', 'Enter');
  if (game) {
    await page.click(`.game-card.${game}`);
    // 포털에서 들어가면 라이어도 자동으로 입장한다.
    await page.waitForSelector(game === 'liar' ? '#screen-game:not(.hidden)' : '#players .player', { timeout: 15000 });
  }
  page.errors = errors;
  return page;
}

async function basic(page, label) {
  const before = await page.title();
  await page.mouse.click(700, 60, { button: 'right' });
  await wait(250);
  const shown = await page.evaluate(COVER);
  check(`${label}: 우클릭하면 화면 전체가 덮인다`, !!shown && shown.full, JSON.stringify(shown));
  check(`${label}: 그림이 실제로 뜬다`, !!shown && shown.loaded && /^cover-\d\.webp$/.test(shown.src), JSON.stringify(shown));
  check(`${label}: 탭 제목이 게임 이름이 아니다`, !!shown && shown.title !== before && /올리브영/.test(shown.title), shown && shown.title);
  await page.mouse.click(700, 60, { button: 'right' });
  await wait(200);
  check(`${label}: 다시 우클릭하면 원래 화면·제목으로 돌아온다`, !(await page.evaluate(COVER)) && (await page.title()) === before);
  await page.mouse.click(700, 60, { button: 'right' });
  await page.keyboard.press('Escape');
  await wait(200);
  check(`${label}: Esc로도 돌아온다`, !(await page.evaluate(COVER)));
}

(async () => {
  const port = 4595;
  const server = createGameServer({ port, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  try {
    console.log('\n=== 포털 ===');
    const portal = await enter(browser, port, null, '갑');
    await basic(portal, '포털');
    // 무작위: 여러 번 덮으면 두 그림이 모두 나온다(같은 그림 연속은 피한다).
    const seen = new Set();
    for (let i = 0; i < 6; i += 1) {
      await portal.mouse.click(700, 60, { button: 'right' }); await wait(80);
      seen.add((await portal.evaluate(COVER)).src);
      await portal.mouse.click(700, 60, { button: 'right' }); await wait(80);
    }
    check('그림은 무작위로 바뀐다(여러 번 덮으면 모든 그림이 나온다)', seen.size === 2, [...seen].join(', '));

    console.log('\n=== 라이어 ===');
    const liar = await enter(browser, port, 'liar', '갑');
    const other = await enter(browser, port, 'liar', '을');
    await liar.waitForFunction(() => document.querySelectorAll('#participant-list [data-player-id]').length === 2);
    await wait(400);
    await basic(liar, '라이어');
    // 입력하던 글자가 가려진 동안 게임으로 새지 않는다.
    await liar.click('#chat-input');
    await liar.mouse.click(700, 400, { button: 'right' });
    await liar.keyboard.type('비밀');
    await liar.keyboard.press('Enter');
    await liar.keyboard.press('Escape');
    await wait(300);
    const typed = await liar.inputValue('#chat-input');
    const chat = await other.textContent('#chat-messages');
    check('라이어: 가려진 동안 친 글자는 입력창에도 대화에도 들어가지 않는다', typed === '' && !chat.includes('비밀'), `입력창 "${typed}"`);
    const profile = liar.locator('#participant-list [data-player-id]').last();
    await profile.click({ button: 'right' });
    await wait(300);
    const menu = await liar.evaluate(() => { const m = document.querySelector('#profile-menu:not(.hidden)'); return !!m && m.textContent.includes('강퇴'); });
    check('라이어: 참가자 목록 우클릭은 그대로 강퇴 메뉴를 연다(덮지 않는다)', menu && !(await liar.evaluate(COVER)));

    console.log('\n=== 포커 ===');
    const pa = await enter(browser, port, 'poker', '갑');
    const pb = await enter(browser, port, 'poker', '을');
    await wait(400);
    await basic(pa, '포커');
    await pa.locator('#players .player').last().click({ button: 'right' });
    await wait(200);
    check('포커: 참가자 줄을 우클릭해도 덮인다(기부 창보다 먼저)', !!(await pa.evaluate(COVER)) && !(await pa.isVisible('#donate')));
    await pa.keyboard.press('Escape');
    await pa.locator('#players .player').last().click();
    await wait(200);
    check('포커: 기부 창은 왼쪽 클릭으로 계속 열린다', await pa.isVisible('#donate'));
    void pb;

    console.log('\n=== 블랙잭 ===');
    const ba = await enter(browser, port, 'blackjack', '갑');
    await basic(ba, '블랙잭');

    console.log('\n=== 폰 ===');
    const phone = await enter(browser, port, 'poker', '병', devices['iPhone 13 Pro']);
    await phone.locator('#table').dispatchEvent('pointerdown', { pointerType: 'touch' });
    await phone.locator('#table').dispatchEvent('contextmenu');
    await wait(200);
    check('폰: 길게 누르기(터치에서 온 우클릭)로는 덮이지 않는다', !(await phone.evaluate(COVER)));

    const errors = [portal, liar, other, pa, pb, ba, phone].flatMap((p) => p.errors);
    check('브라우저 오류·CSP 위반 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
  }
  console.log(`\n보스 키: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
