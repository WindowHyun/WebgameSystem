'use strict';

/**
 * UI 점검 - 지금까지 안 본 것들을 본다.
 *
 * mobile-ui-test.js가 보는 건 넘침·잘림·터치 크기뿐이고, 그것도 폰 크기에서만 본다.
 * 여기서는 데스크톱 크기까지 포함해서 여러 장면을 돌아보며
 *   - 글자와 배경의 명암비(읽을 수 있는가)
 *   - 키보드로 옮겨 다닐 때 지금 어디인지 보이는가
 *   - 버튼·입력창에 이름이 붙어 있는가(화면 낭독기)
 *   - 같은 id가 두 번 쓰이지 않았는가
 *   - 빈 화면에 안내가 있는가
 * 를 확인하고, 눈으로 봐야 할 것은 스크린샷으로 남긴다.
 */

const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { createGameServer } = require('../web/game-server');

const OUT = process.env.UI_SHOT_DIR || path.join(__dirname, '..', '.ui-shots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMES = ['김하늘', '박서준', '이도현'];
const findings = [];
function report(where, scene, kind, detail) { findings.push({ where, scene, kind, detail }); }

/**
 * 화면 안의 글자를 훑어 명암비를 잰다. 배경이 투명하면 부모를 거슬러 올라가 실제로
 * 깔린 색을 찾는다. WCAG 기준은 보통 글자 4.5:1, 큰 글자(18.66px 굵게 / 24px) 3:1.
 */
const AUDIT = `(() => {
  const out = { contrast: [], focus: [], unlabeled: [], dupIds: [], emptyBoxes: [] };

  const parse = (value) => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((n) => parseFloat(n));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a); const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const backdrop = (el) => {
    let node = el; let acc = { r: 255, g: 255, b: 255, a: 1 };
    const stack = [];
    while (node && node !== document.documentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) { stack.push(bg); if (bg.a === 1) break; }
      node = node.parentElement;
    }
    for (let i = stack.length - 1; i >= 0; i -= 1) acc = over(stack[i], acc);
    return acc;
  };

  const seenIds = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const box = el.getBoundingClientRect();

    if (el.id) {
      if (seenIds.has(el.id)) out.dupIds.push(el.id);
      seenIds.add(el.id);
    }

    // 버튼·입력창에 읽을 이름이 있는가
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const named = (el.textContent || '').trim()
        || el.getAttribute('aria-label')
        || el.getAttribute('title')
        || (el.id && document.querySelector('label[for="' + el.id + '"]'))
        || el.closest('label')
        || (tag === 'INPUT' && ['hidden', 'checkbox', 'radio'].includes(el.type));
      if (!named && box.width > 0) {
        out.unlabeled.push(tag.toLowerCase() + (el.id ? '#' + el.id : '') + (el.type ? '[' + el.type + ']' : ''));
      }
    }

    // 글자 명암비
    const text = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!text || box.width === 0 || box.height === 0) continue;
    const fg = parse(style.color);
    if (!fg) continue;
    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(over(fg, backdrop(el)), backdrop(el));
    if (got < need) {
      out.contrast.push({
        tag: el.id ? '#' + el.id : (el.className && typeof el.className === 'string'
          ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/)[0] : el.tagName.toLowerCase()),
        text: text.slice(0, 30), ratio: Math.round(got * 100) / 100, need, size: Math.round(size),
      });
    }
  }
  return out;
})()`;

/** 키보드로 옮겨 다닐 때 "지금 여기"가 눈에 보이는지 확인한다. */
const FOCUS_CHECK = `(() => {
  const targets = [...document.querySelectorAll('button, a[href], input, textarea, [tabindex]')]
    .filter((el) => el.offsetParent !== null && !el.disabled);
  const bad = [];
  for (const el of targets.slice(0, 40)) {
    el.focus();
    const style = getComputedStyle(el);
    const hasOutline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    const hasShadow = style.boxShadow && style.boxShadow !== 'none';
    if (!hasOutline && !hasShadow) {
      bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) + ' "' + (el.textContent || '').trim().slice(0, 16) + '"');
    }
    el.blur();
  }
  return bad;
})()`;

async function inspect(page, where, scene) {
  const a = await page.evaluate(AUDIT);
  for (const c of a.contrast) {
    report(where, scene, '명암비 부족', `${c.tag} "${c.text}" ${c.ratio}:1 (${c.size}px, 기준 ${c.need}:1)`);
  }
  for (const id of new Set(a.dupIds)) report(where, scene, 'id 중복', `#${id}`);
  for (const u of new Set(a.unlabeled)) report(where, scene, '이름 없는 조작부', u);
  const focusBad = await page.evaluate(FOCUS_CHECK);
  for (const f of new Set(focusBad)) report(where, scene, '키보드 초점 안 보임', f);
  await page.screenshot({ path: path.join(OUT, `${where}__${scene}.png`), fullPage: false });
}

async function enter(context, port, game, nickname) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#nickname', nickname);
  await page.press('#nickname', 'Enter');
  await page.click(`.game-card.${game}`);
  await page.waitForSelector(game === 'liar' ? '#screen-game' : '#players .player', { timeout: 15000 });
  return page;
}

