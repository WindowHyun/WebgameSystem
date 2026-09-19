'use strict';

/**
 * [모바일] 참가자 목록이 몇 명부터 화면을 넘는지 정확히 잰다.
 *
 * 세 게임 모두 모바일에서 참가자 줄을 가로 스크롤 띠로 바꾸는데, 칸 폭이 고정이라
 * 사람이 늘면 어느 순간부터 마지막 사람이 화면 밖으로 잘린다. "3명일 때 이상하게
 * 보인다"는 신고가 정확히 몇 명부터 시작되는 문제인지 숫자로 확인한다.
 */

const { chromium, devices } = require('playwright');
const { createGameServer } = require('../web/game-server');

const PORT = Number(process.env.ROSTER_TEST_PORT) || 4423;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMES = ['김하늘', '박서준', '이도현', '최유진', '정민우'];

const PHONES = [
  ['iPhone SE', devices['iPhone SE']],
  ['iPhone 13 Pro', devices['iPhone 13 Pro']],
  ['Galaxy S9+', devices['Galaxy S9+']],
];

async function enter(context, game, nickname, port) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#nickname', nickname);
  await page.press('#nickname', 'Enter');
  await page.tap(`.game-card.${game}`);
  await page.waitForSelector(game === 'liar' ? '#screen-game' : '#players .player', { timeout: 15000 });
  return page;
}

/** 목록 컨테이너와 각 칸을 재서, 컨테이너 밖으로 나간 사람이 몇 번째인지 돌려준다. */
const MEASURE = (listSelector, itemSelector) => `(() => {
  const list = document.querySelector(${JSON.stringify(listSelector)});
  if (!list) return null;
  const box = list.getBoundingClientRect();
  const items = [...document.querySelectorAll(${JSON.stringify(itemSelector)})].map((el, i) => {
    const r = el.getBoundingClientRect();
    return { index: i + 1, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
      name: (el.querySelector('b') || el).textContent.trim().slice(0, 12) };
  });
  return {
    viewport: innerWidth,
    listLeft: Math.round(box.left), listRight: Math.round(box.right), listWidth: Math.round(box.width),
    contentWidth: list.scrollWidth, items,
  };
})()`;

const TARGETS = {
  liar: { list: '#participant-list', item: '#participant-list > *' },
  poker: { list: '#players', item: '#players .player' },
  blackjack: { list: '#players', item: '#players .player' },
};

async function main() {
  const browser = await chromium.launch();
  const report = [];
  let port = PORT;
  try {
    for (const [phoneName, descriptor] of PHONES) {
      for (const game of Object.keys(TARGETS)) {
        // 조합마다 새 서버를 쓴다. 한 서버를 재사용하면 앞 회차에서 나간 사람이
        // 10초(DROP_MS) 동안 자리에 남아 다음 회차가 정원에 걸린다.
        const server = createGameServer({ port: (port += 1), host: '127.0.0.1' });
        await server.start();
        const contexts = [];
        const pages = [];
        try {
          for (const name of NAMES) {
            const context = await browser.newContext({ ...descriptor, locale: 'ko-KR' });
            contexts.push(context);
            pages.push(await enter(context, game, name, port));
            await wait(350);
            const m = await pages[0].evaluate(MEASURE(TARGETS[game].list, TARGETS[game].item));
            if (!m || !m.items.length) continue;
            const visible = m.items.filter((it) => it.right <= m.listRight + 1).length;
            report.push({ phone: phoneName, game, joined: pages.length, shown: m.items.length,
              fullyVisible: visible, viewport: m.viewport, listWidth: m.listWidth,
              contentWidth: m.contentWidth, itemWidth: m.items[0].width });
          }
        } finally {
          for (const c of contexts) await c.close().catch(() => {});
          await server.stop();
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n참가자 목록이 화면 안에 몇 명까지 들어가는가\n');
  let lastKey = '';
  for (const r of report) {
    const key = `${r.phone} · ${r.game}`;
    if (key !== lastKey) {
      console.log(`\n── ${key}  (화면 ${r.viewport}px / 목록 ${r.listWidth}px / 칸 ${r.itemWidth}px)`);
      lastKey = key;
    }
    const cut = r.shown - r.fullyVisible;
    const mark = cut === 0 ? '   OK ' : '  !!! ';
    console.log(`${mark}${r.joined}명 접속 → 온전히 보이는 사람 ${r.fullyVisible}명`
      + (cut ? ` (${cut}명 잘림, 목록 내용 폭 ${r.contentWidth}px)` : ''));
  }

  // 가장 중요한 한 줄: 몇 명부터 잘리기 시작하는가.
  console.log('\n요약 - 잘리기 시작하는 인원\n');
  const firstCut = new Map();
  for (const r of report) {
    const key = `${r.phone} · ${r.game}`;
    if (r.shown > r.fullyVisible && !firstCut.has(key)) firstCut.set(key, r.joined);
  }
  for (const [key] of report.reduce((m, r) => m.set(`${r.phone} · ${r.game}`, 1), new Map())) {
    console.log(`  ${key.padEnd(30)} ${firstCut.has(key) ? `${firstCut.get(key)}명부터 잘림` : '5명까지 문제 없음'}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
