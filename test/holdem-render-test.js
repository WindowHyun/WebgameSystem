'use strict';

/**
 * 홀덤 화면이 서버 상태를 어떻게 그리는지, 서버 없이 만든 상태를 먹여서 확인한다(public/holdem.js).
 * 실제 판에서는 만들기 어려운 상황(칩이 모자라 콜할 수 없음, 올인으로 상한이 정해짐, 화면 가림으로 제한시간 멈춤,
 * 비겨서 팟을 나눔, 닉네임에 섞인 HTML, 다섯 명이 작은 폰에 앉음)을 정확히 만든다.
 *
 *   - 낼 돈이 가진 칩보다 많으면 콜을 막고 이유를 말해 준다. 딱 맞으면 콜(= 올인)할 수 있다.
 *   - 레이즈 범위는 직전 레이즈 폭 ~ 칩이 남는 만큼이다. 상한이 정해지면 레이즈를 막는다.
 *   - 가려져서 멈춘 제한시간은 흐르지 않는다.
 *   - 카드를 나눈 직후(카드 확인 시간)에는 "카드를 확인하세요" 띠와 남은 시간이 보이고, 내 카드는 바로 보이며, 조작은 막혀 있다.
 *   - 비기면 모두의 몫이, 승자가 없으면 이유가 보인다.
 *   - 닉네임에 HTML이 있어도 태그로 해석되지 않는다.
 *   - 연결이 끊겨 요청을 못 보내면 알려 준다.
 *   - 다섯 명이 앉은 320px 폰에서도 가로로 넘치지 않는다.
 *
 * 실행: node test/holdem-render-test.js
 */

const { chromium, devices } = require('playwright');
const { createGameServer } = require('../web/game-server');

const PORT = 4714;
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const c = (rank, suit) => ({ rank, suit });
const HIDDEN = [{ hidden: true }, { hidden: true }];

/** 서버가 보내는 모양의 상태. 필요한 것만 덮어쓴다. */
function makeState(overrides) {
  const base = {
    type: 'holdemState', phase: 'betting', street: 'flop', baseBet: 100, smallBlind: 50, pot: 600, currentBet: 200, minRaise: 100, allInCap: null,
    board: [c(13, '♣'), c(3, '♣'), c(7, '♠')], smallBlindId: 'p2', bigBlindId: 'p3', turnPlayerId: 'p1',
    turnTotalMs: 30000, turnRemainingMs: 18000, peeking: false, peekTotalMs: null, peekRemainingMs: null, paused: false, result: null, history: [{ text: '시작', timestamp: 0 }],
    you: { id: 'p1', chips: 1000000, ready: false, inRound: true, handName: '하이 카드' },
    baseBetProposal: null, canStart: false, readyCount: 0, minPlayers: 2,
    players: [
      { id: 'p1', nickname: '김하늘', chips: 1000000, ready: false, connected: true, inRound: true, isFolded: false, isAllIn: false, roundBet: 0, action: '', cards: [c(1, '♠'), c(1, '♥')], handName: null },
      { id: 'p2', nickname: '박서준', chips: 999900, ready: false, connected: true, inRound: true, isFolded: false, isAllIn: false, roundBet: 200, action: 'raise', cards: HIDDEN, handName: null },
      { id: 'p3', nickname: '최민아', chips: 999900, ready: false, connected: true, inRound: true, isFolded: false, isAllIn: false, roundBet: 200, action: 'call', cards: HIDDEN, handName: null },
    ],
  };
  return { ...base, ...overrides };
}
const withYou = (patch, state) => ({ ...state, you: { ...state.you, ...patch }, players: state.players.map((p) => (p.id === state.you.id ? { ...p, ...patch } : p)) });

