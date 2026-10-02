'use strict';

/**
 * 갈팡질팡 힌트 - 데이터(단어·힌트 축)와 힌트가 지켜야 할 조건.
 *
 *   [데이터] 단어·태그·축이 서로 맞는다(오타로 조용히 빠진 태그가 없다). 같은 뜻의 축은 한 묶음이다
 *   [조건]   수천 판에서 힌트가 항상 만들어지고, 아래를 어기지 않는다
 *     1. A·B는 비교 가능한 개념(축의 두 극)이다
 *     2. 선택한 쪽이 정말 정답에 더 가깝다(정답의 특징에 있고, 반대쪽은 없다)
 *     3. 정답 단어·카테고리·상위 개념을 그대로 말하지 않고, 후보 이름도 담지 않는다
 *     4. 같은 뜻의 힌트를 반복하지 않는다(같은 묶음·같은 축·같은 글자)
 *     5. 라운드가 갈수록 구체적이다(평균 난이도가 올라간다)
 *   [난이도] 힌트를 다 알아도 후보가 목표(7개) 안팎으로 남고, 후보 하나를 콕 집어 주는 판이 없으며,
 *            어려운 축(느낌·기억·맥락처럼 겉으로 안 드러나는 개념)이 힌트의 상당수를 차지한다
 *   [해설] 은/는 조사가 맞는다
 *
 * 실행: node test/galpang-hint-test.js
 */

const { GameEngine } = require('../web/galpang/engine');
const { createRng } = require('../web/galpang/rng');
const { pickCandidates } = require('../web/galpang/generator');
const { buildPlan, sideOf, isDirect, leftAfter, topic } = require('../web/galpang/hint');
const WORDS = require('../web/galpang/data/words.json');
const AXES = require('../web/galpang/data/hints.json');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

