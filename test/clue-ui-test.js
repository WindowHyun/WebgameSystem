'use strict';

/**
 * 클루 화면을 실제 브라우저로 본다(public/clue.html·clue.js). 규칙 계산은 clue-room-test.js·clue-server-test.js가 보고,
 * 여기서는 "사람이 화면에서 놓치기 쉬운 것"을 본다. 모두 실제로 겪은 문제다.
 *
 *   - 카드를 보여 줄 차례에 고르는 패널이 지도 위(안내 배너 바로 아래)에 떠서 폰 화면 안에 보인다.
 *     (예전에는 지도 아래라 스크롤해 내려가야 했고, 45초 안에 못 고르면 서버가 첫 카드를 대신 보여 줬다)
 *   - 주사위를 굴린 뒤에는 눌리지 않는 "이미 굴렸습니다" 버튼이 없고, 배너에 나온 눈이 적힌다.
 *   - 추측·고발 알림은 작고, 닫기(✕) 버튼이 있고, 동시에 2개까지만 쌓인다.
 *   - 폰 화면에서 가로로 넘치지 않고, 참가자 칸의 말·카드 수가 잘리지 않고 줄바꿈된다.
 *   - 브라우저 오류(favicon 404 포함)가 없다.
 *
 * 실행: node test/clue-ui-test.js (Playwright 필요)
 */

const { chromium, devices } = require('playwright');
const { createGameServer } = require('../web/game-server');

const PORT = 4757;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

async function enter(browser, nickname, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.fill('#nickname', nickname);
  await page.press('#nickname', 'Enter');
  await page.click('.game-card.clue');
  await page.waitForSelector('#players .player', { timeout: 15000 });
  page.errors = errors;
  return page;
}

const stateOf = (page) => page.evaluate(() => {
  const hidden = (id) => document.getElementById(id).classList.contains('hidden');
  const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
  return {
    phase: document.getElementById('phase').textContent,
    mine: document.getElementById('turn-banner').classList.contains('mine'),
    banner: document.getElementById('turn-banner').textContent,
    rollVisible: !hidden('roll'),
    rollLabel: document.getElementById('roll').textContent,
    stayVisible: !hidden('stay'),
    endVisible: !hidden('end'),
    suggestFormVisible: !hidden('suggest-form'),
    accuseVisible: !hidden('accuse'),
    disproveVisible: !hidden('disprove'),
    disprove: rect('disprove'),
    map: rect('map'),
    seenOpen: !document.getElementById('seen-popup').classList.contains('hidden'),
    reachRooms: [...document.querySelectorAll('.reach-room')].map((e) => e.dataset.room),
    reachCells: document.querySelectorAll('.reach-cell').length,
    innerHeight: window.innerHeight,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  };
});

