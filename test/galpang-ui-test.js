'use strict';

/**
 * 갈팡질팡 화면(public/galpang.html) - 실제 브라우저로 한 판을 따라간다.
 *
 *   - 포털에 채널이 있고 누르면 입장한다. 후보 16개, 힌트 1개, 라운드 1/5로 시작한다
 *   - 후보를 눌러 고르고(다시 누르면 해제), 선택한 후보 제거 / 정답 제출 버튼이 선택 수에 맞게 켜진다
 *   - 제거한 후보는 흐려지고 눌 수 없다. 오답은 "오답" 표시가 붙고 라운드는 그대로다
 *   - 다음 라운드를 누르면 힌트가 하나 늘고, 마지막 라운드에서는 한 번 더 묻는다
 *   - 정답을 맞히면 정답 칸이 표시되고 힌트 해설이 나온다. 끝나기 전에는 정답·해설이 화면(DOM)에 없다
 *   - 포기는 확인 창을 거친다(계속하기 / 종료). 포기하면 정답은 나오지 않는다
 *   - 새로고침해도 진행 중이던 판이 그대로다. 다시 시작하면 새 판이다
 *   - 명령어 입력칸으로도 같은 조작이 된다(remove·help·잘못된 명령)
 *   - 폰(375px)에서 가로로 넘치지 않고, 후보 16개가 모두 화면 폭 안에 들어오며, 조작부가 보인다
 *   - 보스 키(우클릭)로 가려지고 Esc로 돌아온다. 브라우저 오류·CSP 위반 없음
 *
 * 실행: node test/galpang-ui-test.js
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
  const port = 4623;
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
    await page.waitForSelector('.game-card.galpang');
    page.context_ = context;
    return page;
  }
  const open = async (page) => {
    await page.click('.game-card.galpang');
    await page.waitForSelector('#grid .cand', { timeout: 15000 });
    await wait(200);
  };
  const cand = (page, id) => page.locator(`#grid .cand[data-id="${id}"]`);
  const text = (page, sel) => page.textContent(sel);
  const snapshot = (page) => page.evaluate(() => ({
    round: document.getElementById('round').textContent,
    hints: document.querySelectorAll('#hints .hint-card').length,
    removed: [...document.querySelectorAll('#grid .cand.removed')].map((el) => Number(el.dataset.id)),
    wrong: [...document.querySelectorAll('#grid .cand.wrong')].map((el) => Number(el.dataset.id)),
    status: document.body.dataset.status,
    names: [...document.querySelectorAll('#grid .cand')].map((el) => el.textContent.replace(/^\d+/, '').replace(' (제거됨)', '')),
    chip: document.getElementById('status-chip').textContent,
  }));

  try {
    const page = await enter('김하늘');
    check('포털에 갈팡질팡 채널이 있다', await page.isVisible('.game-card.galpang') && /갈팡질팡/.test(await text(page, '.game-card.galpang b')));
    await open(page);
    check('입장하면 갈팡질팡 화면이다', (await page.title()) === '갈팡질팡' && await page.isVisible('#grid'));
    let s = await snapshot(page);
    check('시작: 후보 16개, 힌트 1개, 라운드 1 / 5, 후보 16개 남음', s.names.length === 16 && s.hints === 1 && s.round === '1 / 5' && s.chip === '후보 16개' && s.status === 'PLAYING', JSON.stringify(s));
    check('후보 이름이 모두 다르다', new Set(s.names).size === 16);
    const hintText = await text(page, '#hints');
    check('힌트 칸에 A·B 선택지와 "정답에 더 가까운 쪽"이 보인다', /ROUND 1/.test(hintText) && /정답에 더 가까운 쪽: [AB]/.test(hintText) && (await page.locator('#hints .hint-option.picked').count()) === 1);

    // ── 정답은 끝나기 전에 화면에 없다 ──
    const html = await page.content();
    check('게임 중 화면(DOM)에 정답·해설 문구가 없다', !/정답: |더 가까운 개념으로 판단했습니다|class="cand[^"]*answer/.test(html) && !(await page.locator('#result:visible').count()));
    const dom = await page.evaluate(() => JSON.stringify([...document.querySelectorAll('[data-answer],[data-reason]')].length));
    check('화면에 정답을 암시하는 속성이 없다', dom === '0');

    // ── 고르기 ──
    check('처음에는 제거·정답 제출 버튼이 꺼져 있다', await page.isDisabled('#remove') && await page.isDisabled('#guess'));
    await cand(page, 3).click();
    check('후보를 누르면 선택되고(aria-pressed) 제거·정답 제출이 켜진다', await cand(page, 3).getAttribute('aria-pressed') === 'true' && !(await page.isDisabled('#remove')) && !(await page.isDisabled('#guess')));
    await cand(page, 5).click();
    check('두 개를 고르면 제거는 되고(2) 정답 제출은 꺼진다(정답은 하나만)', /후보 제거 \(2\)/.test(await text(page, '#remove')) && await page.isDisabled('#guess'));
    await cand(page, 5).click();
    check('다시 누르면 선택이 풀린다', await cand(page, 5).getAttribute('aria-pressed') === 'false' && /후보 제거 \(1\)/.test(await text(page, '#remove')));
    await cand(page, 5).click(); await cand(page, 8).click();
    await page.click('#remove');
    await wait(300);
    s = await snapshot(page);
    check('후보 제거: 3·5·8이 제거 표시, 남은 후보 13개, 선택이 비워진다', JSON.stringify(s.removed) === '[3,5,8]' && s.chip === '후보 13개' && await page.isDisabled('#remove'), JSON.stringify(s));
    check('제거 직후 "3번 제거 · 5번 제거 · 8번 제거" 안내가 보인다', /3번 제거 · 5번 제거 · 8번 제거/.test(await text(page, '#notice')), await text(page, '#notice'));
    check('제거한 후보는 눌 수 없다', await cand(page, 3).isDisabled());
    await cand(page, 3).click({ force: true }).catch(() => {});
    check('눌러도 선택되지 않는다', await cand(page, 3).getAttribute('aria-pressed') === 'false');

    // ── 오답 ──
    await cand(page, 1).click();
    await page.click('#guess');
    await wait(300);
    s = await snapshot(page);
    const wrongNow = s.status === 'PLAYING';
    check('정답 제출이 틀리면 "오답" 표시, 안내 문구, 라운드는 그대로다', !wrongNow || (JSON.stringify(s.wrong) === '[1]' && /오답입니다\./.test(await text(page, '#notice')) && s.round === '1 / 5'), JSON.stringify(s) + await text(page, '#notice'));

    // ── 다음 라운드 ──
    if (wrongNow) {
      await page.click('#next');
      await wait(300);
      s = await snapshot(page);
      check('다음 라운드: 힌트가 2개, 라운드 2 / 5, 제거 상태 유지', s.hints === 2 && s.round === '2 / 5' && JSON.stringify(s.removed) === '[3,5,8]', JSON.stringify(s));
      check('새 힌트 안내가 나오고 새 힌트가 강조된다', /ROUND 2 힌트가 나왔습니다/.test(await text(page, '#notice')) && (await page.locator('#hints .hint-card.latest').count()) === 1 && /ROUND 2/.test(await text(page, '#hints .hint-card.latest')));

      // 새로고침: 진행 중이던 판 그대로
      await page.reload();
      await page.waitForSelector('#grid .cand');
      await wait(400);
      const after = await snapshot(page);
      check('새로고침해도 같은 판이다(후보 순서·제거·오답·라운드·힌트)', JSON.stringify(after) === JSON.stringify(s), JSON.stringify(after));
      check('새로고침했을 때 지난 결과 안내를 다시 띄우지 않는다', (await text(page, '#notice')) === '');
    }

    // ── 명령어 입력 ──
    await page.click('#console summary');
    await page.fill('#command', 'remove 12');
    await page.press('#command', 'Enter');
    await wait(300);
    check('명령어 입력: remove 12가 반영되고 기록에 남는다', (await snapshot(page)).removed.includes(12) && /> remove 12\n12번 제거/.test(await text(page, '#log')), await text(page, '#log'));
    check('입력칸은 보낸 뒤 비워진다', (await page.inputValue('#command')) === '');
    await page.fill('#command', 'help');
    await page.press('#command', 'Enter');
    await wait(250);
    check('명령어 입력: help → 도움말이 기록에 나온다', /사용 가능한 명령어/.test(await text(page, '#log')));
    await page.fill('#command', '엉터리');
    await page.press('#command', 'Enter');
    await wait(250);
    check('잘못된 명령어는 안내가 기록에 나오고 판은 그대로다', /알 수 없는 명령어입니다\./.test(await text(page, '#log')) && (await snapshot(page)).status === 'PLAYING');
    await page.fill('#command', 'remove 99');
    await page.press('#command', 'Enter');
    await wait(250);
    check('범위 밖 번호는 안내한다', /잘못된 후보 번호입니다\./.test(await text(page, '#log')));
    await page.fill('#command', 'list all');
    await page.press('#command', 'Enter');
    await wait(250);
    check('list all: 전체 후보와 [제거됨]이 기록에 나온다', /\[전체 후보\]/.test(await text(page, '#log')) && /\[제거됨\]/.test(await text(page, '#log')));
    await page.click('#console summary');

    // ── 포기 ──
    await page.click('#quit');
    await wait(250);
    check('포기를 누르면 확인 창이 뜬다', await page.isVisible('#quit-confirm'));
    await page.click('#quit-no');
    await wait(250);
    check('계속하기를 누르면 확인 창이 닫히고 게임이 이어진다', !(await page.isVisible('#quit-confirm')) && (await snapshot(page)).status === 'PLAYING');
    await page.click('#quit');
    await wait(200);
    await page.keyboard.press('Escape');
    await wait(250);
    check('Esc는 포기 확인을 취소한다', !(await page.isVisible('#quit-confirm')) && (await snapshot(page)).status === 'PLAYING');
    await page.click('#quit');
    await wait(200);
    await page.click('#quit-yes');
    await wait(300);
    check('포기하면 종료 화면이 나오고 정답은 공개하지 않는다', (await snapshot(page)).status === 'QUIT' && /게임을 종료했습니다/.test(await text(page, '#result')) && !/정답: /.test(await text(page, '#result')));
    check('종료 후에는 다시 시작 / 게임 선택으로만 보이고 후보는 눌 수 없다', await page.isVisible('#restart') && !(await page.isVisible('#live-controls')) && (await page.locator('#grid .cand:not([disabled])').count()) === 0);
    await page.click('#restart');
    await wait(400);
    s = await snapshot(page);
    check('다시 시작하면 새 판이다(제거·오답 없음, 힌트 1개, 라운드 1)', s.status === 'PLAYING' && s.removed.length === 0 && s.wrong.length === 0 && s.hints === 1 && s.round === '1 / 5' && s.chip === '후보 16개', JSON.stringify(s));

    // ── 마지막 라운드와 패배 ──
    for (let i = 0; i < 4; i += 1) { await page.click('#next'); await wait(120); }
    check('ROUND 5: 버튼 글자가 "마지막 라운드 끝내기"로 바뀌고 힌트가 5개다', /마지막 라운드 끝내기/.test(await text(page, '#next')) && (await snapshot(page)).hints === 5 && (await snapshot(page)).round === '5 / 5');
    await page.click('#next');
    await wait(200);
    check('마지막 라운드에서 넘어가려 하면 한 번 더 묻는다(바로 끝나지 않는다)', await page.isVisible('#next-confirm') && (await snapshot(page)).status === 'PLAYING');
    await page.click('#next-no');
    check('"더 생각하기"를 누르면 닫히고 계속된다', !(await page.isVisible('#next-confirm')) && (await snapshot(page)).status === 'PLAYING');
    await page.click('#next');
    await page.click('#next-yes');
    await wait(400);
    s = await snapshot(page);
    const resultText = await text(page, '#result');
    check('끝내면 게임 종료: 정답과 5개 힌트 해설이 나온다', s.status === 'LOST' && /게임 종료/.test(resultText) && /정답: \S/.test(resultText) && (await page.locator('#result li').count()) === 5, resultText.slice(0, 120));
    const answerName = (resultText.match(/정답: (.+?)5라운드|정답: (\S+)/) || [])[1];
    check('정답 칸이 후보 판에 표시된다', (await page.locator('#grid .cand.answer').count()) === 1, String(answerName));
    check('해설이 "~쪽이 ~보다 더 가까운 개념으로 판단했습니다"로 나온다', (await page.locator('#result li span').allTextContents()).every((t) => /쪽이 '.+'보다 더 가까운 개념으로 판단했습니다\.$/.test(t)));

    // ── 정답 맞히기(오답을 계속 내도 끝나지 않는다는 명세 그대로) ──
    await page.click('#restart');
    await wait(400);
    for (let id = 1; id <= 16; id += 1) {
      if ((await snapshot(page)).status !== 'PLAYING') break;
      await cand(page, id).click();
      await page.click('#guess');
      await wait(120);
    }
    await wait(250);
    s = await snapshot(page);
    const won = await text(page, '#result');
    check('정답을 맞히면 "정답입니다!"와 정답 이름이 나온다', s.status === 'WON' && /정답입니다!/.test(won) && /정답: \S/.test(won), won.slice(0, 100));
    check('이긴 화면: 정답 칸 표시, 라운드 수, 해설 1개(공개된 힌트만)', (await page.locator('#grid .cand.answer').count()) === 1 && /1라운드 만에 성공했습니다/.test(won) && (await page.locator('#result li').count()) === 1);
    check('이긴 뒤에는 후보를 누를 수 없고 다시 시작만 보인다', await page.isVisible('#restart') && (await page.locator('#grid .cand:not([disabled]):not(.answer)').count()) === 0);
    const pageContext = page.context_;
    await pageContext.close();

    // ── 보스 키 ──
    {
      const boss = await enter('보스키');
      await open(boss);
      await boss.mouse.click(640, 300, { button: 'right' });
      await wait(300);
      check('보스 키(우클릭)로 화면이 가려진다', await boss.evaluate(() => !!document.getElementById('boss-cover')));
      await boss.keyboard.press('Escape');
      await wait(200);
      check('Esc로 돌아온다', !(await boss.evaluate(() => !!document.getElementById('boss-cover'))) && (await boss.isVisible('#grid')));
      await boss.context_.close();
    }

    // ── 포털 인원 ──
    {
      const a = await enter('가나');
      await open(a);
      const portal = await enter('다라');
      await wait(500);
      check('포털의 갈팡질팡 카드에 인원과 진행 상태가 나온다', /진행중/.test(await text(portal, '#galpang-status')) && /^[1-9]\d*명$/.test(await text(portal, '#galpang-count')), `${await text(portal, '#galpang-status')} ${await text(portal, '#galpang-count')}`);
      await a.context_.close(); await portal.context_.close();
    }

    // ── 폰 ──
    for (const [name, device] of [['iPhone SE', devices['iPhone SE']], ['iPhone 13', devices['iPhone 13']], ['Galaxy S9+', devices['Galaxy S9+']]]) {
      const phone = await enter('폰', device);
      await open(phone);
      const layout = await phone.evaluate(() => {
        const cells = [...document.querySelectorAll('#grid .cand')].map((el) => el.getBoundingClientRect());
        const controls = document.getElementById('live-controls').getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          cellsInside: cells.every((r) => r.left >= 0 && r.right <= innerWidth + 1),
          columns: new Set(cells.map((r) => Math.round(r.left))).size,
          controlsInView: controls.bottom <= innerHeight + 1 && controls.top >= 0,
          tall: Math.min(...cells.map((r) => r.height)),
        };
      });
      check(`폰(${name}): 가로로 넘치지 않는다`, !layout.overflow, JSON.stringify(layout));
      check(`폰(${name}): 후보 16개가 4열로 화면 폭 안에 들어온다`, layout.cellsInside && layout.columns === 4, JSON.stringify(layout));
      check(`폰(${name}): 후보 칸이 손가락으로 누를 만한 높이다(56px 이상)`, layout.tall >= 56, String(layout.tall));
      check(`폰(${name}): 조작 버튼이 화면 아래에 보인다`, layout.controlsInView, JSON.stringify(layout));
      await phone.tap('#grid .cand[data-id="2"]');
      await phone.tap('#remove');
      await wait(300);
      check(`폰(${name}): 탭으로 고르고 제거할 수 있다`, (await snapshot(phone)).removed.join() === '2');
      await phone.tap('#next');
      await wait(300);
      const strip = await phone.evaluate(() => { const el = document.getElementById('hints'); return { cards: el.children.length, scrollable: el.scrollWidth > el.clientWidth, atEnd: Math.abs(el.scrollLeft + el.clientWidth - el.scrollWidth) < 4 }; });
      check(`폰(${name}): 힌트 기록은 옆으로 넘기는 띠이고 새 힌트가 나오면 끝으로 간다`, strip.cards === 2 && strip.atEnd, JSON.stringify(strip));
      const overflowAfter = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      check(`폰(${name}): 라운드가 올라도 가로로 넘치지 않는다`, !overflowAfter);
      await phone.context_.close();
    }

    check('브라우저 오류·CSP 위반 없음', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
    console.error = original;
  }
  console.log(`\n갈팡질팡 화면: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
