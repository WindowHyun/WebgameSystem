'use strict';

/**
 * 힌트 시스템.
 *
 * 힌트는 "비교할 수 있는 두 개념(A/B)" 중 정답에 더 가까운 쪽을 알려 준다. 개념 쌍은 data/hints.json의
 * "축"이다(예: 혼자 ↔ 여럿). 단어는 data/words.json의 tags로 자기가 어느 쪽에 가까운지 말한다
 * (태그가 없는 축은 판단하지 않는다).
 *
 * 한 판의 힌트 5개는 게임을 시작할 때 한꺼번에 정해 두고(plan), 라운드가 올라갈 때 하나씩 공개한다.
 * 그래서 사용자가 무엇을 해도(후보 제거, 오답 등) 같은 seed면 같은 힌트가 나오고, 같은 라운드의 힌트를
 * 다시 만들 수 없다.
 *
 * 공개 전에 아래 조건을 모두 검사한다. 하나라도 어긋나면 다른 축을 고른다.
 *   1. A·B가 비교 가능한 개념이다(축의 두 극이다)
 *   2. 정답이 한쪽에 분명히 더 가깝다(정답이 그 축에 태그가 있다)
 *   3. 정답 단어나 그 상위 개념을 직접 말하지 않고, 후보 이름도 담지 않는다
 *   4. 앞의 힌트와 같은 뜻이 아니다(같은 묶음(group)의 축은 한 판에 한 번만)
 *   5. 두 선택지가 사실상 같은 뜻이 아니다(축을 만들 때 보장 - test/galpang-hint-test.js가 확인한다)
 * 거기에 더해 "쓸모 있는 힌트"인지 본다: 후보 16개를 실제로 갈라 줘야 한다(한쪽에 몰려 있거나 정답 하나만
 * 콕 집어내는 힌트는 피한다).
 */

const { MAX_ROUND } = require('./state');

// 쓸모 있는 힌트의 기준. 앞에서부터 시도하고, 기준을 만족하는 축이 없을 때만 다음으로 내려간다.
//   minSame      정답과 같은 쪽 후보 수(정답 포함). 1이면 정답 하나만 콕 집는 직접적인 힌트다.
//   minOpposite  반대쪽 후보 수. 이만큼은 걸러 낼 수 있어야 힌트다.
//   minJudged    이 축으로 판단할 수 있는 후보 수(나머지는 판단하지 않음)
//   maxDistance  라운드가 바라는 난이도에서 벗어나도 되는 폭
//   repeatGroup  같은 묶음의 축을 한 판에 또 써도 되는가(태그가 아주 적은 단어를 위한 마지막 수단)
// 뒤의 기준은 거의 쓰이지 않는다 - 어떤 단어·후보 조합에서도 게임이 멈추지 않게 하는 안전망이다.
const TIERS = [
  { minSame: 2, minOpposite: 3, minJudged: 5, maxDistance: 2, repeatGroup: false },
  { minSame: 2, minOpposite: 2, minJudged: 4, maxDistance: 4, repeatGroup: false },
  { minSame: 1, minOpposite: 1, minJudged: 3, maxDistance: 4, repeatGroup: false },
  { minSame: 1, minOpposite: 0, minJudged: 1, maxDistance: 4, repeatGroup: false },
  { minSame: 1, minOpposite: 0, minJudged: 1, maxDistance: 4, repeatGroup: true },
];
const ATTEMPTS = 80;       // 힌트 5개를 새로 짜 보는 횟수
const GOOD_ENOUGH_LEFT = 3; // 5개를 다 쓰면 남는 후보가 이 이하면 잘 짠 것이다

/** 후보가 이 축에서 어느 쪽인지: 'A' | 'B' | null(판단하지 않음). */
function sideOf(axis, candidate) {
  const hasA = candidate.tags.includes(axis.a);
  const hasB = candidate.tags.includes(axis.b);
  if (hasA === hasB) return null; // 둘 다 없거나(모름) 둘 다 있으면(모순) 판단하지 않는다
  return hasA ? 'A' : 'B';
}

/** 축의 이름이 정답이나 그 상위 개념을 그대로 말하거나, 후보 이름을 담고 있는가(조건 3). */
function isDirect(axis, answer, candidates) {
  const terms = [answer.name, answer.category, ...answer.parents];
  for (const label of [axis.a, axis.b]) {
    for (const term of terms) {
      if (label === term) return true;
      if (term.length >= 2 && label.length >= 2 && (label.includes(term) || term.includes(label))) return true;
    }
    for (const candidate of candidates) {
      if (candidate.name.length >= 2 && label.includes(candidate.name)) return true;
    }
  }
  return false;
}

