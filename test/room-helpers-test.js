'use strict';

/**
 * 카드 게임 방이 같이 쓰는 도구(web/room-helpers.js).
 *   - uniqueName   겹치는 이름에 (2), (3)…을 붙이고, 이모지를 반으로 가르지 않으며, 끝까지 겹치면 꼬리표를 붙인다
 *   - createSafeTimeout  타이머 콜백이 던진 예외를 삼켜 로그로 남기고(프로세스는 계속 산다), 타이머가 서버 종료를 붙잡지 않는다
 *
 * 실행: node test/room-helpers-test.js
 */

const { createSafeTimeout, uniqueName } = require('../web/room-helpers');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

(async () => {
  // ── uniqueName ──
  const makeId = () => 'abcdef012345';
  check('겹치지 않으면 그대로 쓴다', uniqueName(new Set(['김하늘']), '박서준', makeId) === '박서준');
  check('겹치면 (2)를 붙이고, (2)도 쓰고 있으면 (3)을 붙인다', uniqueName(new Set(['김하늘']), '김하늘', makeId) === '김하늘(2)'
    && uniqueName(new Set(['김하늘', '김하늘(2)']), '김하늘', makeId) === '김하늘(3)');
  const long = '😀'.repeat(25);
  const trimmed = uniqueName(new Set([long]), long, makeId);
  check('긴 이름은 글자(코드 포인트) 20개로 자르고 이모지를 반으로 가르지 않는다', trimmed === `${'😀'.repeat(20)}(2)` && Array.from(trimmed).every((c) => c !== '�') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(trimmed), trimmed);
  const crowded = new Set([long]);
  for (let n = 2; n < 100; n += 1) crowded.add(`${'😀'.repeat(20)}(${n})`);
  check('99번째까지 다 쓰고 있으면 꼬리표(makeId 앞 4자)를 붙인다(18자로 잘라 20자 안에 든다)', uniqueName(crowded, long, makeId) === `${'😀'.repeat(18)}-abcd`);

  // ── createSafeTimeout ──
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(String(line));
  let uncaught = null;
  const onUncaught = (err) => { uncaught = err; };
  process.on('uncaughtException', onUncaught);
  try {
    const safe = createSafeTimeout('시험방');
    let ran = 0;
    const normal = safe(() => { ran += 1; }, 1);
    safe(() => { throw new Error('일부러 낸 오류'); }, 1);
    await wait(60);
    check('콜백은 정해진 때 한 번 실행된다', ran === 1);
    check('콜백이 던진 예외는 프로세스까지 올라가지 않는다(uncaughtException 없음)', uncaught === null, String(uncaught));
    check('예외는 "[라벨 진행 처리 실패]" 머리말과 함께 로그에 남는다', logged.some((l) => l.includes('[시험방 진행 처리 실패]') && l.includes('일부러 낸 오류')), logged.join(' | '));
    const timer = safe(() => {}, 100000);
    check('타이머는 서버 종료를 붙잡지 않는다(unref)', typeof timer.hasRef === 'function' && timer.hasRef() === false && normal.hasRef() === false);
    clearTimeout(timer);
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    console.error = original;
  }

  console.log(`\n방 도구: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
