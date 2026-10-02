'use strict';

/**
 * 갈팡질팡 화면(public/galpang.html) - 실제 브라우저로 한 판을 따라간다.
 *
 * [혼자] 혼자 접속하면 준비 없이 바로 시작하고, 조작은 바로 실행된다(접속자 한 명이 곧 과반수).
 *   - 포털에 채널이 있고 누르면 입장한다. 대기실에서 게임 시작을 누르면 후보 16개, 힌트 1개, 라운드 1/5로 시작한다
 *   - 후보를 눌러 고르고(다시 누르면 해제), 선택한 후보 제거 / 정답 제출 버튼이 선택 수에 맞게 켜진다
 *   - 제거한 후보는 흐려지고 눌 수 없다. 다음 라운드를 누르면 힌트가 하나 늘고, 마지막 라운드에서는 한 번 더 묻는다
 *   - 정답 제출은 한 번뿐: 누르면 확인 창이 뜨고(다시 고르기·Esc로 취소), 제출해서 틀리면 그 자리에서 게임이 끝나며
 *     정답이 공개된다. 맞히면 정답 칸이 표시되고 힌트 해설이 나온다
 *   - 정답 후보를 지워도 그 자리에서 끝난다(하나만 지울 때도, 16개를 다 지울 때도)
 *   - 끝나기 전에는 정답·해설이 화면(DOM)에 없다. 포기는 확인 창을 거친다. 새로고침해도 진행 중이던 판이 그대로다
 *   - 명령어 입력칸으로도 같은 조작이 된다. 폰(375px)에서 가로로 넘치지 않고 조작부가 보인다
 *   - 보스 키(우클릭)로 가려지고 Esc로 돌아온다
 * [여럿] 참가자 목록에 들어온 사람이 보이고, 준비 → 게임 시작(시작 전 확인 창)으로 같이 한다.
 *   - 후보 제거·정답 제출·다음 라운드·포기는 제안이 되어 다른 참가자에게 찬반 창이 뜨고, 과반수가 동의해야 실행된다
 *   - 반대가 많으면 취소되고, 구경하는 사람은 판을 보되 조작하지 못한다. 끝난 뒤 다시 준비해서 시작한다
 *   - 폰에서도 투표 창이 화면 안에 들어오고 탭으로 투표할 수 있다
 * 브라우저 오류·CSP 위반 없음
 *
 * 실행: node test/galpang-ui-test.js
 */

