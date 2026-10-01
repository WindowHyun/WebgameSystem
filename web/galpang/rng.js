'use strict';

/**
 * 재현 가능한 난수. 같은 seed면 같은 수열이 나온다(테스트·`--seed` 재현용).
 * 후보·정답·힌트가 서로의 난수를 끌어다 쓰지 않도록 용도(label)마다 따로 갈라 쓴다 -
 * 힌트를 만드는 도중 난수를 몇 번 더 써도 정답이 바뀌지 않는다.
 */

/** 문자열 → 32비트 정수(FNV-1a). */
function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: 작고 빠르며 분포가 고르다. 0 이상 1 미만을 낸다. */
function mulberry32(start) {
  let a = start >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRng(seed, label) {
  const next = mulberry32(hashSeed(`${seed}:${label || ''}`));
  const int = (n) => Math.floor(next() * n);
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (list) => list[int(list.length)],
    /** 새 배열을 돌려준다(원본은 그대로). */
    shuffle: (list) => {
      const copy = list.slice();
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
}

module.exports = { createRng, hashSeed };
