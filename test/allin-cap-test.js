'use strict';

/**
 * [신고] 상대가 올인했을 때 내 칩이 더 적으면 폴드밖에 할 게 없다.
 *
 * 서버는 이 올인을 진작부터 받아 주고 있었다(short-stack-allin-test.js). 막고 있던 건
 * 화면이었다 - "이 판에 올인이 있었으면 올인 버튼을 끈다". 콜은 칩이 모자라 거절되고
 * 레이즈도 상한 때문에 막혀 있으니, 실제로 손에 남는 건 폴드뿐이었다.
 *
 * 서버 함수를 직접 부르는 검사로는 절대 안 잡히는 종류다. 그래서 여기서는 진짜
 * 브라우저에서 버튼을 눌러 본다. 규칙·금액 쪽은 short-stack-allin-test.js가 본다.
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

const BUTTONS = `(() => ({
  allin: document.querySelector('#allin').disabled,
  call: document.querySelector('#call').disabled,
  raise: document.querySelector('#raise').disabled,
  fold: document.querySelector('#fold').disabled,
}))()`;

async function enter(browser, port, game, nickname) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#nickname', nickname);
  await page.press('#nickname', 'Enter');
  await page.click(`.game-card.${game}`);
  await page.waitForSelector('#players .player', { timeout: 15000 });
  return page;
}

async function runGame(browser, port, game) {
  console.log(`\n=== ${game}: 상대가 올인한 뒤 내 버튼 ===`);
  const pages = [];
  for (const nickname of ['큰손', '숏스택']) pages.push(await enter(browser, port, game, nickname));
  await wait(500);
  for (const page of pages) { await page.click('#ready'); await wait(150); }
  await wait(300);
  await pages[0].click('#start');

  // 블랙잭은 카드 선택을 먼저 끝내야 배팅 단계로 간다.
  if (game === 'blackjack') {
    await pages[0].waitForSelector('body[data-phase="playing"]', { timeout: 10000 });
    for (let guard = 0; guard < 8; guard += 1) {
      // isEnabled만 보면 안 된다. 배팅 단계로 넘어가면 카드 선택 칸이 통째로 숨는데
      // 버튼의 disabled는 그대로라, 안 보이는 버튼을 누르려다 멈춘다.
      const turn = await Promise.all(pages.map(async (p) => (
        (await p.isVisible('#stand').catch(() => false))
        && (await p.isEnabled('#stand').catch(() => false)))));
      const idx = turn.indexOf(true);
      if (idx < 0) break;
      await pages[idx].click('#stand');
      await wait(400);
    }
  }
  await pages[0].waitForSelector('body[data-phase="betting"]', { timeout: 10000 });
  await wait(600);

  const firstIdx = (await pages[0].evaluate(BUTTONS)).fold ? 1 : 0;
  await pages[firstIdx].click('#allin');
  await wait(800);

  const otherIdx = 1 - firstIdx;
  const state = await pages[otherIdx].evaluate(BUTTONS);
  check(`${game}: 상대가 올인한 뒤 내 차례가 온다`, !state.fold, JSON.stringify(state));
  check(`${game}: [신고] 올인 버튼이 열려 있다 (폴드밖에 없으면 안 된다)`,
    !state.allin, JSON.stringify(state));
  check(`${game}: 레이즈는 여전히 막혀 있다 (상한이 고정됐다)`, state.raise, JSON.stringify(state));

  if (!state.allin) {
    await pages[otherIdx].click('#allin');
    await wait(900);
    const phase = await pages[otherIdx].evaluate(() => document.body.dataset.phase);
    check(`${game}: 올인이 받아들여져 판이 넘어간다`, phase !== 'betting', phase);
  }
  for (const page of pages) await page.context().close().catch(() => {});
}

async function main() {
  const browser = await chromium.launch();
  let port = 4495;
  try {
    for (const game of ['poker', 'blackjack']) {
      const server = createGameServer({ port: (port += 1), host: '127.0.0.1' });
      await server.start();
      try { await runGame(browser, port, game); } finally { await server.stop(); }
    }
  } finally {
    await browser.close();
  }
  console.log(`\n올인 버튼: ${pass}개 통과, ${fail}개 실패`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
