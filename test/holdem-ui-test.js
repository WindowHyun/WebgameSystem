'use strict';

/**
 * 텍사스 홀덤 화면(public/holdem.html·holdem.js·holdem.css)을 실제 브라우저로 본다.
 *
 *   - 포털에 홀덤 채널이 있고, 들어가면 준비 → 시작 확인 창 → 판이 열린다.
 *   - 내 차례 띠는 내 차례에만 노란색이고, 탭 제목에 "(내 차례)"가 붙는다(끌 수 있고, 새로고침해도 설정이 남는다).
 *   - 내 카드만 앞면이고 남의 카드는 뒷면이다. 딜러·블라인드 표시와 블라인드 금액이 보인다.
 *   - 빠른 레이즈 칩과 −/+가 서버가 받아 주는 범위(직전 레이즈 폭 ~ 칩이 남는 만큼)를 벗어나지 않는다.
 *   - 올인은 꾹 눌러야 실행되고(짧게 누르면 아무 일 없음), 폴드는 한 번 더 확인한다.
 *   - 판이 끝나면 이긴 사람·패 이름·공용 카드 5장이 보이고, 다음 판 준비로 돌아간다.
 *   - 폰: 가로로 넘치지 않고, 레이즈 금액 창은 접혀 있다가 레이즈를 누르면 열린다. 눌러야 하는 버튼은 44px 이상이다.
 *   - 판 도중에 들어온 사람은 조작 버튼 대신 이유만 본다. 브라우저 오류가 없다.
 *
 * 실행: node test/holdem-ui-test.js
 */

const { chromium, devices } = require('playwright');
const { createGameServer } = require('../web/game-server');

const PORT = 4712;
const PHONE_PORT = 4713;
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, label, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    if (await condition()) return true;
    await wait(40);
  }
  throw new Error(`기다리다 시간 초과: ${label}`);
}

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { ...devices['iPhone 12'] };

async function enter(browser, name, options, port) {
  const context = await browser.newContext(options || DESKTOP);
  const page = await context.newPage();
  page.label = name;
  page.touch = !!(options && options.hasTouch);
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') page.errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port || PORT}/`);
  await page.fill('#nickname', name);
  await page.press('#nickname', 'Enter');
  await page.click('.game-card.holdem');
  await page.waitForSelector('#players .player');
  return page;
}
const tap = (page, selector) => (page.touch ? page.tap(selector) : page.click(selector));
/** 버튼을 마우스로 ms 동안 누르고 있다 뗀다(올인은 꾹 눌러야 실행된다). */
async function press(page, selector, ms) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await wait(ms);
  await page.mouse.up();
}
const title = (page) => page.textContent('#strip-title');
const myTurn = async (page) => (await title(page)) === '내 차례입니다';
const phase = (page) => page.textContent('#phase');
async function mover(pages) {
  for (const page of pages) if (await myTurn(page)) return page;
  return null;
}
async function waitMover(pages) {
  await until(() => mover(pages), '내 차례인 사람');
  return mover(pages);
}
/** 대기실에서 모두 준비 → 한 명이 시작 → 확인 창에서 시작. */
async function startHand(pages) {
  for (const page of pages) {
    if ((await page.textContent('#ready')) === '준비') await tap(page, '#ready');
  }
  await until(async () => !(await pages[0].isDisabled('#start')), '시작 가능');
  await tap(pages[0], '#start');
  await tap(pages[0], '#start-go');
  await until(async () => (await phase(pages[0])) === '프리플랍', '판 시작');
}
/** 차례인 사람이 콜/체크로 끝낼 때까지 돌린다. */
async function checkDown(pages) {
  for (let i = 0; i < 24; i += 1) {
    if ((await phase(pages[0])) === '라운드 종료') return;
    const page = await mover(pages);
    if (page) await tap(page, '#call');
    await wait(120);
  }
}

