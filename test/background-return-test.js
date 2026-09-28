'use strict';

/**
 * [모바일] 잠깐 다른 앱을 보다 돌아왔을 때 무슨 일이 일어나는가.
 *
 * 폰에서 화면을 끄거나 앱을 바꾸면 OS가 탭을 얼려 버린다. 자바스크립트가 멈추니
 * 화면은 ping을 못 보내고, 서버가 보내는 ping에도 답이 없다. 그 상태로 시간이
 * 흐르면 서버는 그 사람을 죽은 연결로 보고 정리한다.
 *
 * 이 테스트는 그 상황을 네트워크를 끊는 것으로 흉내 낸다(정상 종료가 아니라
 * TCP가 그냥 죽는 것 - 실제 OS가 하는 일과 같다). 돌아왔을 때
 *   - 원래 자리(같은 참가자)로 돌아오는가
 *   - 칩을 그대로 들고 있는가
 *   - 진행 중이던 판에서 어떻게 처리되는가
 * 를 시간대별로 잰다. 실제 배포와 같은 타이밍을 쓰므로 느리다.
 *
 * 끝에서 판정한다. 하나라도 자리를 잃거나, 칩이 바뀌거나, 다시 붙지 못하거나(또는
 * RECONNECT_LIMIT_MS보다 오래 걸리거나), 접속 화면·복구 안내로 튕기면 실패(종료 코드 1)다.
 * (예전에는 표만 찍고 늘 성공으로 끝나서, 재연결이 망가져도 이 테스트로는 알 수 없었다.)
 */

const net = require('net');
const { chromium } = require('playwright');
const { createGameServer } = require('../web/game-server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 돌아온 뒤 이 안에 다시 붙어야 한다. 확인(ping) 실패로 새로 붙는 데 2.5초, 열리다 멈춘 연결을
// 버리는 데 8초가 걸린다. 예전 먹통(50초 넘게)은 확실히 걸러지고 느린 기계에서도 여유가 있게 잡았다.
const RECONNECT_LIMIT_MS = 15000;

/**
 * 한 사람만 골라서 선을 끊을 수 있게, 그 사람 앞에만 TCP 중계를 둔다.
 *
 * Playwright의 setOffline은 새 요청만 막고 이미 열린 WebSocket은 그대로 두기
 * 때문에(브라우저 네트워크 계층이 ping/pong을 계속 받아 준다) 그것만으로는
 * 백그라운드를 흉내 낼 수 없다. 여기서 소켓을 직접 destroy해야 실제 OS가
 * 앱을 재우면서 연결을 끊는 것과 같은 모양이 된다.
 */
function makeProxy(listenPort, targetPort) {
  const live = new Set();
  let frozen = false;
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    live.add(client); live.add(upstream);
    client.on('error', () => {});
    upstream.on('error', () => {});
    client.on('close', () => { live.delete(client); upstream.destroy(); });
    upstream.on('close', () => { live.delete(upstream); client.destroy(); });
    // pipe 대신 직접 넘겨서, "얼리기" 때는 오가는 것을 조용히 버린다.
    client.on('data', (d) => { if (!frozen) upstream.write(d); });
    upstream.on('data', (d) => { if (!frozen) client.write(d); });
  });
  server.on('error', () => {});
  return {
    start: () => new Promise((r) => server.listen(listenPort, '127.0.0.1', r)),
    // 선이 끊긴다. 양쪽 다 즉시 안다(close 이벤트가 온다).
    cut() { for (const s of live) s.destroy(); live.clear(); },
    // 선은 붙어 있는데 오가는 게 전부 사라진다. 양쪽 다 한동안 모른다 -
    // 폰이 잠들 때 실제로 벌어지는 일이고, 이게 훨씬 고약하다.
    freeze() { frozen = true; },
    thaw() { frozen = false; },
    stop: () => new Promise((r) => server.close(() => r())),
  };
}
const NAMES = ['김하늘', '박서준', '이도현'];
const rows = [];

