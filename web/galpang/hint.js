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
//   minJudged    이 축으로 판단할 수 있는 후보 수(나머지는 판단하지 않음). 어려운 축은 DIFFICULTY.hardJudged로 낮춘다.
//   maxDistance  라운드가 바라는 난이도에서 벗어나도 되는 폭
//   repeatGroup  같은 묶음의 축을 한 판에 또 써도 되는가(태그가 아주 적은 단어를 위한 마지막 수단)
// 뒤의 기준은 거의 쓰이지 않는다 - 어떤 단어·후보 조합에서도 게임이 멈추지 않게 하는 안전망이다.
const TIERS = [
  { minSame: 2, minOpposite: 2, minJudged: 4, maxDistance: 2, repeatGroup: false },
  { minSame: 2, minOpposite: 1, minJudged: 3, maxDistance: 4, repeatGroup: false },
  { minSame: 1, minOpposite: 1, minJudged: 3, maxDistance: 4, repeatGroup: false },
  { minSame: 1, minOpposite: 0, minJudged: 1, maxDistance: 4, repeatGroup: false },
  { minSame: 1, minOpposite: 0, minJudged: 1, maxDistance: 4, repeatGroup: true },
];
const ATTEMPTS = 120;      // 힌트 5개를 새로 짜 보는 횟수

/**
 * 난이도. 시험·시뮬레이션이 바꿔 보려고 GameEngine의 difficulty 옵션으로도 줄 수 있다.
 *   target     힌트 5개를 다 쓰고도 남는 후보 수의 목표(태그로 판단되지 않는 후보는 남는 것으로 센다).
 *              예전에는 5개를 80번 짜 보고 후보가 가장 적게 남는 것을 골랐다(목표 3개 이하). 그러면 어느 판이든 힌트만
 *              따라가면 정답이 거의 드러나서 너무 쉬웠다. 이제는 목표 개수 안팎으로 남는 판을 고른다 - 힌트를 다
 *              알아도 몇 개 사이에서 골라야 하고, 후보 하나를 정답으로 콕 집어 주는 판은 만들지 않는다.
 *   tolerance  목표에서 이만큼까지 벗어난 판은 그대로 쓴다. 못 찾으면 목표에 가장 가까운 판을 쓴다.
 *   hardShare  쓸 수 있는 힌트 중 "어려운 축"(hints.json에서 hard로 표시한, 느낌·기억·맥락처럼 겉으로 안 드러나는 개념)이
 *              있으면 이 확률로 그쪽에서 고른다(1이면 있을 때는 늘 어려운 축). 어려운 축은 단어마다 판단되는 후보가 적어서, 판단할 수 있는 후보가
 *              hardJudged개 이상이면 쓴다(쉬운 축은 tier의 minJudged).
 */
const DIFFICULTY = { target: 7, tolerance: 1, hardShare: 1, hardJudged: 3 };

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
    // 정답 이름은 한 글자(예: 책, 꽃)여도 그 글자를 담은 이름("책임이 따름")은 정답을 암시해 보이므로 쓰지 않는다.
    if (label.includes(answer.name)) return true;
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

/**
 * 한 판의 후보·정답이 정해지면 축마다 한 번만 계산해 둔다(후보 16개가 각 축에서 어느 쪽인지, 정답과 같은 쪽·반대쪽이
 * 몇 개인지). 힌트를 짜는 동안 같은 계산을 라운드·시도마다 되풀이하면 축이 늘수록 한 판을 만드는 데 시간이 걸린다.
 * 정답을 말하는 축(isDirect)이나 정답이 판단되지 않는 축은 쓸 수 없는 축(usable: false)이다.
 */
function analyze(answer, candidates, axes) {
  return axes.map((axis) => {
    const answerSide = sideOf(axis, answer);
    if (!answerSide || isDirect(axis, answer, candidates)) return { axis, usable: false };
    const sides = candidates.map((candidate) => sideOf(axis, candidate));
    let same = 0;
    let opposite = 0;
    for (const side of sides) {
      if (side === answerSide) same += 1;
      else if (side) opposite += 1;
    }
    return { axis, usable: true, answerSide, sides, same, opposite, judged: same + opposite };
  });
}

/** 힌트 한 라운드를 고른다. 못 찾으면 null. */
function chooseHint({ round, answer, analysis, rng, used, difficulty }) {
  const level = difficulty || DIFFICULTY;
  const judged = analysis.filter((entry) => entry.usable && !used.axes.has(entry.axis.id));

  for (const [tierIndex, tier] of TIERS.entries()) {
    for (let distance = 0; distance <= tier.maxDistance; distance += 1) {
      const levels = levelsAt(round, distance);
      const pool = judged.filter((entry) => levels.includes(entry.axis.level)
        && (tier.repeatGroup || !used.groups.has(entry.axis.group))
        && entry.same >= tier.minSame && entry.opposite >= tier.minOpposite
        && entry.judged >= (entry.axis.hard ? Math.min(tier.minJudged, level.hardJudged) : tier.minJudged));
      if (!pool.length) continue;
      const hard = pool.filter((entry) => entry.axis.hard);
      const { axis, answerSide } = rng.pick(hard.length && rng.chance(level.hardShare) ? hard : pool);
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

/** leftAfter와 같은 값을 미리 계산해 둔 판단(analysis)으로 구한다. */
function leftFromAnalysis(plan, analysis, candidateCount) {
  const byId = new Map(analysis.map((entry) => [entry.axis.id, entry]));
  let left = 0;
  for (let i = 0; i < candidateCount; i += 1) {
    if (plan.every((hint) => { const side = byId.get(hint.axis).sides[i]; return side === null || side === hint.side; })) left += 1;
  }
  return left;
}

function draft({ answer, analysis, rng, rounds, difficulty }) {
  const used = { groups: new Set(), axes: new Set() };
  const plan = [];
  for (let round = 1; round <= rounds; round += 1) {
    const hint = chooseHint({ round, answer, analysis, rng, used, difficulty });
    if (!hint) return null;
    used.groups.add(hint.group);
    used.axes.add(hint.axis);
    plan.push(hint);
  }
  return plan;
}

/**
 * 라운드별 힌트를 정한다. 5개를 짜 보고, 다 쓰고 남는 후보 수가 난이도(difficulty)의 목표 안팎(target ± tolerance)이면
 * 그것을 쓴다. 아니면 다시 짜서, 끝까지 못 찾아도 목표에 가장 가까운 것을 쓴다 - 게임이 멈추면 안 된다.
 */
function buildPlan({ answer, candidates, axes, rng, rounds, difficulty }) {
  const level = difficulty || DIFFICULTY;
  const analysis = analyze(answer, candidates, axes);
  let best = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const plan = draft({ answer, analysis, rng, rounds: rounds || MAX_ROUND, difficulty: level });
    if (!plan) continue;
    const left = leftFromAnalysis(plan, analysis, candidates.length);
    if (!best || Math.abs(left - level.target) < Math.abs(best.left - level.target)) best = { plan, left };
    if (Math.abs(left - level.target) <= level.tolerance) break;
  }
  if (!best) throw new Error('힌트를 만들지 못했습니다.');
  return best.plan;
}

/** 화면에 내보내는 힌트(속마음·정답 기준은 뺀다). */
function publicHint(hint) {
  return { round: hint.round, optionA: hint.optionA, optionB: hint.optionB, selected: hint.selected };
}

module.exports = { buildPlan, publicHint, leftAfter, sideOf, isDirect, topic, TIERS, DIFFICULTY };
