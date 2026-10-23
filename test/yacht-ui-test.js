'use strict';

/**
 * 야추다이스 화면을 실제 브라우저로 본다(public/yacht.html·yacht.js).
 *
 *   - 포털에 카드가 있고 눌러 들어가면 규칙과 참가자 목록이 보인다.
 *   - 준비 → 시작 확인 창 → 굴리기 → 주사위 고정 → 칸 고르기 → 기록 → 차례 넘김이 화면 조작만으로 된다.
 *   - 내 차례가 아닌 사람은 굴리기·고정·기록을 누를 수 없고, 점수판 칸에는 내 예상 점수만 뜬다.
 *   - 12라운드를 끝까지 하면 순위가 나오고, 참가자는 자동으로 "준비"가 되어 있다.
 *   - 좁은 폰 화면(6명)에서도 가로로 넘치지 않고(점수판은 안에서 스크롤), 브라우저 오류가 없다.
 *
 * 실행: node test/yacht-ui-test.js (Playwright 필요)
 */

const { chromium } = require('playwright');
const { createGameServer } = require('../web/game-server');

const PORT = 4743;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

async function enter(browser, nickname, viewport) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.fill('#nickname', nickname);
  await page.press('#nickname', 'Enter');
  page.errors = errors;
  return page;
}
const enterGame = async (page) => { await page.click('.game-card.yacht'); await page.waitForSelector('#players .player', { timeout: 15000 }); };
const text = (page, selector) => page.textContent(selector);
const stateOf = (page) => page.evaluate(() => ({
  message: document.getElementById('message').textContent,
  round: document.getElementById('round').textContent,
  phase: document.body.dataset.phase,
  rollDisabled: document.getElementById('roll').disabled,
  scoreDisabled: document.getElementById('score').disabled,
  scoreLabel: document.getElementById('score').textContent,
  rollLabel: document.getElementById('roll').textContent,
  dice: [...document.querySelectorAll('#dice .die')].map((d) => Number(d.dataset.v)),
  held: [...document.querySelectorAll('#dice .die')].map((d) => d.classList.contains('held')),
  pickable: [...document.querySelectorAll('#sheet td.pick')].map((d) => d.dataset.key),
  turn: [...document.querySelectorAll('#players .player.turn b')].map((b) => b.textContent.replace(' (나)', '')),
}));

