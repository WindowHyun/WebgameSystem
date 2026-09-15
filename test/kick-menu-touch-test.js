'use strict';
/* global ws, state, myId, sendMessage */

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
    const [a, b, c] = pages; // Gamma keeps the kick vote above its minimum-voter rule, and chats to force a re-render.
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

    // Korean/Japanese IMEs send Enter to commit a composition. Treating that as "send"
    // ships the half-composed text and then sends again on the real Enter.
    const duringComposition = await a.evaluate(() => {
      const el = document.getElementById('chat-input');
      el.value = '안녕하세';
      let sent = 0;
      const real = window.sendMessage;
      window.sendMessage = (m) => { if (m.type === 'chat') sent += 1; };
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      window.sendMessage = real;
      return sent;
    });
    assert.equal(duringComposition, 0);
    const afterComposition = await a.evaluate(() => {
      const el = document.getElementById('chat-input');
      el.value = '안녕하세요';
      let sent = 0;
      const real = window.sendMessage;
      window.sendMessage = (m) => { if (m.type === 'chat') sent += 1; };
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: false, bubbles: true, cancelable: true }));
      window.sendMessage = real;
      return sent;
    });
    assert.equal(afterComposition, 1);
    console.log('PASS Enter while the IME is composing does not send; Enter after it does');

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

    // A state update must not close the menu: the room re-broadcasts on every chat line,
    // and closing on each one made the menu impossible to actually click in a live game.
    await c.evaluate(() => sendMessage({ type: 'chat', text: '안녕하세요' }));
    await a.waitForTimeout(400);
    assert.equal(await a.isVisible('#profile-menu'), true);
    console.log('PASS the kick menu survives an unrelated chat message');

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