// ── 데이터 ──
{
  const labels = AXES.flatMap((axis) => [axis.a, axis.b]);
  const known = new Set(labels);
  check('힌트 축 이름이 모두 다르다(A·B와 모든 축을 통틀어)', known.size === labels.length);
  check('축마다 id·묶음·난이도(1~5)·두 극이 있다', AXES.every((a) => a.id && a.group && a.level >= 1 && a.level <= 5 && a.a && a.b && a.a !== a.b));
  check('난이도 1~5마다 축이 22개 이상 있다', [1, 2, 3, 4, 5].every((level) => AXES.filter((a) => a.level === level).length >= 22), [1, 2, 3, 4, 5].map((l) => AXES.filter((a) => a.level === l).length).join(','));
  const hardAxes = AXES.filter((a) => a.hard);
  check('어려운 축(hard: true)이 40개 이상이고 난이도마다 5개 이상 있다', hardAxes.length >= 40 && [1, 2, 3, 4, 5].every((level) => hardAxes.filter((a) => a.level === level).length >= 5), [1, 2, 3, 4, 5].map((l) => hardAxes.filter((a) => a.level === l).length).join(','));
  check('hard는 true일 때만 적는다(쉬운 축에는 없다)', AXES.every((a) => a.hard === undefined || a.hard === true));
  check('축 id가 겹치지 않는다', new Set(AXES.map((a) => a.id)).size === AXES.length);
  // 같은 뜻으로 읽히는 축은 한 묶음이라, 한 판에 둘 이상 나오지 않는다.
  const groupOf = Object.fromEntries(AXES.map((a) => [a.id, a.group]));
  const cluster = [['sound', 'mood', 'tone'], ['company', 'crowd'], ['speed', 'motion', 'duration'], ['place', 'home'], ['warmth', 'swing', 'season'], ['size', 'carry'], ['feel', 'touch'], ['era', 'origin'], ['ordinary', 'often'], ['money', 'buy'], ['body', 'limb'], ['contest', 'rule']];
  check('비슷한 뜻의 축은 같은 묶음이다(조용함·차분함·진지함, 혼자·북적임 등)', cluster.every((ids) => new Set(ids.map((id) => groupOf[id])).size === 1),
    cluster.filter((ids) => new Set(ids.map((id) => groupOf[id])).size !== 1).map((ids) => ids.join('/')).join(' '));

  check('단어가 576개이고 이름이 겹치지 않는다', WORDS.length === 576 && new Set(WORDS.map((w) => w.name)).size === WORDS.length, `${WORDS.length}`);
  const names = WORDS.map((w) => w.name).filter((n) => n.length >= 2);
  const contained = WORDS.filter((w) => w.name.length >= 2 && names.some((n) => n !== w.name && w.name.includes(n)));
  check('다른 단어의 이름을 통째로 담은 단어가 없다(예: 축구/축구공)', contained.length === 0, contained.map((w) => w.name).join(','));
  const categories = new Map();
  for (const w of WORDS) categories.set(w.category, (categories.get(w.category) || 0) + 1);
  check('카테고리 12개, 각각 48개씩이다', categories.size === 12 && [...categories.values()].every((n) => n === 48), JSON.stringify([...categories]));
  const unknown = WORDS.flatMap((w) => w.tags.filter((t) => !known.has(t)).map((t) => `${w.name}:${t}`));
  check('모든 태그가 실제 축의 이름이다(오타 없음)', unknown.length === 0, unknown.join(','));
  const both = WORDS.flatMap((w) => AXES.filter((a) => w.tags.includes(a.a) && w.tags.includes(a.b)).map((a) => `${w.name}:${a.id}`));
  check('한 단어가 같은 축의 양쪽 극을 동시에 갖지 않는다(모순 없음)', both.length === 0, both.join(','));
  check('태그가 중복되지 않는다', WORDS.every((w) => new Set(w.tags).size === w.tags.length));
  const thin = WORDS.filter((w) => {
    const groups = new Set(AXES.filter((a) => sideOf(a, w)).map((a) => a.group));
    return w.tags.length < 9 || groups.size < 7;
  });
  check('모든 단어가 태그 9개 이상, 서로 다른 묶음 7개 이상에서 판단된다(어느 단어가 정답이어도 힌트 5개를 짤 수 있다)', thin.length === 0, thin.map((w) => w.name).join(','));
  const lopsided = AXES.filter((a) => WORDS.filter((w) => w.tags.includes(a.a)).length < 3 || WORDS.filter((w) => w.tags.includes(a.b)).length < 3);
  check('모든 축의 양쪽 극에 단어가 3개 이상 있다(한쪽만 쓰이는 축이 없다)', lopsided.length === 0, lopsided.map((a) => a.id).join(','));
  const hardThin = WORDS.filter((w) => hardAxes.filter((a) => sideOf(a, w)).length < 2);
  check('모든 단어가 어려운 축 2개 이상에서 판단된다(어느 단어가 정답이어도 어려운 힌트를 낼 수 있다)', hardThin.length === 0, hardThin.map((w) => w.name).join(','));
  const holes = WORDS.flatMap((w) => [1, 2, 3, 4, 5].filter((level) => !AXES.some((a) => a.level === level && sideOf(a, w))).map((level) => `${w.name}:L${level}`));
  check('모든 단어가 난이도 1~5마다 쓸 수 있는 힌트 축을 하나 이상 가진다(어느 라운드도 비지 않는다)', holes.length === 0, holes.join(','));
  const swallowed = AXES.flatMap((a) => [a.a, a.b]).flatMap((label) => names.filter((n) => label.includes(n)).map((n) => `${label}⊃${n}`));
  check('힌트 이름이 단어 이름을 담지 않는다(담으면 그 단어가 후보일 때마다 그 축을 못 쓴다)', swallowed.length === 0, swallowed.join(','));
  const hollow = WORDS.filter((w) => !w.parents || !w.parents.length);
  check('모든 단어에 상위 개념이 있다(힌트가 정답의 상위 개념을 말하지 않는지 검사하려고)', hollow.length === 0, hollow.map((w) => w.name).join(','));
}

