'use strict';

/**
 * [요청] 두 가지.
 *
 *   1. 게임 시작을 누르면 바로 시작하지 않고, 준비 안 한 사람을 보여 주는 확인 창이 뜬다.
 *      예전에는 누르는 즉시 준비한 사람끼리 판이 시작되어 준비를 깜빡한 사람이 모른 채
 *      빠졌다. 창에서 "시작하기"를 눌러야 시작하고, "취소"하면 아무 일도 없다.
 *   2. 판이 끝나 대기 중일 때 참가자 목록에는 다음 판 준비 여부(준비/대기)가 보인다.
 *      예전에는 지난 판의 폴드·스탠드·21 초과가 그대로 남아 누가 준비했는지 알 수 없었다.
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

async function enter(browser, port, game, nickname) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#nickname', nickname);
  await page.press('#nickname', 'Enter');
  await page.click(`.game-card.${game}`);
  await page.waitForSelector('#players .player', { timeout: 15000 });
  page.errors = errors;
  return page;
}

const statuses = (page) => page.evaluate(() => [...document.querySelectorAll('#players .player')]
  .map((el) => el.querySelector('b').textContent.replace(' (나)', '') + '=' + el.querySelector('.status').textContent));

async function runGame(browser, port, game) {
  console.log(`\n=== ${game} ===`);
  const [a, b, c] = [await enter(browser, port, game, '갑'), await enter(browser, port, game, '을'), await enter(browser, port, game, '병')];
  await wait(400);
  // 을은 준비를 깜빡했다.
  for (const p of [a, c]) { await p.click('#ready'); await wait(150); }
  await wait(300);

  await c.click('#start');
  await wait(300);
  check(`${game}: 시작을 눌러도 바로 시작하지 않고 확인 창이 뜬다`,
    await c.isVisible('#start-confirm') && (await a.textContent('#phase')).includes('대기'));
  const text = await c.textContent('#start-confirm');
  check(`${game}: 확인 창에 준비 안 한 사람이 나온다`, text.includes('준비 안 함: 을'), text);
  check(`${game}: 몇 명으로 시작하는지 나온다`, text.includes('준비한 2명으로 시작할까요?'), text);

  await c.click('#start-cancel');
  await wait(300);
  check(`${game}: 취소하면 창이 닫히고 판은 시작되지 않는다`,
    !(await c.isVisible('#start-confirm')) && (await a.textContent('#phase')).includes('대기'));

  // 창을 열어 둔 채로 을이 준비하면 목록이 바로 바뀐다.
  await c.click('#start');
  await wait(200);
  await b.click('#ready');
  await wait(400);
  const updated = await c.textContent('#start-confirm');
  check(`${game}: 창이 열린 동안 준비가 바뀌면 목록도 바뀐다`,
    updated.includes('모두 준비했습니다') && updated.includes('3명'), updated);

  await c.click('#start-go');
  await wait(700);
  check(`${game}: "시작하기"를 누르면 판이 시작된다`, !(await a.textContent('#phase')).includes('대기'),
    await a.textContent('#phase'));

  // 판을 끝낸다. 블랙잭은 카드를 고른 뒤 배팅, 포커는 곧바로 배팅.
  const pages = [a, b, c];
  for (let guard = 0; guard < 12; guard += 1) {
    const phase = await a.evaluate(() => document.body.dataset.phase);
    if (phase === 'result' || phase === 'lobby') break;
    for (const p of pages) {
      if (phase === 'playing' && await p.isVisible('#stand') && await p.isEnabled('#stand')) { await p.click('#stand'); await wait(250); }
      if (phase === 'betting' && await p.isVisible('#fold') && await p.isEnabled('#fold')) { await p.click('#fold'); await wait(250); }
    }
  }
  await wait(400);
  const after = await statuses(a);
  check(`${game}: 판이 끝난 뒤에는 지난 판의 폴드·스탠드가 아니라 준비 여부가 보인다`,
    after.every((s) => /=(준비|대기)$/.test(s)) && after.length === 3, after.join(', '));

  await b.click('#ready');
  await wait(400);
  const readied = await statuses(a);
  check(`${game}: 다음 판에 준비한 사람은 "준비"로 바뀐다`, readied.includes('을=준비'), readied.join(', '));

  const errors = pages.flatMap((p) => p.errors);
  check(`${game}: 브라우저 오류 없음`, errors.length === 0, errors.join(' | '));
  for (const p of pages) await p.context().close();
}

(async () => {
  const browser = await chromium.launch();
  let port = 4560;
  try {
    for (const game of ['poker', 'blackjack']) {
      const server = createGameServer({ port: (port += 1), host: '127.0.0.1' });
      await server.start();
      try { await runGame(browser, port, game); } finally { await server.stop(); }
    }
  } finally {
    await browser.close();
  }
  console.log(`\n시작 확인 창·대기 상태: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
