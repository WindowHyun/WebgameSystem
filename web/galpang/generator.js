'use strict';

const { Candidate } = require('./candidate');

/**
 * 후보 count개를 뽑는다. 단어 은행(data/words.json)에서 spread개의 카테고리를 무작위로 고르고, 그 카테고리를 돌아가며
 * 한 개씩 뽑는다(16개를 5개 카테고리에서 뽑으면 3~4개씩). 비슷한 종류끼리 모여 있어야 힌트 하나로 카테고리째
 * 걸러지지 않아 어렵다. spread가 없으면 모든 카테고리에서 고르게 뽑는다(옛 방식). 고른 카테고리의 단어가 모자라면
 * 다른 카테고리를 더한다. 이름이 같은 단어는 은행에 없지만, 만일을 위해 여기서도 한 번 더 걸러 중복을 막는다.
 */
function pickCandidates(words, rng, count, spread) {
  const byCategory = new Map();
  const seen = new Set();
  for (const word of words) {
    if (seen.has(word.name)) continue;
    seen.add(word.name);
    if (!byCategory.has(word.category)) byCategory.set(word.category, []);
    byCategory.get(word.category).push(word);
  }
  if (seen.size < count) throw new Error(`단어가 ${count}개보다 적습니다(${seen.size}개).`);
  const order = rng.shuffle([...byCategory.keys()]);
  const chosen = [];
  let available = 0;
  for (const category of order) {
    const enough = available >= count && chosen.length >= Math.min(spread || order.length, order.length);
    if (enough) break;
    chosen.push(category);
    available += byCategory.get(category).length;
  }
  const pools = new Map(chosen.map((category) => [category, rng.shuffle(byCategory.get(category))]));
  const picked = [];
  while (picked.length < count) {
    for (const category of rng.shuffle([...pools.keys()])) {
      if (picked.length >= count) break;
      const pool = pools.get(category);
      if (pool.length) picked.push(pool.pop());
    }
  }
  // 번호가 카테고리 순서로 붙지 않게 섞는다.
  return rng.shuffle(picked).map((word, index) => new Candidate({ id: index + 1, ...word }));
}

function chooseAnswer(candidates, rng) {
  return rng.pick(candidates);
}

module.exports = { pickCandidates, chooseAnswer };