/** 은/는 */
function topic(word) {
  const code = word.charCodeAt(word.length - 1);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? '은' : '는';
  return '는';
}

function reasonFor(answer, chosen, other) {
  return `${answer.name}${topic(answer.name)} '${chosen}' 쪽이 '${other}'보다 더 가까운 개념으로 판단했습니다.`;
}

/** 라운드가 바라는 난이도 level에서 distance만큼 떨어진 난이도들(1~5 안). */
function levelsAt(level, distance) {
  const levels = distance === 0 ? [level] : [level + distance, level - distance];
  return levels.filter((value) => value >= 1 && value <= MAX_ROUND);
}

/** 힌트 한 라운드를 고른다. 못 찾으면 null. */
function chooseHint({ round, answer, candidates, axes, rng, used }) {
  const judged = axes
    .filter((axis) => !used.axes.has(axis.id))
    .map((axis) => {
      const answerSide = sideOf(axis, answer);
      if (!answerSide || isDirect(axis, answer, candidates)) return null;
      let same = 0;
      let opposite = 0;
      for (const candidate of candidates) {
        const side = sideOf(axis, candidate);
        if (side === answerSide) same += 1;
        else if (side) opposite += 1;
      }
      return { axis, answerSide, same, opposite, judged: same + opposite };
    })
    .filter(Boolean);

  for (const [tierIndex, tier] of TIERS.entries()) {
    for (let distance = 0; distance <= tier.maxDistance; distance += 1) {
      const levels = levelsAt(round, distance);
      const pool = judged.filter((entry) => levels.includes(entry.axis.level)
        && (tier.repeatGroup || !used.groups.has(entry.axis.group))
        && entry.same >= tier.minSame && entry.opposite >= tier.minOpposite && entry.judged >= tier.minJudged);
      if (!pool.length) continue;
      const { axis, answerSide } = rng.pick(pool);
      const flip = rng.chance(0.5); // 정답이 늘 A에 오지 않게 한다
      const poles = flip ? [axis.b, axis.a] : [axis.a, axis.b];
      const chosen = answerSide === 'A' ? axis.a : axis.b;
      const other = answerSide === 'A' ? axis.b : axis.a;
      return {
        round,
        axis: axis.id,
        group: axis.group,
        level: axis.level,
        optionA: poles[0],
        optionB: poles[1],
        selected: poles[0] === chosen ? 'A' : 'B',
        side: answerSide, // 축 기준으로 정답이 어느 쪽인가(남는 후보 계산용)
        tier: tierIndex,  // 어느 기준으로 골랐나(0이 가장 엄격 - 진단용)
        reason: reasonFor(answer, chosen, other),
      };
    }
  }
  return null;
}

/** 힌트를 다 쓰고도 후보 중 몇 개가 모순 없이 남는가(판단하지 않은 후보는 남는 것으로 센다). */
function leftAfter(plan, axes, candidates) {
  const byId = new Map(axes.map((axis) => [axis.id, axis]));
  return candidates.filter((candidate) => plan.every((hint) => {
    const side = sideOf(byId.get(hint.axis), candidate);
    return side === null || side === hint.side;
  })).length;
}

function draft({ answer, candidates, axes, rng, rounds }) {
  const used = { groups: new Set(), axes: new Set() };
  const plan = [];
  for (let round = 1; round <= rounds; round += 1) {
    const hint = chooseHint({ round, answer, candidates, axes, rng, used });
    if (!hint) return null;
    used.groups.add(hint.group);
    used.axes.add(hint.axis);
    plan.push(hint);
  }
  return plan;
}

/**
 * 라운드별 힌트를 정한다. 5개를 짜 보고, 다 쓰고도 남는 후보가 너무 많으면(= 힌트가 서로 겹쳐 후보를 못
 * 줄이면) 다시 짠다. 끝까지 못 줄여도 가장 잘 줄인 것을 쓴다 - 게임이 멈추면 안 된다.
 */
function buildPlan({ answer, candidates, axes, rng, rounds }) {
  let best = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const plan = draft({ answer, candidates, axes, rng, rounds: rounds || MAX_ROUND });
    if (!plan) continue;
    const left = leftAfter(plan, axes, candidates);
    if (!best || left < best.left) best = { plan, left };
    if (left <= GOOD_ENOUGH_LEFT) break;
  }
  if (!best) throw new Error('힌트를 만들지 못했습니다.');
  return best.plan;
}

/** 화면에 내보내는 힌트(속마음·정답 기준은 뺀다). */
function publicHint(hint) {
  return { round: hint.round, optionA: hint.optionA, optionB: hint.optionB, selected: hint.selected };
}

module.exports = { buildPlan, publicHint, leftAfter, sideOf, isDirect, topic, TIERS, GOOD_ENOUGH_LEFT };