const { chromium, devices } = require('playwright');
const { createGameServer } = require('../web/game-server');
const { GameEngine } = require('../web/galpang/engine');

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
  // 테스트에서만: 방의 판을 고정한다. 정답 제출은 한 번뿐이고 정답을 지워도 끝나서, 정답을 맞히거나 지우는
  // 길을 보려면 정답을 알아야 한다. 방에 있는 모두가 나가면 방이 처음으로 돌아가므로(판 수도 0부터), 한 장면의
  // 첫 판은 `7`, 다음 판은 `7#1`, `7#2`…이다(web/galpang-room.js).
  // 첫 판이 지우는 번호(2·3·5·8·12)에 정답이 없는 seed를 고른다 - 정답 후보를 지우면 게임이 끝나므로.
  // 올려 가며 찾으니, 데이터가 바뀌어 정답이 달라져도 시험이 깨지지 않는다.
  const SEED = (() => { for (let c = 7; ; c += 1) if (![2, 3, 5, 8, 12].includes(new GameEngine({ seed: c }).state.answer.id)) return c; })();
  const answerOfGame = (index) => new GameEngine({ seed: index === 0 ? SEED : `${SEED}#${index}` }).state.answer;
  const wrongPick = (answerId, ...also) => Array.from({ length: 16 }, (_, i) => i + 1).find((id) => id !== answerId && !also.includes(id));
  const server = createGameServer({ port, host: '127.0.0.1', galpangSeed: SEED });
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
  /** 갈팡질팡 카드를 눌러 대기실에 들어간다. */
  const lobby = async (page) => {
    await page.click('.game-card.galpang');
    await page.waitForSelector('#players .player', { timeout: 15000 });
    await wait(200);
  };
  /** 혼자 접속해 있으면 준비 없이 시작한다. */
  const startAlone = async (page) => {
    await page.waitForSelector('#start:not([disabled])', { timeout: 15000 });
    await page.click('#start');
    await page.waitForSelector('#grid .cand', { timeout: 15000 });
    await wait(200);
  };
  const open = async (page) => { await lobby(page); await startAlone(page); };
  /** 방을 나가고(모두 나가면 방이 처음으로 돌아간다) 창을 닫는다. */
  const leaveAndClose = async (page) => {
    await page.click('#leave');
    await wait(500);
    await page.context_.close();
  };
  const restart = async (page) => { await page.click('#start'); await wait(400); }; // 혼자면 확인 창 없이 바로 시작한다
  const cand = (page, id) => page.locator(`#grid .cand[data-id="${id}"]`);
  const text = (page, sel) => page.textContent(sel);
  const submit = async (page, id) => { // 후보를 고르고 정답 제출 → 확인 창에서 제출
    await cand(page, id).click();
    await page.click('#guess');
    await page.click('#guess-yes');
    await wait(350);
  };
  const snapshot = (page) => page.evaluate(() => ({
    round: document.getElementById('round').textContent,
    hints: document.querySelectorAll('#hints .hint-card').length,
    removed: [...document.querySelectorAll('#grid .cand.removed')].map((el) => Number(el.dataset.id)),
    wrong: [...document.querySelectorAll('#grid .cand.wrong')].map((el) => Number(el.dataset.id)),
    status: document.body.dataset.status,
    names: [...document.querySelectorAll('#grid .cand')].map((el) => el.textContent.replace(/^\d+/, '').replace(' (제거됨)', '')),
    chip: document.getElementById('status-chip').textContent,
  }));
  const players = (page) => page.evaluate(() => [...document.querySelectorAll('#players .player')].map((el) => `${el.querySelector('b').textContent}|${el.querySelector('.status').textContent}`));

  try {
    // ══════════════ 혼자 ══════════════
    const page = await enter('김하늘');
    check('포털에 갈팡질팡 채널이 있다', await page.isVisible('.game-card.galpang') && /갈팡질팡/.test(await text(page, '.game-card.galpang b')));
    await lobby(page);
    check('입장하면 갈팡질팡 대기실이다(후보·힌트는 아직 없다)', (await page.title()) === '갈팡질팡' && await page.isVisible('#lobby') && (await page.locator('#grid .cand').count()) === 0 && (await page.locator('#hints .hint-card').count()) === 0
      && (await text(page, '#phase')) === '대기 중');
    check('참가자 목록에 내 이름이 나온다', JSON.stringify(await players(page)) === JSON.stringify(['김하늘 (나)|대기']), JSON.stringify(await players(page)));
    check('혼자라서 준비 버튼은 숨고 게임 시작이 바로 켜져 있다', !(await page.isVisible('#ready')) && !(await page.isDisabled('#start')) && /혼자/.test(await text(page, '#status-chip')) && /혼자 시작합니다/.test(await text(page, '#message')));
    check('대기실에는 규칙 안내(과반수 동의 설명 포함)가 보인다', /과반수/.test(await text(page, '#rules')) && await page.isVisible('#rules'));
    check('게임이 시작되기 전에는 후보 제거 같은 조작 버튼이 없다', !(await page.isVisible('#live-controls')));
    await startAlone(page);
    let s = await snapshot(page);
    check('시작: 후보 16개, 힌트 1개, 라운드 1 / 5, 후보 16개 남음', s.names.length === 16 && s.hints === 1 && s.round === '1 / 5' && s.chip === '후보 16개' && s.status === 'PLAYING', JSON.stringify(s));
    check('시작하면 대기실 버튼은 숨고 조작 버튼이 나온다', !(await page.isVisible('#lobby')) && await page.isVisible('#live-controls') && (await text(page, '#phase')) === '진행 중');
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
    check('혼자서는 후보 제거가 바로 된다: 3·5·8이 제거 표시, 남은 후보 13개, 선택이 비워진다', JSON.stringify(s.removed) === '[3,5,8]' && s.chip === '후보 13개' && await page.isDisabled('#remove') && !(await page.isVisible('#vote-modal')), JSON.stringify(s));
    check('제거 직후 "3번 제거 · 5번 제거 · 8번 제거" 안내가 보인다(동의 머리글은 없다)', (await text(page, '#notice')) === '3번 제거 · 5번 제거 · 8번 제거', await text(page, '#notice'));
    check('제거한 후보는 눌 수 없다', await cand(page, 3).isDisabled());
    await cand(page, 3).click({ force: true }).catch(() => {});
    check('눌러도 선택되지 않는다', await cand(page, 3).getAttribute('aria-pressed') === 'false');

    // ── 다음 라운드 ──
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
    check('새로고침한 뒤에도 같은 자리라 이름이 하나뿐이다(내 자리가 두 개로 늘지 않는다)', JSON.stringify(await players(page)) === JSON.stringify(['김하늘 (나)|참가']), JSON.stringify(await players(page)));

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
    check('종료 후에는 다시 시작 / 게임 선택으로만 보이고 후보는 눌 수 없다', await page.isVisible('#start') && /다시 시작/.test(await text(page, '#start')) && !(await page.isVisible('#live-controls')) && (await page.locator('#grid .cand:not([disabled])').count()) === 0);
    await restart(page);
    s = await snapshot(page);
    check('다시 시작하면 새 판이다(제거·오답 없음, 힌트 1개, 라운드 1)', s.status === 'PLAYING' && s.removed.length === 0 && s.wrong.length === 0 && s.hints === 1 && s.round === '1 / 5' && s.chip === '후보 16개', JSON.stringify(s));

    // ── 오답: 한 번이면 끝(1라운드) ──
    let gameIndex = 1; // 위의 포기 뒤 다시 시작으로 두 번째 판이다
    {
      const answer = answerOfGame(gameIndex);
      const wrong = wrongPick(answer.id);
      await cand(page, wrong).click();
      await page.click('#guess');
      await wait(150);
      check('정답 제출을 누르면 확인 창이 뜬다(바로 제출되지 않는다). 고른 후보가 적혀 있다', await page.isVisible('#guess-confirm') && (await text(page, '#guess-confirm-name')).includes(`${wrong}번`) && (await snapshot(page)).status === 'PLAYING', await text(page, '#guess-confirm-name'));
      check('확인 창에 "틀리면 바로 게임이 끝난다"고 적혀 있다(혼자라 동의 안내는 없다)', /틀리면 바로 게임이 끝나고 정답이 공개됩니다/.test(await text(page, '#guess-confirm')) && (await text(page, '#guess-confirm-vote')) === '' && (await text(page, '#guess-yes')) === '제출');
      await page.click('#guess-no');
      await wait(100);
      check('"다시 고르기"를 누르면 닫히고, 게임도 고른 후보도 그대로다', !(await page.isVisible('#guess-confirm')) && (await snapshot(page)).status === 'PLAYING' && await cand(page, wrong).getAttribute('aria-pressed') === 'true');
      await page.click('#guess');
      await wait(100);
      await page.keyboard.press('Escape');
      await wait(100);
      check('Esc도 제출을 취소한다(게임은 그대로)', !(await page.isVisible('#guess-confirm')) && (await snapshot(page)).status === 'PLAYING');
      await page.click('#guess');
      await wait(100);
      await page.click('#guess-yes');
      await wait(400);
      s = await snapshot(page);
      const lostText = await text(page, '#result');
      check('제출하면 그 자리에서 게임이 끝난다(LOST). 라운드는 그대로 1 / 5', s.status === 'LOST' && s.round === '1 / 5', JSON.stringify(s));
      check('결과: "오답입니다", 제출한 답, 정답 이름이 나온다', /오답입니다/.test(lostText) && lostText.includes(`제출한 답: ${wrong}번`) && lostText.includes(`정답: ${answer.name}`), lostText.slice(0, 160));
      check('낸 후보에 "오답", 정답 칸에 "정답" 표시가 붙는다', JSON.stringify(s.wrong) === `[${wrong}]` && (await page.locator('#grid .cand.answer').count()) === 1 && (await page.locator('#grid .cand.answer').getAttribute('data-id')) === String(answer.id));
      check('해설은 지금까지 공개된 힌트 1개뿐이다', (await page.locator('#result li').count()) === 1);
      check('상단 안내가 "틀린 답을 제출해서 게임이 끝났습니다."이다', /틀린 답을 제출해서 게임이 끝났습니다/.test(await text(page, '#message')) && (await text(page, '#phase')) === '실패');
      check('끝난 뒤에는 다시 시작 / 게임 선택으로만 보이고 후보를 누를 수 없다', await page.isVisible('#start') && !(await page.isVisible('#live-controls')) && (await page.locator('#grid .cand:not([disabled])').count()) === 0);
      await page.click('#console summary');
      await page.fill('#command', 'next');
      await page.press('#command', 'Enter');
      await wait(250);
      check('끝난 뒤 명령어를 보내도 종료 안내만 나오고 판은 그대로다(다음 라운드로 갈 수 없다)', /게임이 종료되었습니다\./.test(await text(page, '#log')) && (await snapshot(page)).status === 'LOST' && (await snapshot(page)).round === '1 / 5');
      await page.click('#console summary');
      await page.reload();
      await page.waitForSelector('#grid .cand');
      await wait(400);
      check('새로고침해도 끝난 판과 정답 공개가 그대로다', (await snapshot(page)).status === 'LOST' && (await text(page, '#result')).includes(`정답: ${answer.name}`));
    }

    // ── 오답: 3라운드에서 틀려도 그 자리에서 끝 ──
    await restart(page);
    gameIndex += 1;
    {
      const answer = answerOfGame(gameIndex);
      await page.click('#next'); await wait(150);
      await page.click('#next'); await wait(250);
      await submit(page, wrongPick(answer.id));
      s = await snapshot(page);
      const text3 = await text(page, '#result');
      check('3라운드에서 틀리면 3라운드에서 끝나고 해설은 힌트 3개다', s.status === 'LOST' && s.round === '3 / 5' && /3라운드에서 게임이 끝났습니다/.test(text3) && (await page.locator('#result li').count()) === 3 && text3.includes(`정답: ${answer.name}`), text3.slice(0, 140));
    }

    // ── 정답 후보를 지워도 그 자리에서 끝 ──
    await restart(page);
    gameIndex += 1;
    {
      const answer = answerOfGame(gameIndex);
      const spare = wrongPick(answer.id);
      await cand(page, spare).click();
      await page.click('#remove');
      await wait(300);
      s = await snapshot(page);
      check('정답이 아닌 후보를 지우면 게임은 이어진다(제거 표시만 생긴다)', s.status === 'PLAYING' && JSON.stringify(s.removed) === `[${spare}]` && s.round === '1 / 5', JSON.stringify(s));
      await cand(page, answer.id).click();
      await page.click('#remove');
      await wait(400);
      s = await snapshot(page);
      const erasedText = await text(page, '#result');
      check('정답 후보를 지우면 그 자리에서 게임이 끝난다(LOST). 라운드는 그대로 1 / 5', s.status === 'LOST' && s.round === '1 / 5', JSON.stringify(s));
      check('결과: "정답 후보를 지웠습니다", 지운 정답의 번호·이름이 나온다', /정답 후보를 지웠습니다/.test(erasedText) && erasedText.includes(`${answer.id}번 ${answer.name}`) && !/제출한 답/.test(erasedText), erasedText.slice(0, 140));
      check('지운 정답 칸이 "정답"으로 표시되고 글자가 읽힌다(흐리게 지워진 모양이 아니다)', (await page.locator('#grid .cand.answer').count()) === 1 && (await page.locator('#grid .cand.answer').getAttribute('data-id')) === String(answer.id)
        && s.removed.includes(answer.id) && (await page.locator('#grid .cand.answer').evaluate((el) => getComputedStyle(el).color)) === 'rgb(29, 28, 29)');
      check('해설은 공개된 힌트 1개뿐이고, 낸 오답 표시는 없다', (await page.locator('#result li').count()) === 1 && s.wrong.length === 0);
      check('상단 안내가 "정답 후보를 지워서 게임이 끝났습니다."이다', /정답 후보를 지워서 게임이 끝났습니다/.test(await text(page, '#message')) && (await text(page, '#phase')) === '실패');
    }

    // ── 후보를 모두 지우려 해도 끝난다(안 끝나고 멈춰 있지 않는다) ──
    await restart(page);
    gameIndex += 1;
    {
      const answer = answerOfGame(gameIndex);
      for (let id = 1; id <= 16; id += 1) await cand(page, id).click();
      check('16개를 모두 고르면 제거 버튼이 "후보 제거 (16)"이다', /후보 제거 \(16\)/.test(await text(page, '#remove')));
      await page.click('#remove');
      await wait(400);
      s = await snapshot(page);
      const allText = await text(page, '#result');
      check('후보를 전부 지워도 그 자리에서 끝나고 정답이 공개된다', s.status === 'LOST' && /정답 후보를 지웠습니다/.test(allText) && allText.includes(`${answer.id}번 ${answer.name}`) && s.removed.length === 16
        && (await page.locator('#grid .cand.answer').count()) === 1, JSON.stringify({ status: s.status, removed: s.removed.length }));
    }

    // ── 마지막 라운드와 패배(5라운드가 다 지나서 지는 경우) ──
    await restart(page);
    gameIndex += 1;
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
    check('끝내면 게임 종료: 정답과 5개 힌트 해설이 나온다(오답 안내는 없다)', s.status === 'LOST' && /게임 종료/.test(resultText) && /정답: \S/.test(resultText) && !/오답입니다|제출한 답/.test(resultText) && (await page.locator('#result li').count()) === 5, resultText.slice(0, 120));
    check('정답 칸이 후보 판에 표시되고, 낸 오답은 없다', (await page.locator('#grid .cand.answer').count()) === 1 && s.wrong.length === 0);
    check('해설이 "~쪽이 ~보다 더 가까운 개념으로 판단했습니다"로 나온다', (await page.locator('#result li span').allTextContents()).every((t) => /쪽이 '.+'보다 더 가까운 개념으로 판단했습니다\.$/.test(t)));

    // ── 정답 맞히기 ──
    await restart(page);
    gameIndex += 1;
    const winAnswer = answerOfGame(gameIndex);
    await submit(page, winAnswer.id);
    s = await snapshot(page);
    const won = await text(page, '#result');
    check('정답을 맞히면 "정답입니다!"와 정답 이름이 나온다', s.status === 'WON' && /정답입니다!/.test(won) && won.includes(`정답: ${winAnswer.name}`), won.slice(0, 100));
    check('이긴 화면: 정답 칸 표시, 라운드 수, 해설 1개(공개된 힌트만), 오답 표시 없음', (await page.locator('#grid .cand.answer').count()) === 1 && /1라운드 만에 성공했습니다/.test(won) && (await page.locator('#result li').count()) === 1 && s.wrong.length === 0);
    check('이긴 뒤에는 후보를 누를 수 없고 다시 시작만 보인다', await page.isVisible('#start') && (await page.locator('#grid .cand:not([disabled]):not(.answer)').count()) === 0);
    await leaveAndClose(page);

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
      await leaveAndClose(boss);
    }

    // ── 포털 인원 ──
    {
      const a = await enter('가나');
      await open(a);
      const portal = await enter('다라');
      await wait(500);
      check('포털의 갈팡질팡 카드에 인원과 진행 상태가 나온다', /진행중/.test(await text(portal, '#galpang-status')) && /^[1-9]\d*명$/.test(await text(portal, '#galpang-count')), `${await text(portal, '#galpang-status')} ${await text(portal, '#galpang-count')}`);
      await leaveAndClose(a);
      await wait(300);
      check('나가면 포털 인원이 0명이 된다', (await text(portal, '#galpang-count')) === '0명', await text(portal, '#galpang-count'));
      await portal.context_.close();
    }

    // ══════════════ 여럿이 ══════════════
    {
      const A = await enter('김하늘');
      await lobby(A);
      const B = await enter('박서준');
      await lobby(B);
      await wait(300);
      check('나중에 들어온 사람이 먼저 있던 사람 화면의 참가자 목록에 나타난다', JSON.stringify(await players(A)) === JSON.stringify(['김하늘 (나)|대기', '박서준|대기']) && JSON.stringify(await players(B)) === JSON.stringify(['김하늘|대기', '박서준 (나)|대기']), JSON.stringify([await players(A), await players(B)]));
      check('둘 이상이면 준비 버튼이 보이고, 준비한 사람이 없으면 게임 시작이 꺼져 있다', await A.isVisible('#ready') && await A.isDisabled('#start') && /준비한 참가자가 1명 이상/.test(await text(A, '#message')));
      await A.click('#ready');
      await wait(250);
      check('준비하면 버튼이 "준비 취소"로 바뀌고 두 화면 모두 목록에 "준비"로 보인다', (await text(A, '#ready')) === '준비 취소' && (await players(B))[0] === '김하늘|준비' && (await players(A))[0] === '김하늘 (나)|준비');
      check('준비한 사람이 있으면 게임 시작이 켜진다(구경할 사람도 시작할 수 있다)', !(await B.isDisabled('#start')));
      await B.click('#start');
      await wait(250);
      check('게임 시작을 누르면 준비 안 한 사람을 알려 주는 확인 창이 뜬다', await B.isVisible('#start-confirm') && /준비한 1명으로 시작할까요/.test(await text(B, '#start-confirm-title')) && /준비 안 함: 박서준/.test(await text(B, '#start-confirm-waiting')), await text(B, '#start-confirm'));
      await B.click('#start-cancel');
      await B.click('#ready');
      await wait(250);
      await A.click('#start');
      await wait(250);
      check('모두 준비하면 확인 창에 "모두 준비했습니다"가 나온다', await A.isVisible('#start-confirm') && /준비한 2명으로 시작할까요/.test(await text(A, '#start-confirm-title')) && /모두 준비했습니다/.test(await text(A, '#start-confirm-waiting')));
      await A.click('#start-go');
      await A.waitForSelector('#grid .cand');
      await B.waitForSelector('#grid .cand');
      await wait(300);
      const answer = answerOfGame(0);
      const [p, q, r] = Array.from({ length: 16 }, (_, i) => i + 1).filter((id) => id !== answer.id);
      check('시작하면 두 사람 모두 같은 판(후보 16개·힌트 1개)을 본다', JSON.stringify((await snapshot(A)).names) === JSON.stringify((await snapshot(B)).names) && (await snapshot(A)).names.length === 16 && (await snapshot(B)).hints === 1);
      check('두 사람 모두 조작 버튼이 있고 목록에 "참가"로 보인다', await A.isVisible('#live-controls') && await B.isVisible('#live-controls') && JSON.stringify(await players(B)) === JSON.stringify(['김하늘|참가', '박서준 (나)|참가']), JSON.stringify(await players(B)));
      check('안내에 "접속자 2명 중 2명 동의가 필요"라고 나온다', /접속자 2명 중 2명 동의가 필요합니다/.test(await text(A, '#message')), await text(A, '#message'));

      // ── 후보 제거는 상대의 동의를 받아야 한다 ──
      await cand(A, p).click(); await cand(A, q).click();
      await A.click('#remove');
      await wait(400);
      check('제안하면 제안한 사람 화면에는 투표 창이 없고, 기다리는 중임을 알린다(동의 1/2명)', !(await A.isVisible('#vote-modal')) && /내가 제안했습니다/.test(await text(A, '#message')) && /동의 1\/2명/.test(await text(A, '#message')) && /박서준님을 기다리는 중/.test(await text(A, '#message')), await text(A, '#message'));
      check('상대 화면에는 투표 창이 뜬다: 제안자·내용·동의 1/2명·과반수', await B.isVisible('#vote-modal') && /김하늘님이 제안했습니다/.test(await text(B, '#vote-title')) && (await text(B, '#vote-text')).startsWith('후보 제거 - ') && /동의 1\/2명/.test(await text(B, '#vote-count')) && /과반수\(2명\)/.test(await text(B, '#vote-count')), await text(B, '#vote-modal'));
      check('투표 창에 "정답을 지우면 바로 게임이 끝난다"는 경고가 있다', /정답을 지우면 바로 게임이 끝나고 정답이 공개됩니다/.test(await text(B, '#vote-warning')));
      check('아직 판은 그대로다(둘 다 후보 16개, 제안 대상 2개에 표시)', (await snapshot(A)).removed.length === 0 && (await snapshot(B)).removed.length === 0 && (await A.locator('#grid .cand.proposed').count()) === 2 && (await B.locator('#grid .cand.proposed').count()) === 2);
      check('참가자 목록에 찬성/투표 대기와 제안자가 보인다', JSON.stringify(await players(B)) === JSON.stringify(['김하늘|찬성', '박서준 (나)|투표 대기']) && /제안자/.test(await B.textContent('#players .player')), JSON.stringify(await players(B)));
      check('투표 중에는 제안 버튼이 모두 꺼진다(다른 제안을 겹쳐 낼 수 없다)', await A.isDisabled('#remove') && await A.isDisabled('#next') && await A.isDisabled('#quit') && await A.isDisabled('#guess'));
      await B.click('#vote-yes');
      await wait(400);
      check('상대가 동의하면 두 화면에서 모두 지워진다(후보 14개)', JSON.stringify((await snapshot(A)).removed) === JSON.stringify([p, q].sort((x, y) => x - y)) && (await snapshot(B)).chip === '후보 14개' && (await snapshot(A)).chip === '후보 14개');
      check('투표 창이 닫히고 통과 안내가 두 화면에 나온다', !(await B.isVisible('#vote-modal')) && (await text(A, '#notice')).startsWith('김하늘님의 제안이 통과됐습니다. (동의 2/2명)') && (await text(B, '#notice')).includes('통과됐습니다'), await text(B, '#notice'));
      check('기록에도 통과 머리글과 지운 후보가 남는다', /김하늘님의 제안이 통과됐습니다\. \(동의 2\/2명\)\n\d+번 제거/.test(await A.textContent('#log')), await A.textContent('#log'));

      // ── 반대하면 취소 ──
      await cand(B, r).click();
      await B.click('#remove');
      await wait(400);
      check('상대의 제안에는 내 화면에 투표 창이 뜬다', await A.isVisible('#vote-modal') && /박서준님이 제안했습니다/.test(await text(A, '#vote-title')));
      await A.click('#vote-no');
      await wait(400);
      check('반대하면 과반수가 될 수 없어 바로 취소된다(판 그대로, 창 닫힘, 취소 안내)', !(await A.isVisible('#vote-modal')) && (await snapshot(A)).chip === '후보 14개' && (await snapshot(B)).chip === '후보 14개' && /취소됐습니다/.test(await text(B, '#notice')) && /반대가 많아/.test(await text(A, '#notice')), `${await text(A, '#notice')} / ${await text(B, '#notice')}`);
      check('취소된 뒤에는 다시 제안할 수 있다(버튼이 다시 켜진다)', !(await A.isDisabled('#next')) && !(await B.isDisabled('#quit')));

      // ── 구경하는 사람 ──
      const C = await enter('최민아');
      await lobby(C);
      await wait(300);
      check('진행 중에 들어온 사람은 판을 구경한다(후보·힌트가 보이고 조작 버튼은 없다)', (await snapshot(C)).names.length === 16 && (await snapshot(C)).removed.length === 2 && !(await C.isVisible('#live-controls')) && !(await C.isVisible('#lobby')) && /구경하고 있습니다/.test(await text(C, '#message')), await text(C, '#message'));
      check('구경하는 사람은 후보를 고를 수 없고, 목록에 "구경"으로 보인다', (await C.locator('#grid .cand:not([disabled])').count()) === 0 && (await players(C)).some((x) => x === '최민아 (나)|구경'), JSON.stringify(await players(C)));
      check('다른 참가자 화면의 목록에도 구경꾼이 보인다', (await players(A)).some((x) => x === '최민아|구경'));
      await C.click('#console summary');
      await C.fill('#command', 'next');
      await C.press('#command', 'Enter');
      await wait(300);
      check('구경하는 사람이 명령어를 보내도 제안되지 않는다(오류 알림만)', (await snapshot(C)).round === '1 / 5' && !(await A.isVisible('#vote-modal')) && !(await B.isVisible('#vote-modal')));
      await C.click('#console summary');

      // ── 정답 제출도 동의를 받는다 ──
      await cand(A, answer.id).click();
      await A.click('#guess');
      await wait(150);
      check('정답 제출 확인 창에 "접속자 과반수의 동의를 받아 제출"한다는 안내가 있고 버튼이 "제안하기"다', /과반수\(2명\)의 동의를 받아 제출합니다/.test(await text(A, '#guess-confirm-vote')) && (await text(A, '#guess-yes')) === '제안하기', await text(A, '#guess-confirm-vote'));
      await A.click('#guess-yes');
      await wait(400);
      check('제안하면 상대에게 투표 창이 뜨고 게임은 아직 진행 중이다(정답은 화면에 없다)', await B.isVisible('#vote-modal') && /정답 제출/.test(await text(B, '#vote-kind')) && (await text(B, '#vote-text')).includes(`${answer.id}번`)
        && (await snapshot(A)).status === 'PLAYING' && (await snapshot(C)).status === 'PLAYING' && !(await C.isVisible('#result')) && !/정답: /.test(await C.content()));
      check('구경꾼 화면에도 진행 중인 제안이 보이지만 투표 창은 뜨지 않는다', !(await C.isVisible('#vote-modal')) && /제안했습니다/.test(await text(C, '#message')) && /김하늘님이 제안했습니다/.test(await text(C, '#message')), await text(C, '#message'));
      await B.click('#vote-yes');
      await wait(500);
      for (const [who, page_] of [['김하늘', A], ['박서준', B], ['구경꾼', C]]) {
        check(`동의하면 정답이 공개되고 모두의 화면이 끝난다(${who}): 정답입니다·정답 이름`, (await snapshot(page_)).status === 'WON' && /정답입니다!/.test(await text(page_, '#result')) && (await text(page_, '#result')).includes(`정답: ${answer.name}`));
      }
      check('끝나면 대기실 버튼이 나오고 모두 "대기"로 돌아간다(다시 준비해야 한다)', await A.isVisible('#lobby') && !(await A.isVisible('#live-controls')) && (await text(A, '#start')) === '다시 시작' && await A.isDisabled('#start')
        && (await players(A)).every((x) => x.endsWith('|대기')), JSON.stringify(await players(A)));
      check('끝난 뒤 안내가 "다시 하려면 준비를 눌러 주세요"다', /정답을 맞혔습니다/.test(await text(A, '#message')) && /준비를 눌러 주세요/.test(await text(A, '#message')));

      // ── 다시 준비해서 시작: 구경꾼도 준비하면 함께 한다 ──
      await A.click('#ready'); await B.click('#ready'); await C.click('#ready');
      await wait(300);
      await A.click('#start');
      await wait(250);
      check('시작 확인 창에 준비한 3명이 나온다', /준비한 3명으로 시작할까요/.test(await text(A, '#start-confirm-title')) && /모두 준비했습니다/.test(await text(A, '#start-confirm-waiting')));
      await A.click('#start-go');
      await C.waitForSelector('#live-controls:not(.hidden)');
      await wait(300);
      check('이번에는 세 사람 모두 참가자다(조작 버튼이 있고 후보 16개·새 판)', await C.isVisible('#live-controls') && (await snapshot(C)).names.length === 16 && (await snapshot(C)).removed.length === 0 && (await snapshot(A)).status === 'PLAYING'
        && JSON.stringify(await players(C)) === JSON.stringify(['김하늘|참가', '박서준|참가', '최민아 (나)|참가']), JSON.stringify(await players(C)));
      check('안내가 3명 중 2명 동의로 바뀐다', /접속자 3명 중 2명 동의가 필요합니다/.test(await text(A, '#message')), await text(A, '#message'));

      // 3명: 2명이 동의하면 세 번째가 투표하기 전에 실행된다
      await A.click('#next');
      await wait(400);
      check('다음 라운드 제안: 나머지 두 사람에게 투표 창이 뜬다', await B.isVisible('#vote-modal') && await C.isVisible('#vote-modal') && /다음 라운드로 넘어가기/.test(await text(B, '#vote-text')) && /동의 1\/3명/.test(await text(B, '#vote-count')) && /과반수\(2명\)/.test(await text(B, '#vote-count')));
      await B.click('#vote-yes');
      await wait(500);
      check('3명 중 2명이 동의하면 바로 다음 라운드가 된다(세 번째 사람의 창도 닫힌다)', (await snapshot(A)).round === '2 / 5' && (await snapshot(C)).hints === 2 && !(await C.isVisible('#vote-modal')) && /동의 2\/3명/.test(await text(C, '#notice')), `${await text(C, '#notice')}`);

      // 포기: 제안자에게만 확인, 그 뒤 동의
      await A.click('#quit');
      await wait(300);
      check('포기를 누르면 확인 창은 누른 사람에게만 뜬다(다른 사람에게는 아직 아무것도 없다)', await A.isVisible('#quit-confirm') && !(await B.isVisible('#quit-confirm')) && !(await B.isVisible('#vote-modal')));
      await A.click('#quit-yes');
      await wait(400);
      check('"종료"를 누르면 포기 제안이 되어 다른 참가자에게 투표 창이 뜬다', !(await A.isVisible('#quit-confirm')) && await B.isVisible('#vote-modal') && /포기/.test(await text(B, '#vote-kind')) && /정답은 공개되지 않고/.test(await text(B, '#vote-warning')));
      await B.click('#vote-no');
      await wait(300);
      check('한 명이 반대해도 아직 과반수가 될 수 있으면 이어진다(창은 남은 사람에게만)', (await snapshot(A)).status === 'PLAYING' && await C.isVisible('#vote-modal') && !(await B.isVisible('#vote-modal')));
      await C.click('#vote-yes');
      await wait(500);
      check('남은 한 명이 동의해 과반수(2/3)가 되면 포기로 끝난다(정답은 공개되지 않는다)', (await snapshot(A)).status === 'QUIT' && (await snapshot(C)).status === 'QUIT' && /게임을 종료했습니다/.test(await text(B, '#result')) && !/정답: /.test(await text(B, '#result')));

      // 나가면 목록에서 빠진다
      await leaveAndClose(C);
      await wait(300);
      check('한 명이 나가면 남은 사람 화면의 참가자 목록에서 빠진다', JSON.stringify(await players(A)) === JSON.stringify(['김하늘 (나)|대기', '박서준|대기']), JSON.stringify(await players(A)));
      await leaveAndClose(B);
      await wait(300);
      check('혼자 남으면 준비 없이 바로 다시 시작할 수 있다(준비 버튼은 숨는다)', !(await A.isVisible('#ready')) && !(await A.isDisabled('#start')) && /다시 하려면 게임 시작을 눌러 주세요/.test(await text(A, '#message')), await text(A, '#message'));
      await leaveAndClose(A);
    }

    // ── 폰에서 여럿이: 참가자 줄·투표 창 ──
    {
      const A = await enter('김하늘');
      await lobby(A);
      const phone = await enter('폰사람', devices['iPhone SE']);
      await lobby(phone);
      await wait(300);
      const lobbyLayout = await phone.evaluate(() => {
        const strip = document.getElementById('players');
        const controls = document.getElementById('lobby').getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          players: strip.children.length,
          row: new Set([...strip.children].map((el) => Math.round(el.getBoundingClientRect().top))).size === 1, // 한 줄로 늘어선다
          controlsInView: controls.bottom <= innerHeight + 1 && controls.top >= 0,
        };
      });
      check('폰(iPhone SE): 대기실에서 가로로 넘치지 않고, 참가자가 한 줄로 늘어서며, 준비·시작 버튼이 화면 안에 보인다', !lobbyLayout.overflow && lobbyLayout.players === 2 && lobbyLayout.row && lobbyLayout.controlsInView, JSON.stringify(lobbyLayout));
      await phone.tap('#ready');
      await A.click('#ready');
      await wait(300);
      await phone.tap('#start');
      await wait(250);
      const confirmBox = await phone.evaluate(() => { const r = document.querySelector('#start-confirm .modal-card').getBoundingClientRect(); return { inside: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 }; });
      check('폰: 게임 시작 확인 창이 화면 안에 들어온다', await phone.isVisible('#start-confirm') && confirmBox.inside, JSON.stringify(confirmBox));
      await phone.tap('#start-go');
      await phone.waitForSelector('#grid .cand');
      await A.waitForSelector('#grid .cand');
      await wait(300);
      const answer = answerOfGame(0);
      const spare = wrongPick(answer.id);
      await cand(A, spare).click();
      await A.click('#remove');
      await wait(400);
      const voteBox = await phone.evaluate(() => {
        const r = document.querySelector('#vote-modal .modal-card').getBoundingClientRect();
        const yes = document.getElementById('vote-yes').getBoundingClientRect();
        return { inside: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, tap: yes.height >= 38, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      check('폰: 투표 창이 화면 안에 들어오고 동의 버튼이 손가락으로 누를 만하다', await phone.isVisible('#vote-modal') && voteBox.inside && voteBox.tap && !voteBox.overflow, JSON.stringify(voteBox));
      await phone.tap('#vote-yes');
      await wait(400);
      check('폰: 탭으로 동의하면 두 화면에서 지워지고 창이 닫힌다', JSON.stringify((await snapshot(A)).removed) === `[${spare}]` && JSON.stringify((await snapshot(phone)).removed) === `[${spare}]` && !(await phone.isVisible('#vote-modal')));
      const phoneLayout = await phone.evaluate(() => {
        const controls = document.getElementById('live-controls').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth + 1, controlsInView: controls.bottom <= innerHeight + 1 && controls.top >= 0 };
      });
      check('폰: 진행 중에도 가로로 넘치지 않고 조작 버튼이 화면 아래에 보인다', !phoneLayout.overflow && phoneLayout.controlsInView, JSON.stringify(phoneLayout));
      await leaveAndClose(phone);
      await leaveAndClose(A);
    }

    // ══════════════ 폰(혼자) ══════════════
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
      await leaveAndClose(phone);
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
