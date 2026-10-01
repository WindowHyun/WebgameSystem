'use strict';

const { Candidate } = require('./candidate');

/**
 * 후보 16개를 뽑는다. 단어 은행(data/words.json)에서 카테고리를 돌아가며 한 개씩 뽑기 때문에
 * 한 카테고리가 두 개를 넘지 않는다(12개 카테고리 → 16개 = 모두 1개씩 + 4개 카테고리에서 1개 더).
 * 이름이 같은 단어는 은행에 없지만, 만일을 위해 여기서도 한 번 더 걸러 중복을 막는다.
 */
function pickCandidates(words, rng, count) {
  const byCategory = new Map();
  const seen = new Set();
  for (const word of words) {
    if (seen.has(word.name)) continue;
    seen.add(word.name);
    if (!byCategory.has(word.category)) byCategory.set(word.category, []);
    byCategory.get(word.category).push(word);
  }
  if (seen.size < count) throw new Error(`단어가 ${count}개보다 적습니다(${seen.size}개).`);
  const pools = new Map([...byCategory].map(([category, list]) => [category, rng.shuffle(list)]));
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