async function enter(context, port, game, nickname) {
  const page = await context.newPage();
  // 화면이 "실제로 다시 살아난 순간"을 재려면 서버 소식이 도착한 때를 봐야 한다.
  // data-offline 같은 표시는 좀비 연결에서는 애초에 켜지지도 않는다.
  await page.addInitScript(() => {
    window.__rx = 0;
    const Original = window.WebSocket;
    const Patched = function (...args) {
      const socket = new Original(...args);
      socket.addEventListener('message', () => { window.__rx += 1; });
      return socket;
    };
    Patched.prototype = Original.prototype;
    Object.assign(Patched, Original);
    window.WebSocket = Patched;
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#nickname', nickname);
  await page.press('#nickname', 'Enter');
  await page.click(`.game-card.${game}`);
  await page.waitForSelector(game === 'liar' ? '#screen-game' : '#players .player', { timeout: 15000 });
  return page;
}

/** 카드 게임 화면에서 "나"에 대해 화면이 알고 있는 것. */
const CARD_ME = `(() => {
  const mine = document.querySelector('#players .player b');
  const all = [...document.querySelectorAll('#players .player')];
  const me = all.find((el) => /\\(나\\)/.test(el.querySelector('b').textContent));
  return {
    roster: all.length,
    meVisible: !!me,
    meName: me ? me.querySelector('b').textContent.trim() : null,
    meChips: me ? me.querySelector('small').textContent.trim() : null,
    meStatus: me ? (me.querySelector('.status') || {}).textContent : null,
    offline: document.body.hasAttribute('data-offline'),
    fatal: !!document.getElementById('fatal'),
    first: mine ? mine.textContent.trim() : null,
  };
})()`;

/** 라이어 화면에서 "나"에 대해 화면이 알고 있는 것. */
const LIAR_ME = `(() => {
  const items = [...document.querySelectorAll('#participant-list li')];
  const me = items.find((el) => /\\(나\\)/.test(el.textContent));
  return {
    roster: items.length,
    meVisible: !!me,
    meName: me ? me.querySelector('.name').textContent.trim() : null,
    onJoinScreen: !document.getElementById('screen-join').classList.contains('hidden'),
    banner: document.getElementById('banner').classList.contains('hidden')
      ? null : document.getElementById('banner').textContent.trim().slice(0, 60),
  };
})()`;

async function scenario(browser, port, game, awaySeconds, duringRound, mode) {
  const server = createGameServer({ port, host: '127.0.0.1' });
  await server.start();
  // 3번째 사람만 중계를 거쳐 붙는다. 이 사람의 선만 끊기 위해서다.
  const proxy = makeProxy(port + 100, port);
  await proxy.start();
  const contexts = [];
  const pages = [];
  try {
    for (const [i, name] of NAMES.entries()) {
      const context = await browser.newContext();
      contexts.push(context);
      pages.push(await enter(context, i === 2 ? port + 100 : port, game, name));
    }
    await wait(600);

    if (duringRound) {
      if (game === 'liar') {
        await pages[0].click('#start-btn');
      } else {
        for (const page of pages) { await page.click('#ready'); await wait(150); }
        await wait(300);
        await pages[0].click('#start');
        await pages[0].click('#start-go'); // 시작 확인 창
      }
      await wait(1000);
    }

    // 3번째 사람이 폰을 내려놓는다.
    //   - 이미 열린 연결은 끊긴다(OS가 앱을 재우며 소켓을 버린다) → proxy.cut()
    //   - 그동안 다시 붙지도 못한다(화면이 얼어 있고 통신도 막혀 있다) → setOffline
    const away = contexts[2];
    const awayPage = pages[2];
    const before = await awayPage.evaluate(game === 'liar' ? LIAR_ME : CARD_ME);
    // 폰이 잠기면 브라우저는 먼저 화면을 숨김으로 표시한다. 그 신호가 없으면 화면은
    // "자리를 비웠다"는 것 자체를 모르므로, 흉내 낼 때도 같이 줘야 진짜와 같아진다.
    await awayPage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    if (mode === 'cut') {
      await away.setOffline(true);
      proxy.cut();
    } else {
      proxy.freeze(); // 선은 그대로, 오가는 것만 사라진다(좀비 연결)
    }

    await wait(awaySeconds * 1000);

    // 남은 사람 눈에는 어떻게 보이는가(자리가 아직 있는가)
    const seenByOthers = await pages[0].evaluate(game === 'liar' ? LIAR_ME : CARD_ME);

    // 돌아온다. 실제로는 화면이 다시 보이면서 visibilitychange가 재접속을 건다.
    const rxBefore = await awayPage.evaluate('window.__rx').catch(() => 0);
    if (mode === 'cut') await away.setOffline(false); else proxy.thaw();
    const returnedAt = Date.now();
    await awayPage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // 화면이 "다시 붙었다"고 인정할 때까지 실제로 몇 초가 걸리는지 잰다.
    // 이게 사용자가 폰을 다시 켜고 멍하니 기다리는 시간이다.
    let reconnectMs = null;
    for (let i = 0; i < 480; i += 1) { // 최대 2분까지 기다려 본다
      const rx = await awayPage.evaluate('window.__rx').catch(() => rxBefore);
      if (rx > rxBefore) { reconnectMs = Date.now() - returnedAt; break; }
      await wait(250);
    }
    await wait(1200); // 상태 한 번 더 받을 틈
    const after = await awayPage.evaluate(game === 'liar' ? LIAR_ME : CARD_ME);

    rows.push({
      game, awaySeconds, duringRound, mode, reconnectMs,
      beforeName: before.meName, afterName: after.meName,
      keptSeat: !!after.meVisible && before.meName === after.meName,
      beforeChips: before.meChips || null, afterChips: after.meChips || null,
      status: after.meStatus || null,
      othersRoster: seenByOthers.roster,
      afterRoster: after.roster,
      onJoinScreen: after.onJoinScreen || false,
      fatal: after.fatal || false,
      banner: after.banner || null,
    });
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await proxy.stop();
    await server.stop();
  }
}

/** 한 시나리오에서 잘못된 것들. 비어 있으면 통과다. */
function problemsOf(r) {
  const problems = [];
  if (r.reconnectMs === null) problems.push('다시 붙지 못함');
  else if (r.reconnectMs > RECONNECT_LIMIT_MS) problems.push(`재연결 ${(r.reconnectMs / 1000).toFixed(1)}초(기준 ${RECONNECT_LIMIT_MS / 1000}초)`);
  if (!r.keptSeat) problems.push(`자리를 잃음(${r.beforeName} → ${r.afterName})`);
  if (r.beforeChips !== r.afterChips) problems.push(`칩이 바뀜(${r.beforeChips} → ${r.afterChips})`);
  if (r.onJoinScreen) problems.push('접속 화면으로 튕김');
  if (r.fatal) problems.push('복구 안내가 뜸');
  return problems;
}

async function main() {
  const browser = await chromium.launch();
  let port = 4470;
  let expected = 0;
  try {
    for (const game of ['poker', 'blackjack', 'liar']) {
      for (const mode of ['cut', 'freeze']) {
        for (const away of [30, 95]) {
          const duringRound = false;
          expected += 1;
          await scenario(browser, (port += 1), game, away, duringRound, mode);
          const r = rows[rows.length - 1];
          console.log(`${game} / ${mode === 'cut' ? '선이 끊김' : '좀비(오가는 것만 사라짐)'} / ${away}초`
            + ` → 자리유지 ${r.keptSeat ? 'O' : 'X'}`
            + ` (이름 ${r.beforeName} → ${r.afterName}`
            + (r.beforeChips ? `, 칩 ${r.beforeChips} → ${r.afterChips}` : '')
            + (r.status ? `, 상태 ${r.status}` : '')
            + `, 남은사람이 본 인원 ${r.othersRoster})`
            + ` / 재연결까지 ${r.reconnectMs === null ? '실패' : (r.reconnectMs / 1000).toFixed(1) + '초'}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n요약\n');
  for (const r of rows) {
    console.log(`  ${r.game.padEnd(6)} ${String(r.awaySeconds).padStart(3)}초 `
      + `${(r.mode === 'cut' ? '선끊김' : '좀비 ').padEnd(6)} `
      + `자리 ${r.keptSeat ? '유지' : '잃음'} · 재연결 ${r.reconnectMs === null ? '실패' : (r.reconnectMs / 1000).toFixed(1) + '초'}`
      + (r.onJoinScreen ? ' · 접속화면으로 튕김' : '')
      + (r.fatal ? ' · 복구안내' : '')
      + (r.banner ? ` · 배너"${r.banner}"` : ''));
  }

  console.log('\n판정\n');
  let failed = 0;
  for (const r of rows) {
    const problems = problemsOf(r);
    const label = `${r.game} / ${r.mode === 'cut' ? '선끊김' : '좀비'} / ${r.awaySeconds}초`;
    if (problems.length) failed += 1;
    console.log(`  ${problems.length ? 'FAIL' : 'PASS'}  ${label}${problems.length ? `  (${problems.join(', ')})` : ''}`);
  }
  if (rows.length !== expected) {
    failed += expected - rows.length;
    console.log(`  FAIL  시나리오 ${expected}개 중 ${rows.length}개만 끝남`);
  }
  console.log(`\n백그라운드 복귀: ${expected - failed}개 통과, ${failed}개 실패`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