// ── 조건: 많은 판에서 ──
{
  const SEEDS = 1500;
  let failures = 0; let firstFailure = '';
  const stats = { hints: 0, tier: [0, 0, 0, 0, 0], levelSum: [0, 0, 0, 0, 0, 0], near: 0, groupRepeat: 0, left: [], hard: 0 };
  const flaws = {};
  const flag = (what, seed) => { flaws[what] = flaws[what] || seed; };
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    let engine;
    try { engine = new GameEngine({ seed }); } catch (err) { failures += 1; firstFailure = firstFailure || `seed ${seed}: ${err.message}`; continue; }
    const { plan, answer, candidates } = engine.state;
    if (plan.length !== 5 || plan.some((h, i) => h.round !== i + 1)) flag('라운드 번호가 1~5가 아님', seed);
    const labels = []; const axes = new Set(); const groups = new Set();
    for (const hint of plan) {
      const axis = AXES.find((a) => a.id === hint.axis);
      stats.hints += 1; stats.tier[hint.tier] += 1; stats.levelSum[hint.round] += hint.level;
      if (axis.hard) stats.hard += 1;
      if (Math.abs(hint.level - hint.round) <= 1) stats.near += 1;
      // 1. 두 극이다
      if (!(hint.optionA === axis.a && hint.optionB === axis.b) && !(hint.optionA === axis.b && hint.optionB === axis.a)) flag('A·B가 축의 두 극이 아님', seed);
      // 2. 선택한 쪽이 정답의 특징이고, 반대쪽은 아니다
      const chosen = hint.selected === 'A' ? hint.optionA : hint.optionB;
      const other = hint.selected === 'A' ? hint.optionB : hint.optionA;
      if (!answer.tags.includes(chosen) || answer.tags.includes(other)) flag('선택한 쪽이 정답과 가깝지 않음', seed);
      // 3. 정답·상위 개념·후보 이름을 말하지 않는다
      if (isDirect(axis, answer, candidates)) flag('정답/상위 개념/후보 이름을 직접 말함', seed);
      for (const label of [hint.optionA, hint.optionB]) {
        if (label.includes(answer.name) || label.includes(answer.category) || answer.parents.some((p) => label === p)) flag('정답·카테고리를 그대로 말함', seed);
        if (candidates.some((c) => c.name.length >= 2 && label.includes(c.name))) flag('후보 이름을 담음', seed);
        labels.push(label);
      }
      // 4. 반복하지 않는다
      if (axes.has(hint.axis)) flag('같은 축을 두 번 씀', seed);
      axes.add(hint.axis);
      if (groups.has(hint.group)) stats.groupRepeat += 1;
      groups.add(hint.group);
      if (hint.reason.indexOf(answer.name) !== 0 || !hint.reason.includes(`'${chosen}'`) || !hint.reason.includes(`'${other}'`)) flag('해설이 선택과 맞지 않음', seed);
    }
    if (new Set(labels).size !== labels.length) flag('같은 글자의 선택지를 되풀이함', seed);
    if (plan.every((h) => h.selected === 'A') || plan.every((h) => h.selected === 'B')) stats.sameSide = (stats.sameSide || 0) + 1;
    stats.left.push(leftAfter(plan, AXES, candidates));
  }
  check(`${SEEDS}판: 힌트 5개가 항상 만들어진다`, failures === 0, firstFailure);
  const RULES = [
    ['라운드 번호가 1~5가 아님', '라운드 번호가 1부터 5까지 차례로 붙는다'],
    ['A·B가 축의 두 극이 아님', 'A·B는 비교할 수 있는 한 축의 두 극이다'],
    ['선택한 쪽이 정답과 가깝지 않음', '선택한 쪽은 정답의 특징이고 반대쪽은 아니다(정답에 더 가깝다)'],
    ['정답/상위 개념/후보 이름을 직접 말함', '정답·상위 개념·후보 이름을 직접 말하지 않는다'],
    ['정답·카테고리를 그대로 말함', '선택지가 정답 단어나 카테고리 이름이 아니다'],
    ['후보 이름을 담음', '선택지에 후보 이름이 들어 있지 않다'],
    ['같은 축을 두 번 씀', '같은 축을 두 번 쓰지 않는다'],
    ['같은 글자의 선택지를 되풀이함', '같은 글자의 선택지를 되풀이하지 않는다'],
    ['해설이 선택과 맞지 않음', '해설이 선택한 쪽과 반대쪽을 정확히 말한다'],
  ];
  for (const [key, text] of RULES) check(`${SEEDS}판: ${text}`, !flaws[key], flaws[key] ? `예: seed ${flaws[key]}` : '');
  check('같은 묶음(같은 뜻)의 힌트가 한 판에 둘 나오는 일은 드물다(1% 미만)', stats.groupRepeat / stats.hints < 0.01, `${stats.groupRepeat}/${stats.hints}`);
  check('힌트의 95% 이상이 가장 엄격한 두 기준(후보를 충분히 가르는 힌트)으로 골라진다', (stats.tier[0] + stats.tier[1]) / stats.hints >= 0.95, stats.tier.join(','));
  check('정답 하나만 콕 집는 직접적인 힌트(마지막 기준)는 1% 미만이다', (stats.tier[2] + stats.tier[3] + stats.tier[4]) / stats.hints < 0.01, stats.tier.join(','));
  const average = [1, 2, 3, 4, 5].map((round) => stats.levelSum[round] / (SEEDS - failures));
  check('라운드가 갈수록 힌트가 구체적이다(평균 난이도가 1<2<3<4≤5 순으로 오른다)', average[0] < average[1] && average[1] < average[2] && average[2] < average[3] && average[3] <= average[4] + 0.05, average.map((v) => v.toFixed(2)).join(' → '));
  check('ROUND 1은 매우 추상적, 5는 가장 구체적이다(평균 난이도 1.5 이하 / 3.8 이상)', average[0] <= 1.5 && average[4] >= 3.8, average.map((v) => v.toFixed(2)).join(' → '));
  check('힌트의 90% 이상이 그 라운드가 바라는 난이도에서 한 단계 안이다', stats.near / stats.hints >= 0.9, `${(stats.near / stats.hints * 100).toFixed(1)}%`);
  // 난이도: 힌트를 다 쓰고도 후보가 목표(7개) 안팎으로 남는다. 후보를 콕 집어 주거나 거의 못 줄이는 판은 드물다.
  const n = stats.left.length;
  const mean = stats.left.reduce((a, b) => a + b, 0) / n;
  const share = (ok) => stats.left.filter(ok).length / n;
  check('힌트 5개를 다 써도 후보가 평균 6~8개 남는다(예전에는 평균 4.2개였다)', mean >= 6 && mean <= 8, `평균 ${mean.toFixed(2)}`);
  check('85% 이상의 판에서 후보가 5~9개 남는다', share((v) => v >= 5 && v <= 9) >= 0.85, `${(share((v) => v >= 5 && v <= 9) * 100).toFixed(1)}%`);
  check('후보가 3개 이하로 줄어 정답이 거의 드러나는 판은 5% 미만이다', share((v) => v <= 3) < 0.05, `${(share((v) => v <= 3) * 100).toFixed(1)}%`);
  check('후보가 11개 이상 남아 힌트가 거의 쓸모없는 판은 3% 미만이다', share((v) => v >= 11) < 0.03, `${(share((v) => v >= 11) * 100).toFixed(1)}%`);
  check('어려운 축이 힌트의 40% 이상을 차지한다', stats.hard / stats.hints >= 0.4, `${(stats.hard / stats.hints * 100).toFixed(1)}%`);
  {
    // 이상적인 풀이자(힌트로 걸러지는 후보만 지우고 남은 것 중 무작위로 하나를 낸다)가 맞힐 확률이 낮다.
    const ideal = stats.left.reduce((a, v) => a + 1 / v, 0) / n;
    check('힌트를 완벽히 따라가도 정답을 맞힐 확률이 20% 이하다(예전에는 29%였다)', ideal <= 0.2, `${(ideal * 100).toFixed(1)}%`);
  }
  check('힌트가 한쪽(늘 A 또는 늘 B)으로 쏠리지 않는다(5개가 모두 같은 쪽인 판은 10% 이하)', (stats.sameSide || 0) / SEEDS <= 0.1, `${stats.sameSide}`);
}