(async () => {
  const server = createGameServer({ port: PORT, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  const pages = [];
  try {
    console.log('\n=== 입장 ===');
    const a = await enter(browser, '김하늘');
    const b = await enter(browser, '박서준');
    pages.push(a, b);
    check('포털에 야추다이스 카드가 있다', await a.isVisible('.game-card.yacht') && /야추다이스/.test(await text(a, '.game-card.yacht')));
    await enterGame(a);
    await enterGame(b);
    check('규칙 안내와 참가자 목록이 보인다', await a.isVisible('#rules') && /최대 3번/.test(await text(a, '#rules')) && (await a.locator('#players .player').count()) === 2);
    check('아직 시작 전이라 시작은 꺼져 있고 조작부는 대기 모드다', await a.isDisabled('#start') && await a.isVisible('#lobby') && !(await a.isVisible('#turn-controls')));

    await a.click('#ready'); await b.click('#ready');
    await a.waitForFunction(() => !document.getElementById('start').disabled);
    await a.click('#start');
    await a.waitForSelector('#start-confirm:not(.hidden)');
    check('시작을 누르면 확인 창이 뜨고 준비한 2명이 나온다', /준비한 2명으로 시작할까요/.test(await text(a, '#start-confirm-title')));
    await a.click('#start-go');
    await a.waitForSelector('#game-view:not(.hidden)');
    await b.waitForSelector('#game-view:not(.hidden)');

    console.log('\n=== 한 차례 ===');
    let sa = await stateOf(a);
    let sb = await stateOf(b);
    check('시작하면 1 / 12 라운드, 김하늘 차례다(굴리기만 켜져 있다)', sa.round === '1 / 12' && sa.turn.join() === '김하늘' && !sa.rollDisabled && sa.scoreDisabled && sa.dice.every((v) => v === 0), JSON.stringify(sa));
    check('차례가 아닌 사람은 굴리기를 누를 수 없다', sb.rollDisabled && sb.scoreDisabled && /김하늘님의 차례/.test(sb.message), JSON.stringify(sb));
    check('굴리기 전에는 주사위를 눌러 고정할 수 없다', (await a.locator('#dice .die.pick').count()) === 0);

    await a.click('#roll');
    await a.waitForFunction(() => document.querySelectorAll('#dice .die:not(.empty)').length === 5);
    await b.waitForFunction(() => document.querySelectorAll('#dice .die:not(.empty)').length === 5);
    sa = await stateOf(a); sb = await stateOf(b);
    check('굴리면 두 사람 화면에 같은 주사위(1~6)가 보이고 굴림이 2번 남는다', sa.dice.every((v) => v >= 1 && v <= 6) && JSON.stringify(sa.dice) === JSON.stringify(sb.dice) && /2번 남음/.test(sa.rollLabel), JSON.stringify(sa));
    check('내 점수판에는 칸마다 예상 점수가 뜨고 상대 화면에는 뜨지 않는다', sa.pickable.length === 12 && sb.pickable.length === 0);

    await a.click('#dice .die:nth-child(1)');
    await a.click('#dice .die:nth-child(3)');
    await b.waitForFunction(() => document.querySelectorAll('#dice .die.held').length === 2);
    sb = await stateOf(b);
    check('주사위를 눌러 고정하면 상대 화면에도 고정으로 보인다', JSON.stringify(sb.held) === JSON.stringify([true, false, true, false, false]), JSON.stringify(sb.held));
    check('상대는 내 주사위를 눌러도 바뀌지 않는다', (await b.locator('#dice .die.pick').count()) === 0);

    const keep = [sa.dice[0], sa.dice[2]];
    await a.click('#roll');
    await a.waitForFunction(() => /1번 남음/.test(document.getElementById('roll').textContent));
    sa = await stateOf(a);
    check('고정한 주사위는 그대로고 굴림이 1번 남는다', sa.dice[0] === keep[0] && sa.dice[2] === keep[1]);

    await a.click('#dice .die:nth-child(1)');
    await a.waitForFunction(() => document.querySelectorAll('#dice .die.held').length === 1);
    check('다시 눌러 고정을 풀 수 있다', JSON.stringify((await stateOf(a)).held) === JSON.stringify([false, false, true, false, false]));

    await a.click('#sheet td.pick[data-key="choice"]');
    sa = await stateOf(a);
    check('칸을 누르면 고른 칸이 표시되고 기록 버튼이 "초이스에 N점 기록"이 된다', !sa.scoreDisabled && /^초이스에 \d+점 기록$/.test(sa.scoreLabel), sa.scoreLabel);
    await a.click('#score');
    await b.waitForFunction(() => !document.getElementById('roll').disabled);
    sa = await stateOf(a); sb = await stateOf(b);
    check('기록하면 점수판에 들어가고 박서준 차례가 된다', sb.turn.join() === '박서준' && sa.rollDisabled && sb.dice.every((v) => v === 0) && sa.dice.every((v) => v === 0), JSON.stringify(sb));
    check('기록한 점수가 두 화면 점수판의 합계에 같이 보인다', (await a.textContent('#sheet tfoot td')) === (await b.textContent('#sheet tfoot td')) && Number(await a.textContent('#sheet tfoot td')) > 0);

    console.log('\n=== 끝까지 ===');
    const playTurn = async (page) => {
      await page.click('#roll');
      await page.waitForFunction(() => document.querySelectorAll('#sheet td.pick').length > 0);
      const key = await page.evaluate(() => document.querySelector('#sheet td.pick').dataset.key);
      await page.click(`#sheet td.pick[data-key="${key}"]`);
      await page.click('#score');
    };
    let guard = 0;
    while (guard++ < 40) {
      const done = await a.evaluate(() => document.body.dataset.phase === 'result');
      if (done) break;
      const mine = await a.evaluate(() => !document.getElementById('roll').disabled);
      const page = mine ? a : b;
      const before = await page.evaluate(() => document.getElementById('round').textContent + '|' + document.getElementById('sheet').textContent);
      await playTurn(page);
      await page.waitForFunction((was) => document.body.dataset.phase === 'result' || (document.getElementById('round').textContent + '|' + document.getElementById('sheet').textContent) !== was, before);
      await wait(60);
    }
    await a.waitForFunction(() => document.body.dataset.phase === 'result');
    check('24번 기록하면 게임이 끝나고 결과 순위가 나온다', await a.isVisible('#result') && (await a.locator('#result li').count()) === 2 && /게임 끝!/.test(await text(a, '#result')), await text(a, '#result'));
    check('끝난 화면의 점수판은 12칸이 모두 채워져 있다', (await a.locator('#sheet tbody td:not(.cat)').evaluateAll((cells) => cells.every((c) => /^\d+$/.test(c.textContent)))));
    await a.waitForSelector('#lobby:not(.hidden)');
    const readyAfter = await a.evaluate(() => [...document.querySelectorAll('#players .player')].map((p) => p.querySelector('.status').textContent));
    check('끝나면 두 사람 모두 자동으로 "준비"가 되어 있고 바로 시작할 수 있다', readyAfter.every((s) => s === '준비') && !(await a.isDisabled('#start')) && (await text(a, '#ready')) === '준비 취소' && /자동으로 준비됩니다/.test(await text(a, '#message')), readyAfter.join());
    await a.click('#ready');
    await a.waitForFunction(() => document.getElementById('ready').textContent === '준비');
    check('준비를 취소할 수 있다', (await a.evaluate(() => [...document.querySelectorAll('#players .player')].map((p) => p.querySelector('.status').textContent))).includes('대기'));

    console.log('\n=== 폰 화면(6명) ===');
    // 앞의 두 사람은 나가고(준비가 남아 있으면 7명이 되어 시작이 막힌다) 새로 6명이 들어온다.
    for (const p of [a, b]) { await p.context().close(); pages.splice(pages.indexOf(p), 1); }
    const phones = [];
    for (const name of ['가', '나', '다', '라', '마', '바']) {
      const p = await enter(browser, name, { width: 360, height: 740 });
      pages.push(p); phones.push(p);
    }
    for (const p of phones) await enterGame(p);
    for (const p of phones) { await p.click('#ready'); await wait(80); }
    await phones[0].waitForFunction(() => !document.getElementById('start').disabled);
    await phones[0].click('#start');
    await phones[0].click('#start-go');
    await phones[0].waitForSelector('#game-view:not(.hidden)');
    await phones[0].click('#roll');
    await phones[0].waitForFunction(() => document.querySelectorAll('#sheet td.pick').length > 0);
    const overflow = await phones[0].evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      wrapFits: document.getElementById('sheet-wrap').getBoundingClientRect().right <= window.innerWidth,
      diceFit: (() => { const r = document.getElementById('dice').getBoundingClientRect(); return r.right <= window.innerWidth && r.left >= 0; })(),
    }));
    check('폰 화면에서 가로로 넘치지 않는다(점수판·주사위가 화면 안에 들어온다)', overflow.page <= 0 && overflow.wrapFits && overflow.diceFit, JSON.stringify(overflow));
    const ctl = await phones[0].evaluate(() => { const r = document.getElementById('roll').getBoundingClientRect(); return { h: r.height, inView: r.bottom <= window.innerHeight + 1 }; });
    check('굴리기 버튼은 손가락으로 누를 만큼 크고 화면 안에 있다', ctl.h >= 40 && ctl.inView, JSON.stringify(ctl));

    const errors = pages.flatMap((p) => p.errors);
    check('브라우저 오류·CSP 위반 없음', errors.length === 0, errors.join(' | '));
  } finally {
    for (const p of pages) { try { await p.context().close(); } catch { /* 이미 닫힘 */ } }
    await browser.close();
    await server.stop();
  }
  console.log(`\n야추다이스 화면: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
