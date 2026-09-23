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
 *   - [요청] 한 명이 가리면 접속한 모든 사람(다른 게임·포털 포함)의 화면도 가려진다.
 *     돌아오는 것은 각자 하고, 누가 가렸는지 관리 로그에 남는다
 *   - [요청] 가려진 동안은 그 사람을 기다리는 제한시간도 멈추고, 화면의 남은 시간도 멈춰 보인다
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

// 서버 로그(관리 로그)를 엿보기 위해 붙잡는다. 화면에는 그대로 흘려보낸다.
const serverLog = [];
const originalError = console.error;
console.error = (...args) => { serverLog.push(args.join(' ')); originalError(...args); };

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

    console.log('\n=== 모두의 화면 ===');
    const fromPoker = await enter(browser, port, 'poker', '무');
    const inLiar = await enter(browser, port, 'liar', '기');
    const inBlackjack = await enter(browser, port, 'blackjack', '경');
    const onPortal = await enter(browser, port, null, '신');
    await wait(1200); // 앞선 검사들이 가린 뒤 1초 쿨다운이 지나게
    await fromPoker.mouse.click(700, 400, { button: 'right' });
    await wait(700);
    const states = await Promise.all([inLiar, inBlackjack, onPortal].map((p) => p.evaluate(COVER)));
    check('포커에서 한 명이 가리면 라이어·블랙잭·포털에 있는 사람 화면도 가려진다',
      states.every((st) => st && st.full && st.loaded), JSON.stringify(states));
    check('다른 사람 탭 제목도 쇼핑몰 제목으로 바뀐다', states.every((st) => st && /올리브영/.test(st.title)));
    await onPortal.keyboard.press('Escape');
    await wait(300);
    check('돌아오는 것은 각자 한다(한 사람이 돌아와도 남의 화면은 그대로)',
      !(await onPortal.evaluate(COVER)) && !!(await inLiar.evaluate(COVER)) && !!(await fromPoker.evaluate(COVER)));
    check('누가 가렸는지 관리 로그에 남는다',
      serverLog.some((l) => l.includes('[보스 키] 포커 무 > 모두의 화면을 가림')), serverLog.filter((l) => l.includes('보스 키')).join(' / '));
    // 연타해도 1초에 한 번만 퍼진다.
    const before = serverLog.filter((l) => l.includes('보스 키')).length;
    for (let i = 0; i < 4; i += 1) {
      await inBlackjack.mouse.click(700, 400, { button: 'right' }); await wait(60);
    }
    await wait(200);
    const spread = serverLog.filter((l) => l.includes('보스 키')).length - before;
    check('연타해도 1초에 한 번만 퍼진다', spread <= 1, `${spread}번`);

    console.log('\n=== 가려진 동안 제한시간 멈춤 ===');
    // 앞에서 가려진 화면을 모두 돌려 놓고 라이어 판을 시작한다.
    for (const p of [liar, other, inLiar]) if (await p.evaluate(COVER)) { await p.keyboard.press('Escape'); await wait(100); }
    await wait(1200); // 앞선 연타의 1초 쿨다운이 지나게
    await liar.click('#start-btn');
    await liar.waitForFunction(() => window.state && window.state.phase === 'turn' && window.state.round && window.state.round.speaker);
    const speakerId = await liar.evaluate(() => window.state.round.speaker.id);
    const liarPages = [liar, other, inLiar];
    let speakerPage = null;
    for (const p of liarPages) if (await p.evaluate((id) => window.myId === id, speakerId)) speakerPage = p;
    const watcher = liarPages.find((p) => p !== speakerPage && p !== inLiar) || other;
    const metaOf = (p) => p.evaluate(() => (document.getElementById('live-meta') || {}).textContent || '');
    await speakerPage.mouse.click(700, 400, { button: 'right' });
    await wait(500);
    const frozenA = await metaOf(watcher);
    await wait(2200);
    const frozenB = await metaOf(watcher);
    const secondsIn = (text) => Number((/남은 시간 (\d+)초/.exec(text) || [])[1]);
    check('설명 차례인 사람이 가리면 다른 사람 화면에 "멈춤"이 뜬다', frozenA.includes('화면 가림으로 멈춤'), frozenA);
    check('멈춘 동안에는 남은 시간 숫자가 줄지 않는다', secondsIn(frozenA) === secondsIn(frozenB) && secondsIn(frozenA) > 0, `${frozenA} → ${frozenB}`);
    await speakerPage.keyboard.press('Escape');
    await wait(2300);
    const running = await metaOf(watcher);
    check('돌아오면 멈춤이 풀리고 남은 시간이 다시 줄어든다',
      !running.includes('멈춤') && secondsIn(running) < secondsIn(frozenB), `${frozenB} → ${running}`);
    check('관리 로그에 멈춘 사람과 다시 흐른 것이 남는다',
      serverLog.some((l) => l.includes('[라이어]') && l.includes('> 화면 가림 - 제한시간 멈춤'))
      && serverLog.some((l) => l.includes('[라이어] 진행 > 제한시간 다시 흐름')),
      serverLog.filter((l) => l.includes('제한시간')).join(' / '));

    const errors = [portal, liar, other, pa, pb, ba, phone, fromPoker, inLiar, inBlackjack, onPortal].flatMap((p) => p.errors);
    check('브라우저 오류·CSP 위반 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
  }
  console.log(`\n보스 키: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
