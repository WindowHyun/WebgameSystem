'use strict';

/**
 * [이슈] 브라우저에서 보는 세 가지.
 *
 *   1. ← 나가기를 눌렀다 다시 들어와도 칩이 그대로다. 예전에는 화면이 나갈 때 토큰을
 *      지워서, 서버가 보관해 둔 칩을 되찾지 못하고 100만 원으로 되살아났다.
 *   2. 작은 폰(폭 320px, 375px)에서 다섯 명이어도 참가자 칸이 읽힌다. 예전에는 칸이 70px
 *      남짓으로 쪼개져 이름은 한 글자, 칩은 "99....", 상태 배지는 "차/례"처럼 세로로 쪼개졌다.
 *   3. 블랙잭 폰 화면에서 손패 카드가 가려지지 않는다. 예전에는 6장이면 2장이 통째로 덮였다.
 *
 * 실행: node test/phone-and-leave-test.js
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

const PHONE_SE = { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE_375 = { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

(async () => {
  const port = 4617;
  const original = console.error;
  console.error = () => {};
  const server = createGameServer({ port, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  const errors = [];
  async function enter(game, name, device) {
    const context = await browser.newContext(device || { viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.fill('#nickname', name);
    await page.press('#nickname', 'Enter');
    await page.click(`.game-card.${game}`);
    await page.waitForSelector('#players .player', { timeout: 15000 });
    return page;
  }
  const myChips = (page) => page.evaluate(() => {
    const mine = [...document.querySelectorAll('#players .player')].find((el) => el.querySelector('b').textContent.includes('(나)'));
    return mine ? mine.querySelector('small').textContent : null;
  });
  const turnPage = async (pages, button) => { for (const p of pages) if (await p.isVisible(button) && await p.isEnabled(button)) return p; return null; };

  try {
    // ───────────── 1. 나가기 ─────────────
    console.log('\n=== 1. ← 나가기 후 돌아오면 ===');
    const pa = await enter('poker', '갑');
    const pb = await enter('poker', '을');
    for (let hand = 0; hand < 8; hand += 1) {
      for (const p of [pa, pb]) { await p.click('#ready'); await wait(120); }
      await pa.click('#start'); await pa.click('#start-go'); await wait(400);
      // 10만 원을 걸어 차이가 화면(짧은 금액 "90만" 등)에 드러나게 한다. 100원 차이는 둘 다 "100만"이다.
      const first = await turnPage([pa, pb], '#raise');
      if (first) { await first.fill('#raise-amount', '100000'); await first.click('#raise'); await wait(250); }
      for (let i = 0; i < 6; i += 1) {
        const t = await turnPage([pa, pb], '#call');
        if (!t) break;
        await t.click('#call'); await wait(250);
      }
      if (await myChips(pa) !== await myChips(pb)) break;
    }
    const chipsA = await myChips(pa); const chipsB = await myChips(pb);
    const toWon = (text) => { const n = parseFloat(String(text)); return /만/.test(text) ? n * 10000 : n; };
    const loser = toWon(chipsA) < toWon(chipsB) ? pa : pb;
    const before = await myChips(loser);
    check('한 판을 치러 칩이 달라졌다', chipsA !== chipsB, `${chipsA} / ${chipsB}`);
    await loser.click('#leave');
    await loser.waitForURL(`http://127.0.0.1:${port}/`);
    await loser.click('.game-card.poker');
    await loser.waitForSelector('#players .player');
    await wait(400);
    check('[제보] 나갔다 다시 들어와도 칩이 그대로다(100만 원으로 되살아나지 않는다)', await myChips(loser) === before, `${before} → ${await myChips(loser)}`);

    // ───────────── 2·3. 폰 ─────────────
    console.log('\n=== 2·3. 작은 폰에서 다섯 명 ===');
    const names = ['김하늘', '박서준아주긴닉네임입니다', '이도현', '최', '폰'];
    const bj = [];
    for (let i = 0; i < 4; i += 1) bj.push(await enter('blackjack', names[i]));
    const se = await enter('blackjack', names[4], PHONE_SE);
    await wait(400);
    for (const p of bj) { await p.click('#ready'); await wait(100); }
    await bj[0].click('#start'); await bj[0].click('#start-go'); await wait(500);
    // 두 번째 사람은 히트 네 번(6장), 세 번째는 두 번(4장)
    for (let guard = 0; guard < 12; guard += 1) {
      const t = await turnPage(bj, '#hit');
      if (!t) break;
      const hits = t === bj[1] ? 4 : t === bj[2] ? 2 : 0;
      for (let h = 0; h < hits; h += 1) { await t.click('#hit'); await wait(120); }
      await t.click('#stand'); await wait(200);
    }
    for (let guard = 0; guard < 10; guard += 1) {
      const t = await turnPage(bj, '#call');
      if (!t) break;
      await t.click('#call'); await wait(200);
    }
    await wait(400);
    // 방은 다섯 명이 정원이라 폰을 하나 더 넣지 않고, 같은 폰 화면의 폭을 바꿔 가며 잰다.
    for (const [label, size] of [['폭 320px', PHONE_SE.viewport], ['폭 375px', PHONE_375.viewport]]) {
      const page = se;
      await page.setViewportSize(size);
      await wait(300);
      const roster = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('#players .player')];
        return {
          count: cells.length,
          width: innerWidth,
          cells: cells.map((el) => {
            const box = el.getBoundingClientRect();
            const status = el.querySelector('.status');
            const small = el.querySelector('small');
            return { name: el.querySelector('b').textContent, left: box.left, right: box.right, width: box.width,
              statusHeight: status && getComputedStyle(status).display !== 'none' ? status.getBoundingClientRect().height : 0,
              chipsCut: small.scrollWidth > small.clientWidth + 1, nameCut: el.querySelector('b').scrollWidth > el.querySelector('b').clientWidth + 1 };
          }),
        };
      });
      check(`${label}: 다섯 명 모두 화면 안에 보인다(옆으로 밀려나지 않는다)`, roster.count >= 5 && roster.cells.every((c) => c.left >= 0 && c.right <= roster.width),
        JSON.stringify(roster.cells.map((c) => [c.name, Math.round(c.left), Math.round(c.right)])));
      check(`${label}: 칸이 90px 이상이다`, roster.cells.every((c) => c.width >= 90), roster.cells.map((c) => Math.round(c.width)).join(','));
      check(`${label}: 상태 배지가 한 줄이다("차/례"처럼 쪼개지지 않는다)`, roster.cells.every((c) => c.statusHeight < 20), roster.cells.map((c) => Math.round(c.statusHeight)).join(','));
      check(`${label}: 칩 금액이 잘리지 않는다`, roster.cells.every((c) => !c.chipsCut));
      check(`${label}: 짧은 이름은 잘리지 않는다`, roster.cells.filter((c) => c.name.replace(' (나)', '').length <= 3).every((c) => !c.nameCut),
        roster.cells.filter((c) => c.nameCut).map((c) => c.name).join(','));

      const hands = await page.evaluate(() => [...document.querySelectorAll('#cards .hand')].map((hand) => {
        const seat = hand.closest('.seat').getBoundingClientRect();
        const cards = [...hand.querySelectorAll('.card')].map((c) => c.getBoundingClientRect());
        let minStrip = Infinity; let overlap = false;
        for (let i = 1; i < cards.length; i += 1) {
          minStrip = Math.min(minStrip, cards[i].left - cards[i - 1].left);
          if (cards[i].top === cards[i - 1].top && cards[i].left < cards[i - 1].right - 0.5) overlap = true;
        }
        return { count: cards.length, many: hand.classList.contains('many'), overlap, minStrip,
          inside: cards.every((c) => c.left >= seat.left - 0.5 && c.right <= seat.right + 0.5) };
      }));
      const big = hands.filter((h) => h.count >= 5);
      const small = hands.filter((h) => h.count >= 2 && h.count <= 4);
      check(`${label}: 5장 이상인 손패가 있다(검사 대상)`, big.length > 0, JSON.stringify(hands.map((h) => h.count)));
      check(`${label}: [제보] 5장 이상이면 카드가 서로 겹치지 않는다`, big.every((h) => h.many && !h.overlap), JSON.stringify(big));
      check(`${label}: 4장 이하는 겹쳐도 카드마다 글자가 보일 만큼(20px 이상) 드러난다`, small.every((h) => h.count < 2 || h.minStrip >= 20), JSON.stringify(small));
      check(`${label}: 카드가 자기 칸 밖으로 잘려 나가지 않는다`, hands.every((h) => h.inside), JSON.stringify(hands));
    }
    check('브라우저 오류·CSP 위반 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
    console.error = original;
  }
  console.log(`\n나가기·폰 화면: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
