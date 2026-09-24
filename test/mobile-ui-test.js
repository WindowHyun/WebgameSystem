'use strict';

/**
 * 모바일 화면 검증 - 세 게임을 실제 휴대폰 크기/터치 환경으로 띄워 3명이 들어간
 * 상태를 찍고, 눈으로 봐야만 알 수 있는 것 말고 "숫자로 잡히는 깨짐"을 골라낸다.
 *
 * 잡아내는 것
 *   - 가로 스크롤(페이지가 화면보다 넓다)
 *   - 화면 밖으로 삐져나간 요소
 *   - 서로 겹친 요소
 *   - 손가락으로 누르기 힘든 버튼(44x44 미만)
 *   - 글자가 잘린 곳(넘치는데 말줄임 처리도 없음)
 *
 * 스크린샷은 scratchpad에 남긴다(저장소에 들어가지 않는다).
 */

const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { createGameServer } = require('../web/game-server');

const OUT = process.env.MOBILE_SHOT_DIR || path.join(__dirname, '..', '.mobile-shots');
const PORT = Number(process.env.MOBILE_TEST_PORT) || 4421;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 한국에서 가장 흔한 두 종류. 작은 쪽(iPhone SE)이 거의 모든 깨짐을 먼저 드러낸다.
const PHONES = [
  { name: 'iPhone-SE', descriptor: { ...devices['iPhone SE'] } },
  { name: 'iPhone-14-Pro', descriptor: { ...devices['iPhone 13 Pro'] } },
  { name: 'Galaxy-S9', descriptor: { ...devices['Galaxy S9+'] } },
];

const findings = [];
function report(phone, game, scene, kind, detail) {
  findings.push({ phone, game, scene, kind, detail });
}

/** 화면에 실제로 보이는 요소만 모아 위치/크기를 잰다. */
const MEASURE = `(() => {
  const out = { width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth, boxes: [] };
  const seen = document.querySelectorAll('body *');
  for (const el of seen) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom < 0 || r.top > innerHeight * 3) continue;
    const tag = el.id ? '#' + el.id
      : el.className && typeof el.className === 'string' && el.className.trim()
        ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).join('.')
        : el.tagName.toLowerCase();
    out.boxes.push({
      tag,
      left: Math.round(r.left), right: Math.round(r.right),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      width: Math.round(r.width), height: Math.round(r.height),
      tappable: el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button',
      clipped: el.scrollWidth > el.clientWidth + 1 && style.textOverflow !== 'ellipsis'
        && style.overflowX !== 'auto' && style.overflowX !== 'scroll',
      overflowX: style.overflowX,
      text: (el.children.length === 0 ? (el.textContent || '').trim().slice(0, 40) : ''),
    });
  }
  return out;
})()`;

