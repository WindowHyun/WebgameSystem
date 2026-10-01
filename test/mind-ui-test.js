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
 *   - 폰에서 레벨이 올라 판이 길어져도 맨 위에서 "카드 내기"가 화면 안에 있다(조작부가 화면 아래에 붙는다)
 *   - 남이 무엇을 눌러도 내 카드는 다시 그리지 않는다(등장 애니메이션이 매번 다시 돌며 깜빡이지 않는다)
 *   - 새 카드가 나오면 가운데 카드는 새로 그린다(방금 나온 카드에 등장 애니메이션)
 *   - 버튼을 누르면 서버 답을 기다리는 동안 바로 눌림 표시가 난다
 *   - 수리검을 제안한 사람에게 누구를 기다리는지 보여 준다
 *   - 실수 연출: 쥐고 있던 사람은 자기 손패 자리에서, 다른 사람은 가운데 더미 옆에서 카드가 찢어진다.
 *     낸 카드에 ✕ 도장. 끝나면 연출 층이 비고, 새로고침해도 지난 실수를 다시 재생하지 않는다.
 *     동작 줄이기를 켠 사람에게는 찢지 않고 빨간 테두리로만 보인다. 진동은 쓰지 않는다.
 *   - (상태를 손으로 넣어) 서버가 새로 떠 사건 번호가 다시 시작해도 첫 실수를 연출한다. 상관없는 상태에서는
 *     손패 위치를 재지 않는다. 실수로 레벨이 끝나 받은 새 패는 같은 숫자여도 옛 자리에서 당기지 않는다.
 *     버튼 눌림 잠금은 남의 상태가 아니라 내 요청이 반영된 상태가 와야 풀린다.
 *
 * 실행: node test/mind-ui-test.js
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
      const top = Math.max(...vals);
      const who = pages[vals.indexOf(top)];
      const victims = pages.filter((p, i) => p !== who && vals[i] >= 0 && vals[i] < top);
      const livesBefore = await a.textContent('#lives');
      // 폰은 "동작 줄이기"를 켠 사람으로 본다(찢지 않고 빨간 테두리로만)
      await phone.emulateMedia({ reducedMotion: 'reduce' });
      const fxCount = (sel) => (p) => p.evaluate((s) => document.querySelectorAll(s).length, sel);
      const seen = (p, sel, timeout) => p.waitForFunction((s) => document.querySelectorAll(s).length > 0, sel, { timeout }).then(() => true, () => false);
      const everPieces = pages.map((p) => p.evaluate(() => {
        // [요청] 진동은 쓰지 않는다. 불리면 센다.
        window.__vibrated = 0;
        navigator.vibrate = () => { window.__vibrated += 1; return true; };
        window.__pieces = 0;
        const watch = () => { window.__pieces = Math.max(window.__pieces, document.querySelectorAll('.mind-fx .piece').length); window.__watch = requestAnimationFrame(watch); };
        watch();
      }));
      await Promise.all(everPieces);
      await who.click('#play');
      const moving = victims.filter((p) => p !== phone);
      const [handTorn, besidePile, calmCopies] = await Promise.all([
        Promise.all(moving.map((p) => seen(p, '.mind-fx .card.doomed', 1500))),
        who === phone ? Promise.resolve(true) : seen(who, '.mind-fx .card', 2500),
        seen(phone, '.mind-fx .card.doomed', 2500),
      ]);
      check('실수 연출: 쥐고 있던 사람 화면에서 자기 카드가 찢어질 준비를 한다(손패 자리)', moving.length === 0 || handTorn.every(Boolean), `${moving.length}명`);
      check('실수 연출: 다른 사람 화면에서는 그 사람 카드가 가운데 옆에 나타난다', besidePile);
      check('실수 연출: 동작 줄이기를 켠 사람도 버려지는 카드를 빨간 테두리로 본다', calmCopies);
      await wait(400);
      const event = await a.getAttribute('#event', 'class');
      check('실수하면 목숨이 줄고 무엇이 버려졌는지 크게 보인다', /mistake/.test(event) && (await a.textContent('#lives')) !== livesBefore,
        `${event} ${livesBefore} → ${await a.textContent('#lives')}`);
      // 실수로 남은 카드가 다 버려지면 다음 레벨로 넘어가 더미가 비므로 도장을 찍을 카드가 없다.
      const stamp = await a.evaluate(() => { const t = document.getElementById('pile-top'); return { text: t.textContent, bad: t.classList.contains('bad') }; });
      check('실수 연출: 낸 카드에 ✕ 도장이 찍힌다(더미에 남아 있을 때)', stamp.text === String(top) ? stamp.bad : !stamp.bad, JSON.stringify(stamp) + ` 낸 카드 ${top}`);
      const cleared = await Promise.all(pages.map((p) => p.waitForFunction(() => { const l = document.querySelector('.mind-fx'); return !l || l.children.length === 0; }, null, { timeout: 7000 }).then(() => true, () => false)));
      check('실수 연출: 끝나면 연출 층이 빈다(남는 조각이 없다)', cleared.every(Boolean), cleared.join(','));
      const pieces = [];
      for (const p of pages) pieces.push(await p.evaluate(() => { cancelAnimationFrame(window.__watch); return window.__pieces; }));
      check('실수 연출: 카드가 두 조각으로 찢어진다(동작 줄이기가 아닌 화면)', pages.filter((p) => p !== phone).every((p) => pieces[pages.indexOf(p)] >= 2), pieces.join(','));
      check('실수 연출: 동작 줄이기 화면에서는 찢지 않는다', pieces[pages.indexOf(phone)] === 0, String(pieces[pages.indexOf(phone)]));
      const vibrated = [];
      for (const p of pages) vibrated.push(await p.evaluate(() => window.__vibrated));
      check('실수 연출: 진동은 쓰지 않는다', vibrated.every((n) => n === 0), vibrated.join(','));
      await phone.emulateMedia({ reducedMotion: 'no-preference' });
      await a.reload();
      await a.waitForSelector('#players .player');
      await wait(500);
      check('실수 연출: 새로고침해도 지난 실수를 다시 재생하지 않는다', (await fxCount('.mind-fx .card, .mind-fx .piece')(a)) === 0);
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

    // [이슈] 남이 무엇을 눌러도 내 카드는 그대로다. 예전에는 상태가 올 때마다 손패를 새로 만들어
    // 등장 애니메이션(0.2초, 투명 → 보임)이 매번 다시 돌았다 - 누가 누를 때마다 내 카드가 깜빡였다.
    if (await phase(a) === 'playing') {
      await a.evaluate(() => { window.__hand = document.querySelector('#hand .card'); window.__top = document.getElementById('pile-top'); });
      await b.click('#pause');
      await wait(300);
      const still = await a.evaluate(() => {
        const card = document.querySelector('#hand .card');
        return { same: !!card && card === window.__hand, running: card ? card.getAnimations().length : -1, sameTop: document.getElementById('pile-top') === window.__top };
      });
      check('남이 멈춤을 눌러도 내 카드는 다시 그리지 않는다(깜빡이지 않는다)', still.same && still.running === 0, JSON.stringify(still));
      check('새 카드가 없으면 가운데 카드도 그대로다', still.sameTop);
      // [반응] 누르는 즉시 눌림 표시(서버 답이 오기 전 같은 순간에 확인한다)
      const sending = await a.evaluate(() => { const f = document.getElementById('focus'); f.click(); return f.classList.contains('sending') && f.disabled; });
      check('버튼을 누르면 서버 답을 기다리는 동안 바로 눌림 표시가 난다', sending);
      await wait(300);
      const settled = await a.evaluate(() => { const f = document.getElementById('focus'); return { sending: f.classList.contains('sending'), disabled: f.disabled, text: f.textContent }; });
      check('답이 오면 눌림 표시가 풀리고 결과가 보인다', !settled.sending && !settled.disabled && settled.text === '집중 취소', JSON.stringify(settled));
      await focusAll(pages);
      const vals = [];
      for (const p of pages) vals.push(await p.isVisible('#play') && await p.isEnabled('#play') ? await lowest(p) : Infinity);
      const next = pages[vals.indexOf(Math.min(...vals))];
      await next.click('#play');
      await wait(300);
      check('새 카드가 나오면 가운데 카드를 새로 그린다(방금 나온 카드에 등장 애니메이션)',
        await a.evaluate(() => document.getElementById('pile-top') !== window.__top));
    } else {
      check('깜빡임 검사를 위해 진행 중이어야 한다', false, await phase(a));
    }

    // 폰
    const layout = await phone.evaluate(() => {
      const play = document.getElementById('focus').offsetParent ? document.getElementById('focus') : document.getElementById('play');
      const box = play.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, buttonInView: box.bottom <= innerHeight + 1 && box.top >= 0 };
    });
    check('폰: 가로로 넘치지 않는다', !layout.overflow);
    check('폰: 조작 버튼이 화면 안에 보인다(아래에 붙어 있다)', layout.buttonInView, JSON.stringify(layout));

    // [이슈] 폰에서 레벨이 오르면 판(사건 안내·버린 카드·손패)이 길어져 "카드 내기"가 화면 아래로 밀려났다.
    // 조작부를 화면 아래에 붙이는 규칙이 main 안에서만 붙어 실제로는 붙지 않았다. 긴 판을 화면에 넣고
    // 맨 위에서 본다. 수리검 투표 중인 제안자 화면(누구를 기다리는지)도 같이 본다.
    for (const [name, device] of [['iPhone SE', devices['iPhone SE']], ['iPhone 13', devices['iPhone 13']]]) {
      const context = await browser.newContext(device);
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
      await page.addInitScript(() => {
        const Original = window.WebSocket;
        const Hooked = function (url) { const ws = new Original(url); window.__ws = ws; return ws; };
        Hooked.prototype = Original.prototype;
        Object.assign(Hooked, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
        window.WebSocket = Hooked;
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.fill('#nickname', '긴판');
      await page.press('#nickname', 'Enter');
      await page.click('.game-card.mind');
      await page.waitForSelector('#players .player', { timeout: 15000 });
      const names = ['김하늘', '박서준', '이도현', '최유나'];
      const long = (vote) => ({
        type: 'mindState', phase: 'playing', level: 8, levels: 8, lives: 2, stars: 1, maxLives: 5, maxStars: 3, reward: 'life',
        pile: Array.from({ length: 12 }, (_, i) => ({ value: 2 + i })),
        discarded: Array.from({ length: 10 }, (_, i) => ({ value: 3 + i, owner: names[i % 4], reason: 'mistake' })),
        lastEvent: { kind: 'mistake', text: '실수! 57보다 작은 카드: 김하늘 40, 44 / 박서준 51 → 목숨 1개를 잃었습니다' },
        pauseReason: null, result: null, history: [{ text: '레벨 8을 시작합니다.' }], minPlayers: 2, maxPlayers: 4, readyCount: 0, canStart: false,
        starVote: vote ? { id: 'v1', byName: '박서준', agreed: 2, total: 4, yourVote: true, waitingFor: ['이도현', '최유나'] } : null,
        you: { id: 'me', ready: false, focused: true, inGame: true, hand: [10, 18, 26, 34, 42, 50, 58, 66] },
        players: names.map((n, i) => ({ id: i === 1 ? 'me' : `p${i}`, nickname: n, connected: true, ready: false, inGame: true, focused: true, cardCount: 8, hand: null })),
      });
      const seen = await page.evaluate(([s, v]) => {
        window.__ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(s) }));
        window.scrollTo(0, 0);
        const box = document.getElementById('play').getBoundingClientRect();
        const inView = box.top >= 0 && box.bottom <= innerHeight + 1;
        window.__ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(v) }));
        return { inView, bottom: Math.round(box.bottom), height: innerHeight, message: document.getElementById('message').textContent };
      }, [long(false), long(true)]);
      check(`폰(${name}): 레벨 8에 판이 길어도 맨 위에서 "카드 내기"가 화면 안에 있다`, seen.inView, JSON.stringify(seen));
      check(`폰(${name}): 수리검을 제안한 사람에게 누구를 기다리는지 보인다`, /동의 2\/4명/.test(seen.message) && /이도현, 최유나님을 기다리는 중/.test(seen.message), seen.message);
      await context.close();
    }

    // [리뷰] 상태를 손으로 넣어 순서를 정한다. 서버에서 오는 진짜 메시지는 막고(__quiet), 보내는 것도 막는다.
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`주입: ${e}`));
      await page.addInitScript(() => {
        const Original = window.WebSocket;
        const Hooked = function (url) {
          const ws = new Original(url);
          window.__ws = ws;
          // onmessage보다 먼저 붙는다. 조용히 모드에서는 서버에서 온 진짜 메시지(isTrusted)를 여기서 멈춘다.
          ws.addEventListener('message', (e) => { if (window.__quiet && e.isTrusted) e.stopImmediatePropagation(); });
          const send = ws.send.bind(ws);
          ws.send = (data) => { if (!window.__quiet) send(data); };
          return ws;
        };
        Hooked.prototype = Original.prototype;
        Object.assign(Hooked, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
        window.WebSocket = Hooked;
        window.__deliver = (s) => window.__ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(s) }));
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.fill('#nickname', '주입');
      await page.press('#nickname', 'Enter');
      await page.click('.game-card.mind');
      await page.waitForSelector('#players .player', { timeout: 15000 });
      await page.evaluate(() => { window.__quiet = true; });
      const state = (over) => Object.assign({
        type: 'mindState', phase: 'playing', level: 3, levels: 10, lives: 2, stars: 1, maxLives: 5, maxStars: 3, reward: null,
        pile: [], discarded: [], lastEvent: null, pauseReason: null, result: null, history: [], minPlayers: 2, maxPlayers: 4,
        readyCount: 0, canStart: false, starVote: null,
        you: { id: 'me', ready: false, focused: true, inGame: true, hand: [20, 40, 60] },
        players: [
          { id: 'me', nickname: '주입', connected: true, ready: false, inGame: true, focused: true, cardCount: 3, hand: null },
          { id: 'p2', nickname: '상대', connected: true, ready: false, inGame: true, focused: true, cardCount: 1, hand: null },
        ],
      }, over);
      const mistake = (seq, lost) => ({ seq, kind: 'mistake', text: '실수!', played: { byId: 'p2', by: '상대', value: 50 }, lost: [{ id: 'me', nickname: '주입', cards: lost }] });
      const deliver = (s) => page.evaluate((x) => window.__deliver(x), s);
      const settle = () => page.evaluate(() => { document.querySelectorAll('.mind-fx').forEach((l) => { l.textContent = ''; }); });
      // 손패 카드에 거는 WAAPI(당기기)와 손패 위치 재기를 센다.
      await page.evaluate(() => {
        window.__handAnim = [];
        window.__handRects = 0;
        const animate = Element.prototype.animate;
        Element.prototype.animate = function () {
          if (this.closest && this.closest('#hand')) window.__handAnim.push(this.getAttribute('data-value'));
          return animate.apply(this, arguments);
        };
        const rect = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () {
          if (this.matches && this.matches('#hand .card')) window.__handRects += 1;
          return rect.apply(this, arguments);
        };
      });
      const counters = () => page.evaluate(() => ({ anim: window.__handAnim.slice(), rects: window.__handRects }));
      const reset = () => page.evaluate(() => { window.__handAnim = []; window.__handRects = 0; });

      // 1) 서버가 새로 떠 사건 번호가 1부터 다시 시작해도 첫 실수를 연출한다.
      await deliver(state({ lastEvent: { seq: 900, kind: 'levelUp', text: '레벨 2 통과' } }));
      await deliver(state({ lastEvent: null })); // 새로 뜬 서버 - 사건 없음
      await deliver(state({ lastEvent: mistake(1, [20]), pile: [{ value: 50, byId: 'p2', by: '상대' }], you: { id: 'me', ready: false, focused: true, inGame: true, hand: [40, 60] } }));
      const torn = await page.waitForFunction(() => document.querySelectorAll('.mind-fx .card').length > 0, null, { timeout: 2000 }).then(() => true, () => false);
      check('서버가 새로 떠 사건 번호가 1부터 다시 세도 첫 실수를 연출한다', torn);
      await wait(1200);
      await settle();

      // 2) 손패 위치는 연출에 쓸 때만 잰다: 남이 집중을 바꾼 상태에서는 재지 않는다.
      const base = state({ lastEvent: mistake(1, [20]), pile: [{ value: 50, byId: 'p2', by: '상대' }], you: { id: 'me', ready: false, focused: true, inGame: true, hand: [40, 60] } });
      await reset();
      await deliver(Object.assign({}, base, { players: base.players.map((p) => (p.id === 'p2' ? Object.assign({}, p, { focused: false }) : p)) }));
      const quietRects = (await counters()).rects;
      await deliver(Object.assign({}, base, { pile: base.pile.concat({ value: 55, byId: 'p2', by: '상대' }) }));
      const landRects = (await counters()).rects;
      check('상관없는 상태에서는 손패 위치를 재지 않는다(레이아웃을 강제로 다시 계산하지 않는다)', quietRects === 0 && landRects > 0, `상관없는 상태 ${quietRects}번, 카드가 나왔을 때 ${landRects}번`);
      await wait(600);

      // 3) 같은 레벨 실수는 남은 카드를 당기고, 실수로 레벨이 끝나 새 패를 받으면 같은 숫자여도 당기지 않는다.
      const pile2 = [{ value: 50, byId: 'p2', by: '상대' }, { value: 55, byId: 'p2', by: '상대' }];
      await deliver(state({ lastEvent: mistake(1, [20]), pile: pile2, you: { id: 'me', ready: false, focused: true, inGame: true, hand: [30, 40, 60, 70] } }));
      await wait(300);
      await reset();
      await deliver(state({ lastEvent: mistake(3, [30]), pile: pile2.concat({ value: 57, byId: 'p2', by: '상대' }), you: { id: 'me', ready: false, focused: true, inGame: true, hand: [40, 60, 70] } }));
      await wait(1600);
      const pulled = (await counters()).anim;
      check('같은 레벨 실수: 찢긴 뒤 남은 카드를 제자리로 당긴다(비교 기준)', pulled.length > 0, pulled.join(','));
      await settle();
      await reset();
      await deliver(state({
        level: 4, phase: 'focus', pile: [], lastEvent: mistake(4, [40, 60, 70]),
        you: { id: 'me', ready: false, focused: false, inGame: true, hand: [40, 72, 88, 95] },
      }));
      await wait(1600);
      const newLevel = (await counters()).anim;
      check('실수로 레벨이 끝나 새 패를 받으면 같은 숫자 카드라도 옛 자리에서 당기지 않는다', newLevel.length === 0, newLevel.join(','));
      await settle();

      // 4) 눌림 잠금은 내 요청이 반영된 상태가 와야 풀린다. 남의 상태가 먼저 와도 풀리지 않는다.
      const focusState = (mine, theirs) => state({
        level: 4, phase: 'focus', pile: [], lastEvent: mistake(4, [40, 60, 70]),
        you: { id: 'me', ready: false, focused: mine, inGame: true, hand: [40, 72, 88, 95] },
        players: [
          { id: 'me', nickname: '주입', connected: true, ready: false, inGame: true, focused: mine, cardCount: 4, hand: null },
          { id: 'p2', nickname: '상대', connected: true, ready: false, inGame: true, focused: theirs, cardCount: 4, hand: null },
        ],
      });
      await deliver(focusState(false, false));
      const lock = await page.evaluate((other) => {
        const f = document.getElementById('focus');
        f.click();
        const pressed = f.disabled && f.classList.contains('sending');
        window.__deliver(other); // 상대가 먼저 집중했다 - 내 요청은 아직 반영 전
        return { pressed, held: f.disabled && f.classList.contains('sending') };
      }, focusState(false, true));
      await deliver(focusState(true, true));
      const released = await page.evaluate(() => { const f = document.getElementById('focus'); return { disabled: f.disabled, sending: f.classList.contains('sending'), text: f.textContent }; });
      check('눌림 잠금: 남의 상태가 먼저 와도 풀리지 않는다(두 번 누른 것이 나가지 않는다)', lock.pressed && lock.held, JSON.stringify(lock));
      check('눌림 잠금: 내 요청이 반영된 상태가 오면 풀린다', !released.disabled && !released.sending && released.text === '집중 취소', JSON.stringify(released));
      await context.close();
    }
    check('브라우저 오류·CSP 위반 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
    console.error = original;
  }
  console.log(`\n더 마인드 화면: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
