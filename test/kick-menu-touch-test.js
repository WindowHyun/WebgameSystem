'use strict';
/* global ws, state, myId */

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

async function main() {
  const server = createGameServer({ port: 4199, host: '127.0.0.1' });
  let browser;
  await server.start();
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
    const errors = [];
    const pages = [];
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('http://127.0.0.1:4199/liar.html');
      await page.waitForFunction(() => ws && ws.readyState === WebSocket.OPEN);
      await page.fill('#nickname-input', name);
      await page.uncheck('#spectator-input');
      await page.click('#join-btn');
      await page.waitForFunction(() => state && state.you);
      pages.push(page);
    }
    const [a, b] = pages; // Gamma just needs to be present so the kick vote meets its minimum-voter rule.
    const idB = await b.evaluate(() => myId);
    const sel = `[data-player-id="${idB}"]`;

    const touch = (page, selector, type) => page.locator(selector).evaluate((el, evType) => {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      const isEnd = evType === 'touchend' || evType === 'touchcancel';
      el.dispatchEvent(new TouchEvent(evType, {
        touches: isEnd ? [] : [t], targetTouches: isEnd ? [] : [t], changedTouches: [t],
        bubbles: true, cancelable: true,
      }));
    }, type);
    const touchMoved = (page, selector) => page.locator(selector).evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const t = new Touch({ identifier: 1, target: el, clientX: rect.left + rect.width / 2 + 40, clientY: rect.top + rect.height / 2 });
      el.dispatchEvent(new TouchEvent('touchmove', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
    });

    // A quick tap must not open the kick menu (only a sustained long-press should).
    await touch(a, sel, 'touchstart');
    await touch(a, sel, 'touchend');
    await a.waitForTimeout(700);
    assert.equal(await a.isVisible('#profile-menu'), false);
    console.log('PASS short tap does not open the kick menu');

    // Sliding the finger before the hold completes must cancel the long-press.
    await touch(a, sel, 'touchstart');
    await touchMoved(a, sel);
    await a.waitForTimeout(700);
    assert.equal(await a.isVisible('#profile-menu'), false);
    await touch(a, sel, 'touchend');
    console.log('PASS moving the finger cancels a pending long-press');

    // A sustained hold (iOS has no contextmenu event) must open the kick menu.
    await touch(a, sel, 'touchstart');
    await a.waitForSelector('#profile-menu button[data-kick]', { timeout: 2000 });
    console.log('PASS long-press opens the kick menu on touch devices');

    // The ghost click that follows touchend must not immediately close what the long-press opened.
    await touch(a, sel, 'touchend');
    assert.equal(await a.isVisible('#profile-menu'), true);
    console.log('PASS releasing the finger after a long-press does not close the menu');

    await a.click('#profile-menu button[data-kick]');
    await b.waitForSelector('#moderation-panel button[data-kick-vote="yes"]');
    console.log('PASS kick proposal opened via a mobile long-press reaches the target');

    assert.deepEqual(errors, []);
    console.log('PASS no browser script errors');
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