async function inspect(page, phone, game, scene) {
  const m = await page.evaluate(MEASURE);

  // 1) 페이지 자체가 화면보다 넓은가 - 모바일에서 가장 눈에 띄는 깨짐이다.
  if (m.scrollWidth > m.width + 1) {
    report(phone, game, scene, '가로 스크롤', `문서 폭 ${m.scrollWidth}px > 화면 ${m.width}px`);
  }

  for (const b of m.boxes) {
    // 2) 화면 밖으로 삐져나간 요소. 가로 스크롤 컨테이너 안의 것은 정상이므로 뺀다.
    if (b.right > m.width + 1 && b.overflowX !== 'auto' && b.overflowX !== 'scroll') {
      const parentScrolls = m.boxes.some((p) => (p.overflowX === 'auto' || p.overflowX === 'scroll')
        && p.left <= b.left && p.top <= b.top && p.bottom >= b.bottom);
      if (!parentScrolls) {
        report(phone, game, scene, '화면 밖으로 넘침', `${b.tag} 오른쪽 끝 ${b.right}px (화면 ${m.width}px)`);
      }
    }
    // 3) 글자가 잘렸는데 말줄임도 없다.
    if (b.clipped && b.text) {
      report(phone, game, scene, '글자 잘림', `${b.tag} "${b.text}"`);
    }
    // 4) 손가락으로 누르기 힘든 크기. 애플·구글 권장은 44px다.
    if (b.tappable && b.height > 0 && (b.height < 44 || b.width < 44)) {
      report(phone, game, scene, '작은 터치 대상', `${b.tag} ${b.width}x${b.height}px "${b.text}"`);
    }
  }

  const file = path.join(OUT, `${phone}__${game}__${scene}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/** 라이어 게임에서 지금 입력창이 열려 있는(= 자기 차례인) 창을 찾는다. */
async function whoCanType(pages) {
  for (const page of pages) {
    if (await page.isEnabled('#chat-input').catch(() => false)) return page;
  }
  return null;
}

/** 카드 게임에서 그 버튼을 지금 누를 수 있는 창을 찾는다. */
async function whoseTurn(pages, selector) {
  for (const page of pages) {
    if (await page.isEnabled(selector).catch(() => false)) return page;
  }
  return null;
}

/** 포털 → 닉네임 → 게임. 실제 사용자가 거치는 경로 그대로 간다. */
async function enter(context, game, nickname) {
  const page = await context.newPage();
  page.on('pageerror', (e) => report('-', game, '-', '스크립트 오류', String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.fill('#nickname', nickname);
  await page.press('#nickname', 'Enter');
  await page.tap(`.game-card.${game}`);
  const anchor = game === 'liar' ? '#screen-game' : '#players .player';
  await page.waitForSelector(anchor, { timeout: 15000 });
  await wait(250);
  return page;
}

async function runGame(browser, phone, descriptor, game) {
  const pages = [];
  const contexts = [];
  try {
    for (const name of ['김하늘', '박서준', '이도현']) {
      const context = await browser.newContext({ ...descriptor, locale: 'ko-KR' });
      contexts.push(context);
      pages.push(await enter(context, game, name));
    }
    await wait(600);
    const me = pages[0];
    const shots = [];

    shots.push(await inspect(me, phone, game, '1-대기실-3명'));

    if (game === 'liar') {
      await me.tap('#start-btn');
      await wait(900);
      shots.push(await inspect(me, phone, game, '2-라운드중-3명'));
      // 채팅이 쌓인 상태도 본다. 긴 문장이 레이아웃을 밀어내는지 확인.
      // 라이어 게임은 자기 차례인 사람만 입력할 수 있으므로, 열려 있는 창을 찾아서 친다.
      for (let round = 0; round < 4; round += 1) {
        const speaker = await whoCanType(pages);
        if (!speaker) break;
        await speaker.fill('#chat-input', `${round + 1}번째 설명입니다 조금 길게 적어서 줄바꿈까지 확인합니다`);
        await speaker.press('#chat-input', 'Enter');
        await wait(350);
      }
      await wait(400);
      shots.push(await inspect(me, phone, game, '3-채팅후-3명'));
    } else {
      for (const page of pages) { await page.tap('#ready'); await wait(150); }
      await wait(400);
      shots.push(await inspect(me, phone, game, '2-준비완료-3명'));
      await me.tap('#start');
      await me.tap('#start-go'); // 시작 확인 창
      await wait(900);
      shots.push(await inspect(me, phone, game, '3-라운드중-3명'));
      if (game === 'blackjack') {
        // 카드를 여러 장 받은 상태가 가로로 가장 넓어진다 - 손패가 화면을 넘는지 본다.
        for (let i = 0; i < 6; i += 1) {
          const actor = await whoseTurn(pages, '#hit');
          if (!actor) break;
          await actor.tap('#hit');
          await wait(300);
        }
        shots.push(await inspect(me, phone, game, '4-카드여러장-3명'));
      }
      if (game === 'mind') {
        // 더 마인드는 시작하면 집중 단계다. 모두 집중하면 카드 내기 버튼이 뜨는 진행 화면이 된다.
        for (const page of pages) { await page.tap('#focus'); await wait(150); }
        await wait(400);
        shots.push(await inspect(me, phone, game, '4-진행중-3명'));
      }
    }
    return shots;
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = createGameServer({ port: PORT, host: '127.0.0.1' });
  await server.start();
  const browser = await chromium.launch();
  const shots = [];
  try {
    for (const { name, descriptor } of PHONES) {
      for (const game of ['liar', 'poker', 'blackjack', 'mind']) {
        shots.push(...await runGame(browser, name, descriptor, game));
      }
    }
  } finally {
    await browser.close();
    await server.stop();
  }

  // 같은 종류의 문제가 기기마다 반복되므로 묶어서 센다.
  const grouped = new Map();
  for (const f of findings) {
    const key = `${f.game} | ${f.kind} | ${f.detail.replace(/\d+px/g, 'Npx')}`;
    if (!grouped.has(key)) grouped.set(key, { ...f, key, count: 0, phones: new Set(), scenes: new Set() });
    const g = grouped.get(key);
    g.count += 1; g.phones.add(f.phone); g.scenes.add(f.scene);
  }
  const rows = [...grouped.values()].sort((a, b) => b.count - a.count);

  console.log(`\n스크린샷 ${shots.length}장: ${OUT}`);
  console.log(`발견 ${findings.length}건 (${rows.length}종류)\n`);
  for (const r of rows) {
    console.log(`[${r.kind}] ${r.game}`);
    console.log(`   ${r.detail}`);
    console.log(`   기기: ${[...r.phones].join(', ')} / 장면: ${[...r.scenes].join(', ')}\n`);
  }
  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(findings, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