(async () => {
  const server = createGameServer({ port: PORT, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  const all = [];
  try {
    // ── 포털과 입장 ────────────────────────────────────────
    const a = await enter(browser, '김하늘'); all.push(a);
    const b = await enter(browser, '박서준'); all.push(b);
    const c = await enter(browser, '최민아'); all.push(c);
    const pages = [a, b, c];
    check('입장하면 참가자 세 명이 목록에 보인다', await a.$$eval('#players .player', (list) => list.length) === 3);
    check('대기 중에는 시작 조건이 문구로 설명된다', /준비한 참가자가 2명 이상/.test(await a.textContent('#message')));
    check('탭 제목은 평소 "텍사스 홀덤"이다', await a.title() === '텍사스 홀덤');
    check('블라인드(스몰/빅)가 띠에 보인다', (await a.textContent('#blind-label')) === '블라인드 50 / 100');
    {
      const portal = await (await browser.newContext(DESKTOP)).newPage();
      await portal.goto(`http://127.0.0.1:${PORT}/`);
      await portal.fill('#nickname', '구경'); await portal.press('#nickname', 'Enter');
      await until(async () => /진행|대기/.test(await portal.textContent('#holdem-status')), '포털 상태');
      check('포털에 홀덤 채널이 있고 인원이 보인다', (await portal.textContent('.game-card.holdem b')) === '텍사스 홀덤' && (await portal.textContent('#holdem-count')) === '3명');
      await portal.context().close();
    }

    // ── 시작 ──────────────────────────────────────────────
    await startHand(pages);
    const first = await waitMover(pages);
    const others = pages.filter((p) => p !== first);
    check('판이 시작되면 거리 이름이 프리플랍이고 팟에 블라인드가 들어 있다', (await phase(first)) === '프리플랍' && (await first.textContent('#pot')) === '150원');
    check('내 차례 띠는 내 차례인 사람에게만 노란색이다', await first.$eval('#turn-strip', (el) => el.classList.contains('mine'))
      && !(await others[0].$eval('#turn-strip', (el) => el.classList.contains('mine'))) && !(await others[1].$eval('#turn-strip', (el) => el.classList.contains('mine'))));
    const stripColor = await first.$eval('#turn-strip', (el) => getComputedStyle(el).backgroundColor);
    check('내 차례 띠의 색은 노란색(#ecb22e)이다', stripColor === 'rgb(236, 178, 46)', stripColor);
    check('차례가 아닌 사람 화면에는 누구 차례인지와 기다리라는 말이 있다', /님 차례입니다/.test(await title(others[0])) && /기다리는 중/.test(await others[0].textContent('#message')));
    check('탭 제목에 "(내 차례)"가 붙는다(내 차례인 사람만)', (await first.title()) === '(내 차례) 텍사스 홀덤' && (await others[0].title()) === '텍사스 홀덤', `${await first.title()} / ${await others[0].title()}`);
    check('제한시간이 초 단위로 보이고 막대가 있다', /^\d+초$/.test(await first.textContent('#timer')) && !(await first.$eval('#timer-track', (el) => el.classList.contains('hidden'))));
    check('제한시간 막대 너비가 줄어든다(처음보다 시간이 지난 만큼)', await (async () => {
      const w1 = await first.$eval('#timer-bar', (el) => parseFloat(el.style.width));
      await wait(1300);
      const w2 = await first.$eval('#timer-bar', (el) => parseFloat(el.style.width));
      return w2 < w1;
    })());

    // 카드: 내 것만 앞면
    const seatInfo = await first.$$eval('#seats .seat', (seats) => seats.map((seat) => ({
      me: seat.classList.contains('me'), faceUp: seat.querySelectorAll('.hcard:not(.back):not(.empty)').length, backs: seat.querySelectorAll('.hcard.back').length,
      badges: [...seat.querySelectorAll('.pos')].map((e) => e.textContent),
    })));
    check('내 카드 2장은 앞면, 남의 카드 2장씩은 뒷면이다', seatInfo.length === 3 && seatInfo.filter((s) => s.me)[0].faceUp === 2 && seatInfo.filter((s) => !s.me).every((s) => s.backs === 2 && s.faceUp === 0), JSON.stringify(seatInfo));
    const badges = seatInfo.flatMap((s) => s.badges).sort().join();
    check('딜러(D)·스몰(SB)·빅(BB) 표시가 한 명씩 있다', badges === 'BB,D,SB', badges);
    check('공용 카드 자리는 5칸이고 아직 비어 있다', await first.$$eval('#board .hcard', (list) => list.length === 5 && list.every((el) => el.classList.contains('empty'))));
    check('참가자 목록에 "보유 · 건 돈"이 보인다', /보유 100만 · 건 돈/.test(await a.textContent('#players')));

    // ── 레이즈 입력 ────────────────────────────────────────
    const raiseValue = () => first.$eval('#raise-amount', (el) => el.value);
    check('레이즈 기본값은 최소 폭(블라인드 100)이다', (await raiseValue()) === '100');
    await first.click('#quick [data-add="500"]');
    await first.click('#quick [data-add="1000"]');
    check('빠른 금액 칩을 누르면 더해진다(100+500+1,000)', (await raiseValue()) === '1600');
    await first.click('#raise-minus');
    check('−는 100씩 줄인다', (await raiseValue()) === '1500');
    for (let i = 0; i < 20; i += 1) await first.click('#raise-minus');
    check('최소 폭 아래로는 내려가지 않는다', (await raiseValue()) === '100');
    await first.click('#quick-pot');
    check('"팟" 칩은 팟 크기만큼 올린다(팟 150 + 콜 100 → 300)', (await raiseValue()) === '300', await raiseValue());
    await first.fill('#raise-amount', '70');
    await first.press('#raise-amount', 'Tab');
    check('직접 적은 값도 100 단위·최소 폭으로 맞춘다', (await raiseValue()) === '100', await raiseValue());
    await first.fill('#raise-amount', '9999999999');
    await first.press('#raise-amount', 'Tab');
    const maxRaise = Number(await raiseValue());
    check('칩보다 큰 값은 칩이 남는 최대로 맞춘다', maxRaise > 0 && maxRaise < 1000000 && maxRaise % 100 === 0, String(maxRaise));
    await first.fill('#raise-amount', '300');
    await first.press('#raise-amount', 'Tab');

    // ── 올인은 꾹, 폴드는 한 번 더 ────────────────────────
    const potBefore = await first.textContent('#pot');
    await press(first, '#allin', 150);
    await wait(900);
    check('올인을 짧게 누르면 아무 일도 일어나지 않는다', (await myTurn(first)) && (await first.textContent('#pot')) === potBefore);
    await first.click('#fold');
    await wait(300); // 마우스가 버튼 위에 있는 채로 - 설명 말풍선이 질문을 덮거나 버튼이 줄어들면 안 된다
    check('폴드를 한 번 누르면 확인을 다시 묻고 폴드되지 않는다', await first.$eval('#fold', (el) => el.classList.contains('confirming') && el.getAttribute('aria-label') === '정말 폴드할까요?'
      && el.querySelector('.label').textContent === '정말 폴드할까요?' && el.getBoundingClientRect().width > 120) && (await myTurn(first)));
    await wait(3300);
    check('확인을 안 하면 잠시 뒤 원래 버튼으로 돌아온다', !(await first.$eval('#fold', (el) => el.classList.contains('confirming'))) && /^폴드/.test((await first.textContent('#fold')).trim()) && (await myTurn(first)));

    // ── 레이즈 보내기 ─────────────────────────────────────
    await first.click('#raise');
    await until(async () => (await first.textContent('#pot')) !== potBefore, '레이즈 반영');
    check('레이즈하면 팟이 늘고(150 + 400) 내 차례가 넘어간다', !(await myTurn(first)) && (await first.textContent('#pot')) === '550원', await first.textContent('#pot'));
    check('레이즈를 한 사람은 참가자 목록에 "레이즈"로 보인다', /레이즈/.test(await a.textContent('#players')));

    // 다음 사람: 콜 라벨, 그다음 사람은 폴드(두 번 누르기)
    const second = await waitMover(pages);
    check('올린 뒤 다음 사람의 버튼은 "콜 · 금액"이다', /^콜 · \d/.test((await second.textContent('#call')).trim()), await second.textContent('#call'));
    await second.click('#fold');
    await second.click('#fold');
    await until(async () => /폴드했습니다/.test(await title(second)), '폴드');
    check('폴드를 두 번 누르면 폴드되고 남은 판을 관전한다', await second.$eval('#betting', (el) => el.classList.contains('spectating')) && /남은 판을 관전/.test(await second.textContent('#message')));
    const third = await waitMover(pages);
    await tap(third, '#call');
    await until(async () => (await phase(third)) === '플랍', '플랍');
    check('콜로 맞추면 플랍이 열리고 공용 카드 3장이 보이며 거리별 배팅액은 0으로 돌아간다', (await third.$$eval('#board .hcard:not(.empty)', (list) => list.length)) === 3
      && (await third.textContent('#pot')) === '850원' && !/건 돈 [1-9]/.test(await third.textContent('#seats')));
    check('플랍에서는 내 패 이름이 띠에 보인다', /지금 내 패: .+/.test(await third.textContent('#message')) || /지금 내 패: .+/.test(await others[0].textContent('#message')));
    await checkDown(pages);
    await until(async () => (await phase(third)) === '라운드 종료', '쇼다운');
    check('끝까지 가면 공용 카드 5장이 깔린다', (await third.$$eval('#board .hcard:not(.empty)', (list) => list.length)) === 5);
    const message = await third.textContent('#message');
    check('끝나면 이긴 사람과 패 이름이 띠에 보인다', /(획득했습니다|나눠 가졌습니다) \(.+\)/.test(message), message);
    check('이긴 사람 자리에 "승리"와 "+금액"이 보인다', (await third.$$eval('#seats .seat.winner', (list) => list.length)) >= 1 && /\+[\d,]+원/.test(await third.textContent('#seats .seat.winner')));
    const names = await third.$$eval('#seats .seat-hand', (list) => list.map((el) => el.textContent));
    check('쇼다운에 간 사람의 패 이름이 카드 아래에 보인다', names.length === 2 && names.every((n) => n.length > 0), names.join(','));
    check('폴드한 사람의 카드는 남에게 보이지 않는다', await third.$$eval('#seats .seat.folded .hcard', (list) => list.length === 0));
    check('끝난 뒤에는 시작 조작이 다시 보인다', !(await third.$eval('#lobby', (el) => el.classList.contains('hidden'))));
    check('끝나면 탭 제목이 평소로 돌아온다', (await third.title()) === '텍사스 홀덤');

    // ── 알림 설정 ──────────────────────────────────────────
    check('알림음은 기본이 꺼져 있다(사무실에서 몰래 하는 화면이라)', !(await a.isChecked('#notify-sound')) && (await a.isChecked('#notify-title')));
    await a.uncheck('#notify-title');
    await a.reload();
    await a.waitForSelector('#players .player');
    check('탭 제목 표시를 끄면 새로고침해도 꺼진 채로 남는다', !(await a.isChecked('#notify-title')));
    await a.check('#notify-title');

    // ── 다음 판: 버튼(딜러)이 한 칸 돈다 ────────────────────
    const dealerOf = (page) => page.$$eval('#seats .seat', (seats) => seats.filter((s) => s.querySelector('.pos.dealer')).map((s) => s.querySelector('b').textContent.replace(' (나)', ''))[0]);
    const dealer1 = await dealerOf(a);
    await startHand(pages);
    const dealer2 = await dealerOf(a);
    check('다음 판에는 딜러 표시가 다른 사람에게 넘어간다', typeof dealer2 === 'string' && dealer2.length > 0 && dealer2 !== dealer1, `${dealer1} → ${dealer2}`);

    // ── 판 도중에 들어온 사람 ──────────────────────────────
    const late = await enter(browser, '지각'); all.push(late);
    await until(async () => /관전/.test(await title(late)), '관전 안내');
    check('판 도중에 들어온 사람은 관전 중이고 조작 버튼 대신 이유가 보인다', await late.$eval('#betting', (el) => el.classList.contains('spectating'))
      && /관전 중입니다/.test(await late.textContent('#controls-note')) && !(await late.isVisible('#call')));
    check('판 도중에 들어온 사람에게는 남의 카드가 뒷면이다', await late.$$eval('#seats .hcard', (list) => list.every((el) => el.classList.contains('back'))));
    await checkDown(pages);
    await until(async () => (await phase(a)) === '라운드 종료', '체크로 쇼다운');

    // ── 올인(꾹 누르기): 실제 칩 전부가 걸린다. 마지막에 본다(진 사람은 칩이 없어진다). ──
    await startHand(pages);
    const shover = await waitMover(pages);
    await press(shover, '#allin', 1000);
    await until(async () => !(await myTurn(shover)), '올인 반영');
    check('올인을 꾹 누르면 실행된다', (await shover.textContent('#pot')) !== '150원');
    const caller = await waitMover(pages);
    // 앞 판들로 칩이 서로 달라서, 올인한 금액을 맞출 칩이 모자랄 수 있다. 그때 콜은 막히고 올인만 남는다.
    if (await caller.isEnabled('#call')) await tap(caller, '#call');
    else {
      check('낼 돈이 가진 칩보다 많으면 콜 버튼이 막히고 이유가 보인다', /칩이 모자라 콜할 수 없습니다/.test(await caller.textContent('#controls-note')));
      await press(caller, '#allin', 1000);
    }
    await until(async () => !(await myTurn(caller)), '콜(또는 올인) 반영');
    const folder = await waitMover(pages);
    await folder.click('#fold');
    await folder.click('#fold');
    await until(async () => (await phase(a)) === '라운드 종료', '올인 판 종료', 150);
    check('올인에 콜하면 상한이 정해져 곧바로 공용 카드 5장을 깔고 겨룬다', (await a.$$eval('#board .hcard:not(.empty)', (list) => list.length)) === 5);
    check('여기까지 브라우저 오류가 없다', all.every((p) => p.errors.length === 0), all.map((p) => p.errors.join('|')).filter(Boolean).join(' / '));
  } finally {
    for (const page of all) await page.context().close().catch(() => {});
    await browser.close().catch(() => {});
    await server.stop();
  }

  // ── 폰 ──────────────────────────────────────────────────
  // 앞 판에서 칩을 잃은 사람이 없는 새 방에서 보려고 서버를 새로 띄운다.
  const server2 = createGameServer({ port: PHONE_PORT, host: '127.0.0.1' });
  await server2.start();
  const browser2 = await chromium.launch();
  const phones = [];
  try {
    const p1 = await enter(browser2, '폰하늘', PHONE, PHONE_PORT); phones.push(p1);
    const p2 = await enter(browser2, '폰서준', DESKTOP, PHONE_PORT); phones.push(p2);
    const p3 = await enter(browser2, '폰민아', { ...devices['iPhone SE'] }, PHONE_PORT); phones.push(p3);
    await startHand(phones);
    const handler = await waitMover(phones);
    const phoneHandler = [p1, p3].includes(handler) ? handler : null;
    // 폰 화면 하나를 골라 본다(차례가 폰이 아니면 데스크톱이 차례를 넘기도록 콜).
    let target = phoneHandler;
    if (!target) { await tap(handler, '#call'); target = await waitMover(phones); }
    if (target === p2) { await tap(p2, '#call'); target = await waitMover(phones); }
    // 폰 브라우저는 내용이 넘치면 화면을 넓혀서(innerWidth가 커진다) 넘침을 숨긴다 - 기기 실제 폭(screen.width)과 견준다.
    const fits = () => target.evaluate(() => ({ screen: screen.width, w: innerWidth, scroll: document.documentElement.scrollWidth,
      outside: [...document.querySelectorAll('#betting button, #betting input, #seats .seat-cards, #board .hcard')].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > screen.width + 1).length }));
    const view = await fits();
    check('폰: 가로로 넘치지 않는다(기기 폭 기준)', view.w <= view.screen + 1 && view.scroll <= view.screen + 1 && view.outside === 0, JSON.stringify(view));
    check('폰: 레이즈 금액 창은 접혀 있다', !(await target.isVisible('#raise-amount')));
    const sizes = await target.evaluate(() => ['call', 'raise', 'allin', 'fold'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, Math.round(r.width), Math.round(r.height)]; }));
    check('폰: 체크·레이즈·올인·폴드는 44px 이상이다', sizes.every(([, w, h]) => w >= 44 && h >= 44), JSON.stringify(sizes));
    const inside = await target.evaluate(() => {
      const felt = document.getElementById('cards').getBoundingClientRect();
      return [...document.querySelectorAll('#seats .seat-cards, #board .hcard')].every((el) => { const r = el.getBoundingClientRect(); return r.left >= felt.left - 1 && r.right <= felt.right + 1; });
    });
    check('폰: 카드가 판 밖으로 삐져나가지 않는다', inside);
    await tap(target, '#raise');
    check('폰: 레이즈를 누르면 금액 창이 열리고 버튼이 금액을 알려 준다', (await target.isVisible('#raise-amount')) && /^레이즈 · \d/.test((await target.textContent('#raise')).trim()), await target.textContent('#raise'));
    const chipSizes = await target.$$eval('#quick .chip, #raise-minus, #raise-plus', (list) => list.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    const openView = await fits();
    check('폰: 레이즈 금액 창을 열어도 기기 폭을 넘지 않는다', openView.w <= openView.screen + 1 && openView.outside === 0, JSON.stringify(openView));
    check('폰: 빠른 금액 칩과 −/+도 44px 이상이다', chipSizes.every(([w, h]) => w >= 44 && h >= 44), JSON.stringify(chipSizes));
    const before = await target.textContent('#pot');
    await tap(target, '#raise');
    await until(async () => (await target.textContent('#pot')) !== before, '폰 레이즈 반영');
    check('폰: 한 번 더 누르면 올리고 금액 창이 다시 접힌다', !(await target.isVisible('#raise-amount')));

    // 설명 보기("?")에 새 버튼들의 설명이 있다
    const sheetTarget = [p1, p3].find((p) => p !== target) || target;
    await tap(sheetTarget, '#help-open');
    const helpText = await sheetTarget.textContent('#help-sheet');
    check('폰: "?"를 누르면 올인(꾹 누르기)·폴드(한 번 더 확인) 설명이 나온다', /꾹 눌러야 실행/.test(helpText) && /한 번 더 확인/.test(helpText), helpText.slice(0, 120));
    check('폰: 브라우저 오류가 없다', phones.every((p) => p.errors.length === 0), phones.map((p) => p.errors.join('|')).filter(Boolean).join(' / '));
  } finally {
    for (const page of phones) await page.context().close().catch(() => {});
    await browser2.close().catch(() => {});
    await server2.stop();
  }

  console.log(`\n홀덤 화면: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