// ── 어느 단어가 정답이어도 ──
{
  const problems = []; let tiers = 0; let total = 0;
  for (const word of WORDS) {
    for (let k = 0; k < 4; k += 1) {
      // 그 단어가 후보에 들어 있는 판을 하나 찾는다.
      let candidates; let answer;
      for (let seed = 1 + k * 1000; seed < 1000 + k * 1000 && !answer; seed += 1) {
        candidates = pickCandidates(WORDS, createRng(seed, 'candidates'), 16);
        answer = candidates.find((c) => c.name === word.name);
      }
      if (!answer) { problems.push(`${word.name}: 후보로 뽑히는 판을 못 찾음`); continue; }
      try {
        const plan = buildPlan({ answer, candidates, axes: AXES, rng: createRng(k, 'hints'), rounds: 5 });
        for (const hint of plan) { total += 1; if (hint.tier >= 3) tiers += 1; }
      } catch (err) { problems.push(`${word.name}: ${err.message}`); }
    }
  }
  check(`${WORDS.length}개 단어 모두 정답이 되었을 때 힌트 5개를 짤 수 있다`, problems.length === 0, problems.slice(0, 5).join(' / '));
  check('어느 단어가 정답이어도 안전망(태그가 적을 때의 마지막 기준)은 거의 쓰이지 않는다(1% 미만)', tiers / total < 0.01, `${tiers}/${total}`);
}

// ── 해설 조사 ──
{
  check('은/는: 받침이 있으면 은, 없으면 는', topic('수영') === '은' && topic('축구') === '는' && topic('피자') === '는' && topic('라면') === '은' && topic('그림 그리기') === '는' && topic('비') === '는' && topic('눈') === '은');
  const engine = new GameEngine({ seed: 3, debug: true });
  const sample = engine.debugInfo().plan[0].reason;
  const name = engine.state.answer.name;
  check('해설은 "정답은 \'선택\' 쪽이 \'다른 쪽\'보다 더 가까운 개념으로 판단했습니다." 모양이다', new RegExp(`^${name}(은|는) '.+' 쪽이 '.+'보다 더 가까운 개념으로 판단했습니다\\.$`).test(sample), sample);
}

console.log(`\n갈팡질팡 힌트: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