async function open(browser, options) {
  const context = await browser.newContext(options || { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') page.errors.push(`${message.text()} @${JSON.stringify(message.location())}`); });
  // 진짜 연결을 대신하는 가짜: 화면이 보내는 요청을 모아 두고, 상태는 테스트가 직접 먹인다.
  await page.addInitScript(() => {
    window.__sent = [];
    window.__sendResult = true;
    const fake = { open(options) { window.__opts = options; return { send(type, extra) { window.__sent.push([type, extra]); return window.__sendResult; }, leave() {} }; } };
    // public/game-socket.js가 진짜를 덮어쓰지 못하게 한다.
    Object.defineProperty(window, 'GameSocket', { get: () => fake, set: () => {}, configurable: true });
    sessionStorage.setItem('game-portal-nickname', '김하늘');
  });
  await page.goto(`http://127.0.0.1:${PORT}/holdem.html`);
  page.feed = (state) => page.evaluate((s) => window.__opts.onMessage(s), state);
  return page;
}
const text = (page, selector) => page.textContent(selector);

(async () => {
  const server = createGameServer({ port: PORT, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  const pages = [];
  try {
    const page = await open(browser); pages.push(page);

    // ── 콜 ────────────────────────────────────────────────
    await page.feed(makeState({}));
    check('낼 돈이 있으면 버튼이 "콜 · 금액"이다', (await text(page, '#call')).trim() === '콜 · 200원');
    check('내 차례에는 조작 버튼이 모두 눌린다', await page.isEnabled('#call') && await page.isEnabled('#raise') && await page.isEnabled('#allin') && await page.isEnabled('#fold'));
    await page.feed(withYou({ chips: 150 }, makeState({})));
    check('낼 돈이 가진 칩보다 많으면 콜은 막히고 올인은 열려 있다', !(await page.isEnabled('#call')) && await page.isEnabled('#allin') && await page.isEnabled('#fold'));
    check('그때 이유를 말해 준다', /칩이 모자라 콜할 수 없습니다/.test(await text(page, '#controls-note')), await text(page, '#controls-note'));
    check('칩이 모자라면 레이즈도 막힌다(남는 칩이 없다)', !(await page.isEnabled('#raise')));
    await page.feed(withYou({ chips: 200 }, makeState({})));
    check('낼 돈이 가진 칩과 딱 같으면 콜(= 올인)할 수 있다', await page.isEnabled('#call'));
    await page.feed(withYou({ chips: 5000 }, makeState({ currentBet: 0, players: makeState({}).players.map((p) => ({ ...p, roundBet: 0 })) })));
    check('낼 돈이 없으면 "체크"다', (await text(page, '#call')).trim() === '체크');

    // ── 레이즈 범위 ───────────────────────────────────────
    await page.feed(withYou({ chips: 1000 }, makeState({ minRaise: 300 })));
    const input = () => page.$eval('#raise-amount', (el) => el.value);
    check('기본값은 직전 레이즈 폭이다', (await input()) === '300');
    await page.fill('#raise-amount', '99999');
    await page.press('#raise-amount', 'Tab');
    check('최대는 레이즈 뒤에도 칩이 남는 금액이다(칩 1,000, 낼 돈 200 → 700)', (await input()) === '700', await input());
    await page.click('#quick [data-add="1000"]');
    check('빠른 금액 칩도 최대를 넘지 않는다', (await input()) === '700');
    await page.click('#quick-pot');
    check('"팟" 칩은 팟 + 낼 돈(600 + 200 = 800)이지만 최대(700)로 맞춘다', (await input()) === '700');
    await page.fill('#raise-amount', '300');
    await page.press('#raise-amount', 'Tab');
    await page.click('#raise');
    check('레이즈를 누르면 그 금액이 서버로 간다', JSON.stringify(await page.evaluate(() => window.__sent.slice(-1)[0])) === JSON.stringify(['raise', { amount: 300 }]));
    await page.feed(withYou({ chips: 1000 }, makeState({ minRaise: 300, allInCap: 400 })));
    check('올인으로 상한이 정해지면 레이즈 관련 조작이 모두 막히고 이유가 보인다', !(await page.isEnabled('#raise')) && !(await page.isEnabled('#raise-plus'))
      && /배팅 상한이 정해져 레이즈할 수 없습니다/.test(await text(page, '#controls-note')));
    check('상한이 정해져도 콜·올인·폴드는 열려 있다', await page.isEnabled('#call') && await page.isEnabled('#allin') && await page.isEnabled('#fold'));

    // ── 남의 차례 ─────────────────────────────────────────
    await page.feed(makeState({ turnPlayerId: 'p2' }));
    check('남의 차례에는 모든 조작이 막히고 누구 차례인지 이유가 보인다', !(await page.isEnabled('#call')) && !(await page.isEnabled('#fold'))
      && /박서준님 차례라 지금은 누를 수 없습니다/.test(await text(page, '#controls-note')));
    check('남의 차례 띠는 노란색이 아니다', !(await page.$eval('#turn-strip', (el) => el.classList.contains('mine'))) && (await text(page, '#strip-title')) === '박서준님 차례입니다');

    // ── 제한시간 ──────────────────────────────────────────
    await page.feed(makeState({ turnRemainingMs: 4000 }));
    check('남은 시간이 5초 이하면 막대가 급하다는 표시로 바뀐다', await page.$eval('#timer-track', (el) => el.classList.contains('urgent')) && /^[1-4]초$|^5초$/.test(await text(page, '#timer')), await text(page, '#timer'));
    await page.feed(makeState({ turnRemainingMs: 12000, paused: true }));
    const frozen = await page.$eval('#timer-bar', (el) => el.style.width);
    await wait(900);
    check('화면이 가려져 제한시간이 멈추면 "멈춤"으로 보이고 막대가 줄지 않는다', (await text(page, '#timer')) === '멈춤' && (await page.$eval('#timer-bar', (el) => el.style.width)) === frozen && /제한시간이 멈췄습니다/.test(await text(page, '#message')));
    await page.feed(makeState({ turnTotalMs: null, turnRemainingMs: null }));
    check('제한시간이 없는 방은 막대를 숨긴다', await page.$eval('#timer-track', (el) => el.classList.contains('hidden')) && (await text(page, '#timer')) === '');

    // ── 카드 확인 시간 ────────────────────────────────────
    const peekBase = { peeking: true, peekTotalMs: 2000, peekRemainingMs: 1500, turnPlayerId: null, turnRemainingMs: null, board: [], street: 'preflop' };
    await page.feed(makeState(peekBase));
    check('카드를 나눈 직후에는 "카드를 확인하세요" 띠가 보이고 내 차례 색(노랑)은 아니다', (await text(page, '#strip-title')) === '카드를 확인하세요'
      && await page.$eval('#turn-strip', (el) => el.classList.contains('peek') && !el.classList.contains('mine')) && /곧 배팅이 시작됩니다/.test(await text(page, '#message')));
    check('남은 확인 시간이 초와 막대로 보인다', /^[12]초$/.test(await text(page, '#timer')) && await page.$eval('#timer-bar', (el) => parseFloat(el.style.width) > 60 && parseFloat(el.style.width) <= 76) && !(await page.$eval('#timer-track', (el) => el.classList.contains('urgent'))), `${await text(page, '#timer')} ${await page.$eval('#timer-bar', (el) => el.style.width)}`);
    check('확인 시간에는 모든 조작이 막히고 이유가 보인다', !(await page.isEnabled('#call')) && !(await page.isEnabled('#raise')) && !(await page.isEnabled('#allin')) && !(await page.isEnabled('#fold'))
      && /카드를 확인하는 중입니다/.test(await text(page, '#controls-note')));
    check('내 카드는 확인 시간에도 바로 앞면으로 보이고(등장 효과 없이) "내 카드 확인" 표시가 붙는다', await page.$$eval('#seats .seat.me .hcard:not(.back)', (list) => list.length === 2 && list.every((el) => !el.classList.contains('new')))
      && (await text(page, '#seats .seat.me .seat-tag')) === '내 카드 확인');
    check('확인 시간에는 탭 제목에 "(내 차례)"가 붙지 않는다', (await page.title()) === '텍사스 홀덤');
    await page.feed(withYou({ inRound: false }, makeState(peekBase)));
    check('이번 판에 끼지 않은 사람에게는 확인 띠 대신 관전 안내가 보인다', (await text(page, '#strip-title')) === '관전 중' && !(await page.$eval('#turn-strip', (el) => el.classList.contains('peek'))));
    await page.feed(makeState({ turnPlayerId: 'p1' }));
    check('확인 시간이 끝나 내 차례가 되면 노란 띠로 바뀐다', await page.$eval('#turn-strip', (el) => el.classList.contains('mine') && !el.classList.contains('peek')) && (await page.title()) === '(내 차례) 텍사스 홀덤');

    // ── 결과 ──────────────────────────────────────────────
    const result = { phase: 'result', street: 'river', pot: 0, turnPlayerId: null, board: [c(1, '♦'), c(13, '♦'), c(2, '♠'), c(7, '♠'), c(3, '♣')],
      you: { id: 'p1', chips: 1000000, ready: false, inRound: true, handName: '원 페어' } };
    await page.feed(makeState({ ...result, result: { winners: [{ id: 'p1', nickname: '김하늘', amount: 600, handName: '원 페어' }], amount: 600, revealed: false, hands: [], board: [] } }));
    check('모두 폴드해서 끝난 판은 이긴 사람이 카드를 보이지 않는다(내 카드만 앞면, 남은 사람 뒷면)', /김하늘님이 팟 600원을 획득했습니다/.test(await text(page, '#message')));
    const players = makeState({}).players;
    await page.feed(makeState({ ...result, result: { winners: [{ id: 'p1', nickname: '김하늘', amount: 300, handName: '원 페어' }, { id: 'p3', nickname: '최민아', amount: 300, handName: '원 페어' }], amount: 600, revealed: true, hands: [], board: [] },
      players: players.map((p) => ({ ...p, cards: p.id === 'p2' ? null : (p.id === 'p1' ? p.cards : [c(1, '♣'), c(9, '♥')]), isFolded: p.id === 'p2', handName: p.id === 'p2' ? null : '원 페어' })) }));
    check('비기면 모두의 몫이 띠에 보이고 승자 자리가 둘이다', /김하늘 300원, 최민아 300원 - 팟 600원을 나눠 가졌습니다/.test(await text(page, '#message')) && (await page.$$eval('#seats .seat.winner', (list) => list.length)) === 2);
    await page.feed(makeState({ ...result, result: { noWinner: true, message: '남은 카드가 부족해 배팅금을 돌려드립니다.' } }));
    check('승자가 없는 판은 이유가 보인다', /배팅금을 돌려드립니다/.test(await text(page, '#message')));

    // ── 닉네임 ────────────────────────────────────────────
    const evil = '<img src=x onerror="window.__xss=1">';
    await page.feed(makeState({ players: makeState({}).players.map((p) => (p.id === 'p2' ? { ...p, nickname: evil } : p)), turnPlayerId: 'p2' }));
    await wait(100);
    check('닉네임의 HTML은 태그가 아니라 글자로 보인다', (await page.$$('#players img, #seats img, #message img, #strip-title img')).length === 0
      && (await text(page, '#players')).includes(evil) && !(await page.evaluate(() => window.__xss)));
    check('차례 띠에도 글자로 나온다', (await text(page, '#strip-title')).includes(evil));

    // ── 연결이 끊겨 보낼 수 없을 때 ────────────────────────
    await page.feed(makeState({}));
    await page.evaluate(() => { window.__sendResult = false; });
    await page.click('#call');
    check('연결이 끊겨 요청을 못 보냈으면 알려 준다', /연결이 끊겨 있어 보내지 못했습니다/.test(await text(page, '#error')));

    // ── 올인 꾹 누르기: 키보드와 보조 기기 ───────────────────
    await page.evaluate(() => { window.__sendResult = true; window.__sent.length = 0; });
    await page.feed(makeState({}));
    await page.focus('#allin');
    await page.keyboard.down('Enter');
    await wait(200);
    await page.keyboard.up('Enter');
    await wait(900);
    check('키보드로 올인을 짧게 누르면 실행되지 않는다', !(await page.evaluate(() => window.__sent.some(([type]) => type === 'allin'))));
    await page.keyboard.down('Enter');
    await wait(1000);
    await page.keyboard.up('Enter');
    check('키보드로 꾹 누르면 올인이 실행된다', await page.evaluate(() => window.__sent.filter(([type]) => type === 'allin').length) === 1);
    await page.evaluate(() => { window.__sent.length = 0; document.getElementById('allin').click(); });
    check('보조 기기가 보내는 클릭(꾹 누를 수 없는 경우)은 한 번 더 확인한다', await page.$eval('#allin', (el) => el.classList.contains('confirming') && el.getAttribute('aria-label') === '정말 올인할까요?') && !(await page.evaluate(() => window.__sent.some(([type]) => type === 'allin'))),
      await page.evaluate(() => JSON.stringify({ cls: document.getElementById('allin').className, sent: window.__sent })));
    await page.evaluate(() => document.getElementById('allin').click());
    check('한 번 더 누르면 올인이 실행된다', await page.evaluate(() => window.__sent.filter(([type]) => type === 'allin').length) === 1);

    // ── 판 도중 관전자 ────────────────────────────────────
    await page.feed(withYou({ inRound: false }, makeState({ turnPlayerId: 'p2' })));
    check('이번 판에 끼지 않았으면 조작 버튼이 사라지고 이유만 보인다', !(await page.isVisible('#call')) && /관전 중입니다/.test(await text(page, '#controls-note')));

    // ── 다섯 명이 작은 폰에 앉음 ──────────────────────────
    const phone = await open(browser, { ...devices['iPhone SE'] }); pages.push(phone);
    const five = ['김하늘', '박서준', '최민아', '이준호', '정다은'].map((nickname, i) => ({
      id: `p${i + 1}`, nickname, chips: 1000000, ready: false, connected: true, inRound: true, isFolded: false, isAllIn: false, roundBet: 100, action: '',
      cards: i === 0 ? [c(12, '♠'), c(10, '♥')] : HIDDEN, handName: null }));
    await phone.feed(makeState({ players: five, pot: 500 }));
    const fit = await phone.evaluate(() => {
      const felt = document.getElementById('cards').getBoundingClientRect();
      const out = [...document.querySelectorAll('#seats .seat')].filter((el) => { const r = el.getBoundingClientRect(); return r.left < felt.left - 1 || r.right > felt.right + 1; }).length;
      return { overflowX: document.documentElement.scrollWidth > innerWidth + 1, seatsOutside: out };
    });
    check('다섯 명이 앉아도 가로로 넘치지 않고 자리가 판 밖으로 나가지 않는다', !fit.overflowX && fit.seatsOutside === 0, JSON.stringify(fit));
    check('폰의 참가자 줄은 짧은 금액(100만 · +100)으로 보인다', /100만 · \+100/.test(await phone.innerText('#players')) && !/건 돈/.test(await phone.innerText('#players')), await phone.innerText('#players'));

    // 폰 브라우저는 내용이 넘치면 화면을 넓혀 넘침을 숨긴다(innerWidth가 커진다). 기기 폭(screen.width)과 견주고, 레이즈 창까지 연 상태로 본다.
    for (const [label, device] of [['iPhone SE', devices['iPhone SE']], ['폭 320px', { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true }]]) {
      const small = await open(browser, device); pages.push(small);
      await small.feed(makeState({ players: five, pot: 500 }));
      await small.tap('#raise');
      const metrics = await small.evaluate(() => ({ screen: screen.width, w: innerWidth,
        outside: [...document.querySelectorAll('body *')].filter((el) => el.getClientRects().length && getComputedStyle(el).position !== 'fixed' && el.getBoundingClientRect().right > screen.width + 1).map((el) => el.id || el.className).slice(0, 5) }));
      check(`${label}: 레이즈 창을 열어도 화면이 넓어지거나 밖으로 나가는 요소가 없다`, metrics.w <= metrics.screen + 1 && metrics.outside.length === 0, JSON.stringify(metrics));
    }

    check('브라우저 오류가 없다', pages.every((p) => p.errors.length === 0), pages.map((p) => p.errors.join('|')).filter(Boolean).join(' / '));
  } finally {
    for (const p of pages) await p.context().close().catch(() => {});
    await browser.close().catch(() => {});
    await server.stop();
  }
  console.log(`\n홀덤 화면 그리기: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
