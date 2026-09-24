'use strict';

/**
 * [모바일] 폰 사용자용 보조(public/mobile.js)와 라이어 시작·투표 버튼 글자 - 실제 브라우저로 확인한다.
 *
 *   - 게임 화면 네 곳(라이어·포커·블랙잭·더 마인드)은 화면 꺼짐 방지(wake lock)를 건다. 포털은 걸지 않는다
 *   - 다른 앱에 다녀오면(브라우저가 푼 뒤) 다시 건다
 *   - 10분 동안 아무도 만지지 않으면 풀고, 다시 만지면 건다
 *   - 실제 Chromium(가짜 없이)에서도 오류가 나지 않는다
 *   - 폰(마우스 없음)에서만 카드 게임 상단에 "?"가 붙고, 누르면 지금 보이는 버튼의 설명이 모두 나온다
 *     누를 수 없는 버튼은 그렇다고 적는다. 닫기·바깥 누르기로 닫힌다. 데스크톱에는 없다
 *   - 가장 작은 폰(320px)에서도 "?"가 상단에서 넘치거나 겹치지 않는다
 *   - 라이어: 폰에서는 시작 버튼에 "게임 시작" 글자가 보인다(데스크톱은 요청대로 아이콘만).
 *     투표 버튼 글자는 누를 수 없을 때는 숨긴다
 *
 * 실행: node test/mobile-assist-test.js
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

const phoneOf = (name) => { const { defaultBrowserType, ...rest } = devices[name]; void defaultBrowserType; return rest; };
const PHONE = phoneOf('iPhone 13');
const SMALL = phoneOf('iPhone SE');
const DESKTOP = { viewport: { width: 1280, height: 800 } };

// 브라우저의 wake lock 대신 부른 횟수를 세는 가짜. 브라우저가 푸는 것은 __wake.active.release()로 흉내 낸다.
function fakeWakeLock() {
  window.__wake = { requests: 0, releases: 0, active: null };
  const fake = {
    request(type) {
      window.__wake.requests += 1;
      const sentinel = new EventTarget();
      sentinel.type = type;
      sentinel.released = false;
      sentinel.release = () => {
        if (!sentinel.released) {
          sentinel.released = true;
          window.__wake.releases += 1;
          sentinel.dispatchEvent(new Event('release'));
        }
        return Promise.resolve();
      };
      window.__wake.active = sentinel;
      return Promise.resolve(sentinel);
    },
  };
  Object.defineProperty(Navigator.prototype, 'wakeLock', { get() { return fake; }, configurable: true });
}

(async () => {
  const port = 4631;
  const original = console.error;
  console.error = () => {};
  const server = createGameServer({ port, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  const errors = [];
  const contexts = [];

  async function enter(game, name, device, options = {}) {
    const context = await browser.newContext(device);
    contexts.push(context);
    if (!options.real) await context.addInitScript(fakeWakeLock);
    const page = await context.newPage();
    if (options.clock) await page.clock.install();
    page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.fill('#nickname', name);
    await page.press('#nickname', 'Enter');
    if (!game) return page;
    if (device.hasTouch) await page.tap(`.game-card.${game}`); else await page.click(`.game-card.${game}`);
    await page.waitForSelector(game === 'liar' ? '#screen-game:not(.hidden)' : '#players .player', { timeout: 15000 });
    await wait(300);
    return page;
  }
  const wake = (p) => p.evaluate(() => ({ ...window.__wake, active: undefined }));

  try {
    console.log('\n=== 화면 꺼짐 방지 ===');
    for (const game of ['liar', 'poker', 'blackjack', 'mind']) {
      const p = await enter(game, `폰-${game}`, PHONE);
      const w = await wake(p);
      check(`${game}: 들어가면 화면 꺼짐 방지를 건다`, w.requests === 1, JSON.stringify(w));
      if (game === 'poker') {
        await p.evaluate(() => window.__wake.active.release()); // 다른 앱으로 가서 브라우저가 풀었다
        await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // 돌아왔다
        await wait(100);
        check('poker: 다른 앱에 다녀오면 다시 건다', (await wake(p)).requests === 2, JSON.stringify(await wake(p)));
        await p.tap('#ready');
        await wait(100);
        check('poker: 걸려 있을 때 화면을 만져도 겹쳐 걸지 않는다', (await wake(p)).requests === 2, JSON.stringify(await wake(p)));
      }
    }
    const portal = await enter(null, '폰-포털', PHONE);
    check('포털은 걸지 않는다(게임 화면만)', (await wake(portal)).requests === 0);

    const idle = await enter('mind', '폰-방치', PHONE, { clock: true });
    const before = await wake(idle);
    await idle.clock.fastForward('10:30');
    await wait(100);
    const after = await wake(idle);
    check('10분 동안 아무도 만지지 않으면 풀어서 평소처럼 꺼지게 둔다', after.releases === before.releases + 1 && after.requests === before.requests,
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    await idle.touchscreen.tap(10, 300);
    await wait(100);
    check('다시 만지면 건다', (await wake(idle)).requests === before.requests + 1, JSON.stringify(await wake(idle)));

    const real = await enter('poker', '폰-진짜', PHONE, { real: true });
    await real.tap('#ready');
    await wait(300);
    check('실제 Chromium에서도 오류가 나지 않는다', !errors.some((e) => e.startsWith('폰-진짜')), errors.join(' | '));

    console.log('\n=== 버튼 설명 보기 ===');
    const desk = await enter('poker', '데스크톱', DESKTOP);
    check('데스크톱에는 "?"가 없다(마우스를 올려 본다)', (await desk.locator('#help-open').count()) === 0);
    const phone = await enter('poker', '폰', PHONE);
    check('폰에는 카드 게임 상단에 "?"가 붙는다', await phone.isVisible('.topbar #help-open'));
    await phone.tap('#help-open');
    await wait(150);
    const sheet = await phone.evaluate(() => [...document.querySelectorAll('#help-sheet dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));
    const byLabel = Object.fromEntries(sheet);
    check('누르면 설명 창이 뜬다', await phone.isVisible('#help-sheet'));
    check('지금 보이는 버튼과 설명이 나온다', byLabel['준비'] === '게임 참가 준비 상태를 설정하거나 취소합니다.'
      && /새 라운드를 시작/.test(byLabel['게임 시작'] || ''), JSON.stringify(sheet));
    check('숨은 버튼(배팅 단계의 콜·폴드)은 나오지 않는다', !Object.keys(byLabel).some((l) => /^(콜|폴드|올인)/.test(l)), Object.keys(byLabel).join(', '));
    await phone.tap('#help-sheet button.secondary');
    // 로비에는 잠긴 버튼이 없어서, 시작 버튼을 잠근 상태를 만들어 본다(차례가 아닐 때의 배팅 버튼과 같다).
    await phone.evaluate(() => { document.getElementById('start').disabled = true; });
    await phone.tap('#help-open');
    await wait(100);
    const locked = await phone.evaluate(() => [...document.querySelectorAll('#help-sheet dt')].map((dt) => dt.textContent));
    check('누를 수 없는 버튼은 그렇다고 적는다', locked.includes('게임 시작 (지금은 누를 수 없음)') && locked.includes('준비'), locked.join(', '));
    await phone.evaluate(() => { document.getElementById('start').disabled = false; });
    await phone.tap('#help-sheet button.secondary');
    await wait(100);
    check('닫기를 누르면 닫힌다', !(await phone.isVisible('#help-sheet')));
    await phone.tap('#help-open');
    await wait(100);
    await phone.touchscreen.tap(8, 8);
    await wait(100);
    check('바깥을 누르면 닫힌다', !(await phone.isVisible('#help-sheet')));

    const blackjack = await enter('blackjack', '폰-블랙잭', PHONE);
    check('블랙잭에도 "?"가 붙는다', await blackjack.isVisible('.topbar #help-open'));
    const liarPhone = await enter('liar', '폰-라이어', PHONE);
    check('라이어에는 "?"를 붙이지 않는다(설명 달린 버튼이 없다)', (await liarPhone.locator('#help-open').count()) === 0);

    // 더 마인드 진행 중: 가장 중요한 "카드 내기" 설명이 나온다
    const md = await enter('mind', '데스크톱-마인드', DESKTOP);
    const mp = await enter('mind', '폰-마인드', PHONE);
    await md.click('#ready'); await wait(100); await mp.tap('#ready'); await wait(150);
    await md.click('#start'); await wait(150); await md.click('#start-go'); await wait(400);
    await md.click('#focus'); await mp.tap('#focus'); await wait(400);
    await mp.tap('#help-open');
    await wait(150);
    const mindSheet = await mp.evaluate(() => [...document.querySelectorAll('#help-sheet dt')].map((dt) => dt.textContent + ': ' + dt.nextElementSibling.textContent).join(' / '));
    check('더 마인드 진행 중: 카드 내기·수리검·잠깐 멈춤 설명이 나온다', /카드 내기/.test(mindSheet) && /수리검/.test(mindSheet) && /잠깐 멈춤/.test(mindSheet), mindSheet);
    await mp.tap('#help-sheet button.secondary');

    for (const game of ['poker', 'blackjack', 'mind']) {
      const small = await enter(game, `작은폰-${game}`, SMALL);
      const box = await small.evaluate(() => {
        const bar = document.querySelector('.topbar').getBoundingClientRect();
        const help = document.getElementById('help-open').getBoundingClientRect();
        const others = [...document.querySelectorAll('.topbar > *')].filter((el) => el.id !== 'help-open' && el.getClientRects().length)
          .map((el) => el.getBoundingClientRect());
        return { overflow: document.documentElement.scrollWidth > innerWidth + 1, inside: help.right <= bar.right + 1 && help.left >= bar.left,
          overlap: others.some((r) => r.right > help.left + 1 && r.left < help.right - 1), size: `${help.width}x${help.height}` };
      });
      check(`${game} 320px: "?"가 넘치거나 다른 것과 겹치지 않고 누르기 충분하다(44px)`, !box.overflow && box.inside && !box.overlap && box.size === '44x44', JSON.stringify(box));
    }

    console.log('\n=== 라이어 시작·투표 버튼 글자 ===');
    const startText = await liarPhone.innerText('#start-btn');
    check('폰: 시작 버튼에 "게임 시작" 글자가 보인다', startText.trim() === '게임 시작', JSON.stringify(startText));
    check('폰: 누를 수 없는 투표 버튼에는 글자를 붙이지 않는다', (await liarPhone.innerText('#vote-btn')).trim() === '🎧', await liarPhone.innerText('#vote-btn'));
    const liarDesk = await enter('liar', '데스크톱-라이어', DESKTOP);
    check('데스크톱: 시작 버튼은 요청대로 아이콘만 있다', (await liarDesk.innerText('#start-btn')).trim() === '');
    const liarSmall = await enter('liar', '작은폰-라이어', SMALL);
    const bar = await liarSmall.evaluate(() => {
      const start = document.getElementById('start-btn').getBoundingClientRect();
      const title = document.querySelector('#topbar h2').getBoundingClientRect();
      const actions = document.getElementById('topbar-actions').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, inView: start.right <= innerWidth,
        overlap: title.right > actions.left + 1, title: Math.round(title.width) };
    });
    check('320px: 글자를 붙여도 상단이 넘치거나 제목과 겹치지 않는다', !bar.overflow && bar.inView && !bar.overlap, JSON.stringify(bar));

    check('브라우저 오류·CSP 위반 없음', errors.length === 0, errors.join(' | '));
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
    await server.stop();
    console.error = original;
  }
  console.log(`\n폰 보조 기능: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
