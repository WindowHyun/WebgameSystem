'use strict';

/**
 * 카드 게임 방(더 마인드·갈팡질팡)이 같이 쓰는 작은 도구.
 * 두 방에 로그 머리말만 다른 같은 코드가 한 벌씩 있던 것을 한 곳에 모았다.
 */

const { error: logError } = require('../logger');

/**
 * 타이머 콜백에서 난 예외가 프로세스까지 올라가지 않게 감싼 setTimeout을 만든다(예외는 로그로 남는다).
 * 타이머가 서버 종료를 붙잡지 않게 unref한다. label은 로그 머리말이다("[라벨 진행 처리 실패]").
 */
function createSafeTimeout(label) {
  return (fn, ms) => {
    const timer = setTimeout(() => {
      try { fn(); } catch (err) { logError(`[${label} 진행 처리 실패] ${err && err.stack ? err.stack : err}`); }
    }, ms);
    if (timer.unref) timer.unref();
    return timer;
  };
}

/**
 * 이미 쓰는 이름(used: Set)과 겹치면 뒤에 (2), (3)…을 붙인 이름을 돌려준다. 이름은 글자(코드 포인트) 단위로 자른다 -
 * slice()는 UTF-16 단위라 이모지를 반으로 가른다. 99번째까지 겹치면 makeId()가 만든 꼬리표를 붙인다.
 */
function uniqueName(used, value, makeId) {
  if (!used.has(value)) return value;
  const head = (count) => Array.from(value).slice(0, count).join('');
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${head(20)}(${n})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${head(18)}-${makeId().slice(0, 4)}`;
}

module.exports = { createSafeTimeout, uniqueName };