(async () => {
  const server = createGameServer({ port: PORT, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  const phone = { ...devices['iPhone 13 Pro'], locale: 'ko-KR' };
  const pages = [];
  try {
    console.log('\n=== 입장과 시작 ===');
    const a = await enter(browser, '김하늘', phone);
    const b = await enter(browser, '박서준', phone);
    const c = await enter(browser, '이도현', { viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
    pages.push(a, b, c);
    check('말 고르기 칸이 6개 보인다', (await a.locator('.pick-chip').count()) === 6);
    await a.click('.pick-chip[data-key="scarlett"]');
    await b.waitForFunction(() => document.querySelector('.pick-chip[data-key="scarlett"]').disabled);
    check('남이 고른 말은 다른 사람 화면에서 눌리지 않는다', await b.isDisabled('.pick-chip[data-key="scarlett"]'));
    for (const p of pages) await p.click('#ready');
    await a.waitForFunction(() => !document.getElementById('start').disabled);
    await a.click('#start');
    await a.click('#start-go');
    for (const p of pages) await p.waitForSelector('#game-view:not(.hidden)');
    check('시작하면 지도가 보인다', await a.isVisible('#map'));
    const players = await a.evaluate(() => [...document.querySelectorAll('#players .player small')].map((s) => ({ white: getComputedStyle(s).whiteSpace, clipped: s.scrollWidth > s.clientWidth + 1 })));
    check('폰에서 참가자 칸의 말·카드 수가 줄바꿈되고 잘리지 않는다', players.length === 3 && players.every((p) => p.white === 'normal' && !p.clipped), JSON.stringify(players));

    console.log('\n=== 한 판 돌려 보기 ===');
    let sawRollAfter = false;
    let sawDisprove = false;
    let sawToast = false;
    let toastDetail = null;
    let disproveDetail = null;
    let rollDetail = null;
    for (let i = 0; i < 600 && !(sawRollAfter && sawDisprove && sawToast); i += 1) {
      await wait(200);
      const S = await Promise.all(pages.map(stateOf));
      for (let n = 0; n < 3; n += 1) if (S[n].seenOpen) await pages[n].click('#seen-ok').catch(() => {});
      // 카드를 보여 줄 사람
      const d = S.findIndex((s) => s.disproveVisible);
      if (d >= 0) {
        if (!sawDisprove && d < 2) { // 폰 화면(앞의 두 명)에서 보는 장면이 중요하다. PC는 그냥 눌러 넘긴다
          sawDisprove = true;
          const s = S[d];
          disproveDetail = { who: d, top: Math.round(s.disprove.top), bottom: Math.round(s.disprove.bottom), mapTop: Math.round(s.map.top), vh: s.innerHeight };
          check('카드를 보여 줄 차례면 선택 패널이 화면 안에 통째로 보인다(스크롤 없이)',
            s.disprove.top >= 0 && s.disprove.bottom <= s.innerHeight, JSON.stringify(disproveDetail));
          check('선택 패널은 지도 위에 있다', s.disprove.bottom <= s.map.top + 1, JSON.stringify(disproveDetail));
        }
        await pages[d].click('#disprove .pick-card', { timeout: 3000 }).catch(() => {});
        await wait(500);
        const toasts = await Promise.all(pages.map((p) => p.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => ({ h: Math.round(t.getBoundingClientRect().height), close: !!t.querySelector('.toast-close'), padRight: parseFloat(getComputedStyle(t).paddingRight) })))));
        const withToast = toasts.findIndex((t) => t.length > 0);
        if (withToast >= 0 && !sawToast) {
          sawToast = true;
          toastDetail = { who: withToast, toasts: toasts[withToast] };
          check('추측 알림에는 닫기(✕) 버튼이 있다', toasts[withToast].every((t) => t.close), JSON.stringify(toastDetail));
          check('추측 알림은 작다(폰 화면 높이의 1/4 이하)', toasts[withToast].every((t) => t.h <= 844 / 4), JSON.stringify(toastDetail));
          check('알림 오른쪽에 ✕ 자리(34px 이상)가 비어 있어 긴 닉네임 제목이 버튼 밑에 깔리지 않는다', toasts[withToast].every((t) => t.padRight >= 34), JSON.stringify(toastDetail));
          check('알림은 동시에 2개까지만 쌓인다', toasts.every((t) => t.length <= 2));
          await pages[withToast].click('#toasts .toast-close');
          check('✕를 누르면 알림이 닫힌다', (await pages[withToast].locator('#toasts .toast').count()) < toasts[withToast].length);
        }
        continue;
      }
      const m = S.findIndex((s) => s.mine);
      if (m < 0) continue;
      const s = S[m];
      const p = pages[m];
      try {
        if (s.rollVisible) {
          await p.click('#roll', { timeout: 2000 });
          await wait(500);
          const after = await stateOf(p);
          if (!sawRollAfter && !after.rollVisible) {
            sawRollAfter = true;
            rollDetail = { label: after.rollLabel, banner: after.banner };
            check('굴린 뒤에는 눌리지 않는 "이미 굴렸습니다" 버튼이 남지 않는다', !after.rollVisible && !/이미 굴렸/.test(after.rollLabel), JSON.stringify(rollDetail));
            check('굴린 뒤 배너에 나온 눈이 적힌다(예: 🎲 3+4=7)', /🎲 \d\+\d=\d+/.test(after.banner), after.banner);
          }
          continue;
        }
        if (s.suggestFormVisible) { await p.click('#suggest-go', { timeout: 2000 }); await wait(500); continue; }
        if (s.reachRooms.length || s.reachCells) {
          const target = s.reachRooms.filter((r) => r !== 'envelope').length ? '.reach-room:not([data-room="envelope"])' : (s.reachRooms.length ? '.reach-room' : '.reach-cell');
          await p.locator(target).first().click({ force: true, timeout: 2000 });
          await wait(400);
          continue;
        }
        if (s.endVisible) { await p.click('#end', { timeout: 2000 }); await wait(300); continue; }
        if (s.stayVisible) { await p.click('#stay', { timeout: 2000 }); await wait(300); }
      } catch (e) { /* 그 사이 상태가 바뀜 - 다음 바퀴에서 다시 본다 */ }
    }
    check('굴린 직후 화면을 확인했다', sawRollAfter, JSON.stringify(rollDetail));
    check('카드를 보여 주는 장면을 확인했다', sawDisprove, JSON.stringify(disproveDetail));
    check('추측 알림을 확인했다', sawToast, JSON.stringify(toastDetail));

    console.log('\n=== 폰 화면과 브라우저 오류 ===');
    for (const [label, p] of [['폰 1', a], ['폰 2', b]]) {
      const s = await stateOf(p);
      check(`${label}: 가로로 넘치지 않는다`, s.overflowX <= 1, `넘침 ${s.overflowX}px`);
    }
    for (const [label, p] of [['폰 1', a], ['폰 2', b], ['PC', c]]) {
      check(`${label}: 브라우저 오류·CSP 위반·404 없음`, p.errors.length === 0, p.errors.join(' | ').slice(0, 200));
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  console.log(`\n클루 화면: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
