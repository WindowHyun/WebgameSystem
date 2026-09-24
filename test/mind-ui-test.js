'use strict';

/**
 * 더 마인드 화면(public/mind.html) - 실제 브라우저로 한 판을 따라간다.
 *
 *   - 포털에 채널이 있고 누르면 입장한다
 *   - 시작하면 집중 단계: 모두 "집중 완료"를 누르기 전에는 카드 내기 버튼이 없다
 *   - 카드 내기 버튼에 내 가장 작은 카드가 적혀 있고, 내면 가운데 더미에 올라간다
 *   - 카드 내기를 두 번 눌러도 한 장만 나간다(두 번째는 대개 실수가 된다)
 *   - 수리검: 다른 사람에게 투표 창이 뜨고, 모두 동의하면 각자 가장 작은 카드가 버려진다
 *   - 실수하면 무엇이 버려졌는지 크게 보인다
 *   - 보스 키로 누가 화면을 가리면 모두 멈춘다(집중 단계). 폰은 가린 그림을 한 번 눌러 돌아온다
 *   - 폰(375px)에서 가로로 넘치지 않고 카드 내기 버튼이 화면 안에 있다
 *
 * 실행: node test/mind-ui-test.js
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
  const port = 4622;
  const original = console.error;
  console.error = () => {};
  const server = createGameServer({ port, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  const errors = [];
  async function enter(name, device) {
    const context = await browser.newContext(device || { viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.fill('#nickname', name);
    await page.press('#nickname', 'Enter');
    await page.click('.game-card.mind');
    await page.waitForSelector('#players .player', { timeout: 15000 });
    page.label = name;
    return page;
  }
  const phase = (p) => p.evaluate(() => document.body.dataset.phase);
  const lowest = async (p) => Number((await p.textContent('#play')).replace(/[^0-9]/g, '')) || null;
  const pileCount = (p) => p.evaluate(() => (document.getElementById('pile-top').classList.contains('empty') ? 0 : 1)
    + document.querySelectorAll('#pile-list span').length);
  const focusAll = async (pages) => {
    for (const p of pages) if (await p.isVisible('#focus') && (await p.textContent('#focus')) === '집중 완료') { await p.click('#focus'); await wait(80); }
    await wait(250);
  };

  try {
    const a = await enter('김하늘');
    check('포털의 더 마인드 채널로 입장한다', (await a.title()) === '더 마인드' && await a.isVisible('#rules'));
    const b = await enter('박서준');
    const phone = await enter('폰', { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const pages = [a, b, phone];
    for (const p of pages) { await p.click('#ready'); await wait(100); }
    await a.click('#start');
    await wait(150);
    check('시작 전에 누가 준비했는지 확인 창을 띄운다', await a.isVisible('#start-confirm') && /3명/.test(await a.textContent('#start-confirm-title')));
    await a.click('#start-go');
    await wait(400);
    check('시작하면 집중 단계다', await phase(a) === 'focus' && await a.isVisible('#focus'));
    check('모두 집중하기 전에는 카드 내기 버튼이 없다', !(await a.isVisible('#play')));
    check('레벨 1/10, 목숨 3, 수리검 1', (await a.textContent('#level')) === '1 / 10' && /목숨 3/.test(await a.textContent('#lives')) && /수리검 1/.test(await a.textContent('#stars')));
    check('내 카드 1장이 보인다', await a.locator('#hand .mind-card').count() === 1);
    await a.click('#focus');
    await wait(200);
    check('집중하면 누구를 기다리는지 알려 준다', /기다리는 중/.test(await a.textContent('#message')), await a.textContent('#message'));
    await focusAll(pages);
    check('모두 집중하면 진행 중이 되고 카드 내기 버튼이 보인다', await phase(a) === 'playing' && await a.isVisible('#play'));
    const values = [];
    for (const p of pages) values.push(await lowest(p));
    check('카드 내기 버튼에 내 가장 작은 카드가 적혀 있다', values.every((v) => v >= 1 && v <= 100), values.join(','));
    // 작은 수부터 낸다 → 레벨 2
    const order = pages.map((p, i) => [values[i], p]).sort((x, y) => x[0] - y[0]);
    await order[0][1].click('#play');
    await wait(300);
    check('낸 카드가 가운데 더미에 올라간다', (await a.textContent('#pile-top')) === String(order[0][0]));
    for (const [, p] of order.slice(1)) { await p.click('#play'); await wait(250); }
    await wait(300);
    check('모두 순서대로 내면 레벨 2로 간다', (await a.textContent('#level')) === '2 / 10' && /레벨 1 통과/.test(await a.textContent('#event')));

    // 두 번 눌러도 한 장만: 레벨 2(각자 2장)
    await focusAll(pages);
    const before = await pileCount(a);
    const hands = [];
    for (const p of pages) hands.push(await lowest(p));
    const smallest = pages[hands.indexOf(Math.min(...hands))];
    await smallest.dblclick('#play');
    await wait(400);
    check('카드 내기를 두 번 눌러도 한 장만 나간다', (await pileCount(a)) === before + 1 && await smallest.locator('#hand .mind-card').count() === 1,
      `더미 ${before} → ${await pileCount(a)}`);

    // 수리검
    await a.click('#star');
    await wait(300);
    check('수리검을 제안하면 다른 사람에게 투표 창이 뜬다', await b.isVisible('#star-vote') && await phone.isVisible('#star-vote') && !(await a.isVisible('#star-vote')));
    for (const p of [b, phone]) { await p.click('#star-yes'); await wait(150); }
    await wait(300);
    check('모두 동의하면 수리검을 쓰고 버린 카드가 보인다', /수리검 0/.test(await a.textContent('#stars')) || /레벨 3/.test(await a.textContent('#level')),
      `${await a.textContent('#stars')} ${await a.textContent('#level')}`);

    // 실수: 가장 큰 카드를 가진 사람이 먼저 낸다
    await focusAll(pages);
    if (await phase(a) === 'playing') {
      const vals = [];
      for (const p of pages) vals.push(await p.isEnabled('#play') ? await lowest(p) : -1);
      const who = pages[vals.indexOf(Math.max(...vals))];
      const livesBefore = await a.textContent('#lives');
      await who.click('#play');
      await wait(400);
      const event = await a.getAttribute('#event', 'class');
      check('실수하면 목숨이 줄고 무엇이 버려졌는지 크게 보인다', /mistake/.test(event) && (await a.textContent('#lives')) !== livesBefore,
        `${event} ${livesBefore} → ${await a.textContent('#lives')}`);
    }

    // 보스 키: 진행 중에 누가 가리면 모두 멈춘다
    await focusAll(pages);
    if (await phase(a) === 'playing') {
      await b.mouse.click(640, 300, { button: 'right' });
      await wait(400);
      check('진행 중에 누가 화면을 가리면 모두 멈춘다(집중 단계)', await phase(a) === 'focus' && /화면이 가려져/.test(await a.textContent('#message')),
        await a.textContent('#message'));
      // [모바일] 폰에는 Esc가 없다. 가린 그림을 한 번 눌러 돌아오고, 모두 다시 집중하면 이어서 진행한다.
      check('가린 사람 말고 폰 화면도 가려진다', await phone.evaluate(() => !!document.getElementById('boss-cover')));
      for (const p of [a, b]) if (await p.evaluate(() => !!document.getElementById('boss-cover'))) { await p.keyboard.press('Escape'); await wait(80); }
      await phone.touchscreen.tap(180, 300);
      await wait(700); // 푼 직후 잠깐은 손가락을 흘려보낸다(public/cover.js)
      check('폰: 가린 그림을 한 번 누르면 돌아온다', !(await phone.evaluate(() => !!document.getElementById('boss-cover'))));
      await focusAll(pages);
      check('폰이 돌아와 모두 집중하면 이어서 진행한다(폰 때문에 멈춰 있지 않다)', await phase(a) === 'playing', await a.textContent('#message'));
    } else {
      check('보스 키 검사를 위해 진행 중이어야 한다', false, await phase(a));
    }

    // 폰
    const layout = await phone.evaluate(() => {
      const play = document.getElementById('focus').offsetParent ? document.getElementById('focus') : document.getElementById('play');
      const box = play.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, buttonInView: box.bottom <= innerHeight + 1 && box.top >= 0 };
    });
    check('폰: 가로로 넘치지 않는다', !layout.overflow);
    check('폰: 조작 버튼이 화면 안에 보인다(아래에 붙어 있다)', layout.buttonInView, JSON.stringify(layout));
    check('브라우저 오류·CSP 위반 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
    console.error = original;
  }
  console.log(`\n더 마인드 화면: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