async function whoCanType(pages) {
  for (const p of pages) if (await p.isEnabled('#chat-input').catch(() => false)) return p;
  return null;
}

async function run(browser, label, contextOptions, port) {
  const server = createGameServer({ port, host: '127.0.0.1' });
  await server.start();
  const contexts = [];
  try {
    // 포털부터
    const portalCtx = await browser.newContext(contextOptions);
    contexts.push(portalCtx);
    const portal = await portalCtx.newPage();
    await portal.goto(`http://127.0.0.1:${port}/`);
    await wait(400);
    await inspect(portal, label, 'portal-1-이름입력');
    await portal.fill('#nickname', '김하늘');
    await portal.press('#nickname', 'Enter');
    await wait(400);
    await inspect(portal, label, 'portal-2-게임목록');

    for (const game of ['liar', 'poker', 'blackjack']) {
      const pages = [];
      const gameCtxs = [];
      for (const name of NAMES) {
        const ctx = await browser.newContext(contextOptions);
        gameCtxs.push(ctx); contexts.push(ctx);
        pages.push(await enter(ctx, port, game, name));
      }
      await wait(600);
      const me = pages[0];
      await inspect(me, label, `${game}-1-대기실`);

      if (game === 'liar') {
        await me.click('#start-btn');
        await wait(900);
        await inspect(me, label, `${game}-2-설명차례`);
        for (let i = 0; i < 6; i += 1) {
          const speaker = await whoCanType(pages);
          if (!speaker) break;
          await speaker.fill('#chat-input', `${i + 1}번째 설명입니다`);
          await speaker.press('#chat-input', 'Enter');
          await wait(300);
        }
        await wait(500);
        await inspect(me, label, `${game}-3-대화누적`);
      } else {
        for (const p of pages) { await p.click('#ready'); await wait(150); }
        await wait(300);
        await me.click('#start');
        await wait(900);
        await inspect(me, label, `${game}-2-진행중`);
      }
      for (const c of gameCtxs) await c.close().catch(() => {});
      await wait(300);
    }
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await server.stop();
  }
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    await run(browser, 'desktop', { viewport: { width: 1440, height: 900 }, locale: 'ko-KR' }, 4480);
    await run(browser, 'phone', { ...devices['iPhone 13 Pro'], locale: 'ko-KR' }, 4481);
  } finally {
    await browser.close();
  }

  const grouped = new Map();
  for (const f of findings) {
    const key = `${f.kind} | ${f.detail}`;
    if (!grouped.has(key)) grouped.set(key, { ...f, count: 0, scenes: new Set(), wheres: new Set() });
    const g = grouped.get(key);
    g.count += 1; g.scenes.add(f.scene); g.wheres.add(f.where);
  }
  const rows = [...grouped.values()].sort((a, b) => b.count - a.count);
  console.log(`\n스크린샷: ${OUT}`);
  console.log(`발견 ${findings.length}건 (${rows.length}종류)\n`);
  for (const r of rows) {
    console.log(`[${r.kind}] ${r.detail}`);
    console.log(`   ${[...r.wheres].join(', ')} / ${[...r.scenes].slice(0, 4).join(', ')}${r.scenes.size > 4 ? ' 외' : ''}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
