'use strict';

/**
 * 갈팡질팡 규칙 엔진(web/galpang/engine.js) - 브라우저 없이 규칙만 본다.
 *
 *   - 게임 생성: 후보 16개, 중복 없음, 카테고리가 한쪽으로 쏠리지 않음, 정답은 후보 안에 하나
 *   - seed: 같은 seed면 후보·정답·힌트가 같고, 다른 seed면 다르다. 정답은 힌트 계산과 무관하다
 *   - 상태 머신: INIT → PLAYING → WON | LOST | QUIT, 끝난 게임은 restart로만 다시 시작
 *   - 후보 제거: 정상·중복·이미 제거·범위 밖·소수·여러 개. 정답 후보도 막지 않는다(막으면 정답이 드러난다)
 *   - 정답 제출은 한 번뿐: 맞히면 WON, 틀리면 그 자리에서 LOST(정답 공개). 제거한 후보·범위 밖 번호는 판정하지 않는다
 *   - 라운드: next만 올린다. 5라운드에서 next면 LOST. 제거 상태는 라운드가 바뀌어도 유지된다
 *   - 비공개: 끝나기 전에는 정답·해설·후보의 특징이 어떤 조회 결과에도 없다
 *   - 불변 조건: 아무렇게나 눌러도(무작위 명령 수천 번) 항상 유지된다
 *
 * 실행: node test/galpang-engine-test.js
 */

const { GameEngine, STATUS, CANDIDATE_COUNT, MAX_ROUND } = require('../web/galpang/engine');
const { createRng } = require('../web/galpang/rng');
const WORDS = require('../web/galpang/data/words.json');
const AXES = require('../web/galpang/data/hints.json');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const namesOf = (engine) => engine.state.candidates.map((c) => c.name);
const answerOf = (engine) => engine.state.answer;
const wrongId = (engine) => engine.state.candidates.find((c) => c.id !== answerOf(engine).id && !c.removed).id;

// ── 게임 생성 ──
{
  let ok = true; let detail = '';
  const categories = new Set(WORDS.map((w) => w.category));
  for (let seed = 1; seed <= 300 && ok; seed += 1) {
    const e = new GameEngine({ seed });
    const names = namesOf(e);
    const perCategory = {};
    for (const c of e.state.candidates) perCategory[c.category] = (perCategory[c.category] || 0) + 1;
    if (e.state.candidates.length !== CANDIDATE_COUNT) { ok = false; detail = `seed ${seed}: 후보 ${e.state.candidates.length}개`; }
    else if (new Set(names).size !== CANDIDATE_COUNT) { ok = false; detail = `seed ${seed}: 이름 중복`; }
    else if (!e.state.candidates.includes(e.state.answer)) { ok = false; detail = `seed ${seed}: 정답이 후보에 없음`; }
    else if (Object.keys(perCategory).length !== categories.size || Math.max(...Object.values(perCategory)) > 2) { ok = false; detail = `seed ${seed}: ${JSON.stringify(perCategory)}`; }
    else if (!same(e.state.candidates.map((c) => c.id), Array.from({ length: CANDIDATE_COUNT }, (_, i) => i + 1))) { ok = false; detail = `seed ${seed}: 번호가 1~16이 아님`; }
  }
  check('300판: 후보는 늘 16개, 이름이 겹치지 않고, 번호는 1~16, 정답은 후보 안에 있다', ok, detail);
  check('300판: 12개 카테고리가 모두 나오고 한 카테고리는 2개를 넘지 않는다', ok, detail);
  const e = new GameEngine({ seed: 1 });
  check('시작하면 PLAYING, 라운드 1, 제거·오답·힌트 기록: 힌트 1개만 공개', e.status === STATUS.PLAYING && e.round === 1 && e.state.removedCandidates.size === 0
    && e.state.wrongGuesses.length === 0 && e.state.hintHistory.length === 1 && e.state.maxRound === MAX_ROUND);
  check('시작 전이는 INIT → PLAYING 한 번이다', same(e.transitions, ['→ INIT', 'INIT → PLAYING']), e.transitions.join(', '));
  const answers = new Set();
  for (let seed = 1; seed <= 400; seed += 1) answers.add(new GameEngine({ seed }).state.answer.name);
  check('정답이 한 단어로 쏠리지 않는다(400판에서 200개 넘는 단어가 정답이 된다)', answers.size > 200, `${answers.size}개`);
}

// ── seed ──
{
  const snapshot = (e) => ({ names: namesOf(e), answer: e.state.answer.name, plan: e.state.plan.map((h) => [h.axis, h.optionA, h.optionB, h.selected, h.reason]) });
  check('같은 seed → 후보·정답·힌트가 모두 같다', same(snapshot(new GameEngine({ seed: 100 })), snapshot(new GameEngine({ seed: 100 }))));
  check('문자열 seed도 같은 게임을 만든다', same(snapshot(new GameEngine({ seed: 'abc' })), snapshot(new GameEngine({ seed: 'abc' }))));
  let differs = 0;
  for (let seed = 1; seed <= 50; seed += 1) if (!same(snapshot(new GameEngine({ seed })), snapshot(new GameEngine({ seed: seed + 1 })))) differs += 1;
  check('다른 seed → 다른 게임이다', differs >= 49, `${differs}/50`);
  // 힌트를 만드는 데 난수를 얼마나 쓰든 후보·정답은 그대로여야 한다(용도별로 난수를 갈라 쓴다).
  let stable = true;
  for (let seed = 1; seed <= 40; seed += 1) {
    const a = new GameEngine({ seed });
    const b = new GameEngine({ seed, axes: AXES.slice().reverse() });
    if (!same(namesOf(a), namesOf(b)) || a.state.answer.name !== b.state.answer.name) stable = false;
  }
  check('힌트 축을 바꿔도 후보와 정답은 같다(난수가 서로 섞이지 않는다)', stable);
  const a = new GameEngine({ seed: 9 });
  const b = new GameEngine({ seed: 9 });
  a.remove([1, 2]); a.guess(1); a.next(); a.next(); // 제거한 후보를 낸 것은 판정하지 않는다
  b.next(); b.next();
  check('사용자가 무엇을 했는지와 상관없이 같은 seed면 같은 힌트가 나온다', same(a.history(), b.history()));
  check('seed를 주지 않으면 무작위다(같은 게임이 반복되지 않는다)', new Set(Array.from({ length: 12 }, () => new GameEngine().state.answer.name + namesOf(new GameEngine()).join())).size > 1);
}

// ── 후보 제거 ──
{
  const e = new GameEngine({ seed: 5 });
  let r = e.remove([3]);
  check('remove 3: 3번이 제거된다', r.ok && same(r.removed, [3]) && e.state.candidates[2].removed && e.state.removedCandidates.has(3) && r.remaining === 15, JSON.stringify(r));
  r = e.remove([3]);
  check('이미 제거한 후보는 상태를 바꾸지 않고 알려 준다', r.ok && same(r.alreadyRemoved, [3]) && r.removed.length === 0 && e.state.removedCandidates.size === 1 && e.remainingIds().length === 15, JSON.stringify(r));
  r = e.remove([1, 3, 5, 8, 1, 5]);
  check('여러 개 제거: 중복 번호는 한 번만, 이미 제거한 것은 건너뛴다', same(r.removed, [1, 5, 8]) && same(r.alreadyRemoved, [3]) && e.state.removedCandidates.size === 4, JSON.stringify(r));
  const before = JSON.stringify(e.publicView());
  for (const bad of [[0], [17], [20], [-1], [3.5], [Number.NaN], [Infinity], [2, 99]]) {
    r = e.remove(bad);
    if (r.ok || r.code !== 'INVALID_NUMBER') check(`범위 밖(${JSON.stringify(bad)})은 거절한다`, false, JSON.stringify(r));
  }
  check('범위 밖·소수·NaN은 거절하고, 섞여 있으면 아무것도 지우지 않는다(원자적)', JSON.stringify(e.publicView()) === before);
  // 정답 후보도 제거할 수 있고, 그것이 정답이라는 단서가 되어서는 안 된다.
  const x = new GameEngine({ seed: 5 });
  const y = new GameEngine({ seed: 5 });
  const answerId = x.state.answer.id;
  const other = wrongId(y);
  const rx = x.remove([answerId]);
  const ry = y.remove([other]);
  check('정답 후보도 제거할 수 있다', rx.ok && x.state.candidates[answerId - 1].removed);
  check('정답을 지웠을 때와 아닌 후보를 지웠을 때 응답의 모양이 같다', same(Object.keys(rx).sort(), Object.keys(ry).sort()) && rx.code === ry.code && rx.remaining === ry.remaining);
  check('정답을 지워도 게임은 그대로 진행된다(상태·라운드 변화 없음)', x.status === STATUS.PLAYING && x.round === 1);
}

// ── 정답 제출: 기회는 한 번 ──
{
  const e = new GameEngine({ seed: 6 });
  e.remove([4]);
  const snap = JSON.stringify(e.publicView());
  let r = e.guess(4);
  check('제거한 후보를 제출하면 판정하지 않고 상태도 그대로다(게임이 끝나지 않는다)', !r.ok && r.code === 'GUESS_REMOVED' && e.status === STATUS.PLAYING && JSON.stringify(e.publicView()) === snap, JSON.stringify(r));
  for (const bad of [0, 17, 3.5, Number.NaN, -2]) {
    r = e.guess(bad);
    if (r.ok || r.code !== 'INVALID_NUMBER') check(`범위 밖 제출(${bad})은 거절한다`, false, JSON.stringify(r));
  }
  check('범위 밖·소수·NaN 제출은 거절하고 게임은 그대로다', e.status === STATUS.PLAYING && JSON.stringify(e.publicView()) === snap);

  e.next(); e.next();
  const wrong = wrongId(e);
  r = e.guess(wrong);
  check('오답: 그 자리에서 LOST로 끝난다(라운드는 그대로, 이유는 WRONG_GUESS)', r.ok && r.code === 'LOST' && r.reason === 'WRONG_GUESS' && r.id === wrong && r.round === 3
    && e.status === STATUS.LOST && e.round === 3 && same(e.state.wrongGuesses, [wrong]), JSON.stringify(r));
  check('오답 전이는 PLAYING → LOST다', e.transitions.slice(-1)[0] === 'PLAYING → LOST', e.transitions.join(', '));
  check('오답 응답 자체에는 정답이 없다(정답은 summary로만 나간다)', !('answer' in r) && !JSON.stringify(r).includes(answerOf(e).name));
  const summary = e.summary();
  check('오답으로 끝나면 summary에 정답·낸 답·지금까지 공개된 힌트(3개)의 해설이 있다', !!summary && !summary.won && summary.how === 'wrong'
    && summary.guessed.id === wrong && summary.guessed.name === e.state.candidates[wrong - 1].name
    && summary.answer.name === answerOf(e).name && summary.explanations.length === 3, JSON.stringify(summary && { how: summary.how, guessed: summary.guessed, n: summary.explanations.length }));
  check('오답으로 끝난 뒤에는 어떤 게임 명령도 받지 않는다(같은 답을 다시 낼 수도, 이어서 다음 라운드로 갈 수도 없다)', ['remove', 'guess', 'next', 'quit'].every((name) => {
    const res = name === 'remove' ? e.remove([1]) : name === 'guess' ? e.guess(wrong) : e[name]();
    return !res.ok && res.code === 'NOT_PLAYING';
  }) && e.round === 3 && e.status === STATUS.LOST);
  check('오답 기록은 한 번이고 후보 표시(wrong)도 그 후보 하나뿐이다', e.state.wrongGuesses.length === 1 && same(e.publicView().candidates.filter((c) => c.wrong).map((c) => c.id), [wrong]));
  check('오답으로 끝난 게임도 불변 조건이 지켜진다', e.invariants().length === 0, e.invariants().join(','));

  // 첫 라운드에서도 마찬가지다: 한 번 틀리면 끝이라 16개를 차례로 찍어 정답을 찾을 수 없다.
  const first = new GameEngine({ seed: 6 });
  const firstWrong = wrongId(first);
  first.guess(firstWrong);
  check('1라운드에서 틀려도 바로 끝난다(해설은 힌트 1개)', first.status === STATUS.LOST && first.round === 1 && first.summary().explanations.length === 1 && first.summary().how === 'wrong');
  let wins = 0;
  for (let id = 1; id <= 16; id += 1) { const t = new GameEngine({ seed: 6 }); if (t.guess(id).code === 'WON') wins += 1; }
  check('같은 판에서 16개 후보를 각각 한 번씩만 낼 수 있어서 정답은 정확히 하나만 이긴다', wins === 1, String(wins));

  // 정답
  const win = new GameEngine({ seed: 6 });
  win.next(); win.next();
  r = win.guess(answerOf(win).id);
  check('정답: WON으로 끝나고 몇 라운드였는지 안다', r.ok && r.code === 'WON' && r.round === 3 && win.status === STATUS.WON, JSON.stringify(r));
  check('이기면 summary는 how = won이고 낸 오답은 없다', win.summary().how === 'won' && win.summary().guessed === null && win.state.wrongGuesses.length === 0);
  check('이긴 뒤에는 어떤 게임 명령도 받지 않는다', ['remove', 'guess', 'next', 'quit'].every((name) => {
    const res = name === 'remove' ? win.remove([1]) : name === 'guess' ? win.guess(1) : win[name]();
    return !res.ok && res.code === 'NOT_PLAYING';
  }));
  check('이긴 상태는 그대로 유지된다', win.status === STATUS.WON && win.round === 3);

  // 정답 후보를 지우면 더는 낼 수 없다(막지는 않는다). 5라운드가 지나가면 진다.
  const gone = new GameEngine({ seed: 6 });
  gone.remove([answerOf(gone).id]);
  check('정답 후보를 지워도 게임은 계속된다(지웠다고 끝나지도, 알려 주지도 않는다)', gone.status === STATUS.PLAYING && gone.round === 1);
  check('지운 정답은 낼 수 없다(GUESS_REMOVED) - 이 판은 5라운드까지 가서 진다', gone.guess(answerOf(gone).id).code === 'GUESS_REMOVED' && (() => {
    for (let i = 0; i < MAX_ROUND; i += 1) gone.next();
    return gone.status === STATUS.LOST && gone.summary().how === 'rounds' && gone.summary().guessed === null;
  })());
}

// ── 라운드 ──
{
  const e = new GameEngine({ seed: 7 });
  e.remove([1, 2, 3]);
  const seen = [e.history()[0].round];
  for (let expected = 2; expected <= MAX_ROUND; expected += 1) {
    const r = e.next();
    seen.push(r.round);
    if (!r.ok || r.code !== 'NEXT' || r.round !== expected || e.round !== expected || e.history().length !== expected) check(`next → ROUND ${expected}`, false, JSON.stringify(r));
    if (!same([1, 2, 3], [...e.state.removedCandidates].sort((a, b) => a - b))) check('라운드가 바뀌어도 제거 상태가 유지된다', false);
  }
  check('next를 누를 때마다 라운드가 1씩 올라 5까지 간다', same(seen, [1, 2, 3, 4, 5]));
  check('라운드가 바뀌어도 제거한 후보(1,2,3)는 그대로 제거 상태다', same([1, 2, 3], [...e.state.removedCandidates].sort((a, b) => a - b)));
  check('힌트는 라운드마다 하나씩 쌓이고 지워지지 않는다(1~5라운드 각 1개)', same(e.history().map((h) => h.round), [1, 2, 3, 4, 5]));
  const r = e.next();
  check('ROUND 5에서 next → LOST(이유는 ROUNDS)', r.ok && r.code === 'LOST' && r.reason === 'ROUNDS' && e.status === STATUS.LOST && e.round === 5, JSON.stringify(r));
  check('라운드는 5를 넘지 않는다', e.round === 5 && e.next().code === 'NOT_PLAYING' && e.round === 5);
  const hintCount = e.history().length;
  check('진 뒤에도 힌트 기록은 그대로다', hintCount === 5);

  // 라운드를 올리지 않는 행동
  const f = new GameEngine({ seed: 8 });
  f.remove([1]); f.guess(1); f.publicView(); f.history(); f.remainingIds(); f.summary();
  check('remove·제거한 후보 제출·조회는 라운드를 올리지 않는다', f.round === 1 && f.history().length === 1 && f.status === STATUS.PLAYING);
}

// ── 상태 머신 ──
{
  const quit = new GameEngine({ seed: 10 });
  const r = quit.quit();
  check('PLAYING → QUIT', r.ok && quit.status === STATUS.QUIT && same(quit.transitions, ['→ INIT', 'INIT → PLAYING', 'PLAYING → QUIT']), quit.transitions.join(', '));
  check('포기한 게임에서는 게임 명령을 받지 않고, 정답도 공개하지 않는다', quit.remove([1]).code === 'NOT_PLAYING' && quit.guess(1).code === 'NOT_PLAYING' && quit.next().code === 'NOT_PLAYING' && quit.quit().code === 'NOT_PLAYING' && quit.summary() === null);
  const lost = new GameEngine({ seed: 10 });
  for (let i = 0; i < MAX_ROUND; i += 1) lost.next();
  check('PLAYING → LOST', lost.status === STATUS.LOST && lost.transitions.slice(-1)[0] === 'PLAYING → LOST');

  const e = new GameEngine({ seed: 11 });
  check('진행 중에는 restart를 받지 않는다', e.restart().code === 'IN_PROGRESS' && e.status === STATUS.PLAYING);
  let threw = false;
  try { e._enter(STATUS.WON); e._enter(STATUS.PLAYING); } catch { threw = true; }
  check('허용되지 않는 상태 전이(WON → PLAYING)는 예외로 막는다', threw);
}

// ── restart ──
{
  const e = new GameEngine({ seed: 12, debug: true });
  e.remove([1, 2]); e.next();
  e.guess(answerOf(e).id);
  const firstSeed = e.seed;
  const r = e.restart(13);
  check('끝난 게임은 restart로 새 게임이 된다', r.ok && e.status === STATUS.PLAYING && e.seed === 13 && e.seed !== firstSeed);
  check('restart: 라운드·제거·오답·힌트 기록이 모두 초기화된다', e.round === 1 && e.state.removedCandidates.size === 0 && e.state.wrongGuesses.length === 0 && e.state.hintHistory.length === 1
    && e.state.candidates.every((c) => !c.removed));
  check('restart한 게임도 같은 seed면 같은 게임이다', same(namesOf(e), namesOf(new GameEngine({ seed: 13 }))) && e.state.answer.name === new GameEngine({ seed: 13 }).state.answer.name);
  check('restart 전이가 기록된다(WON → INIT → PLAYING)', e.transitions.slice(-3).join(' | ') === 'PLAYING → WON | WON → INIT | INIT → PLAYING', e.transitions.join(', '));
  check('restart 뒤에도 불변 조건이 지켜진다(정답 번호가 새 게임 기준)', e.invariants().length === 0, e.invariants().join(','));
  e.quit();
  check('포기한 게임도 restart할 수 있다', e.restart().ok && e.status === STATUS.PLAYING);
  const lostByGuess = new GameEngine({ seed: 15 });
  lostByGuess.guess(wrongId(lostByGuess));
  check('오답으로 끝난 게임도 restart할 수 있고 오답 기록·후보 표시가 지워진다', lostByGuess.status === STATUS.LOST && lostByGuess.restart(16).ok && lostByGuess.status === STATUS.PLAYING
    && lostByGuess.state.wrongGuesses.length === 0 && lostByGuess.publicView().candidates.every((c) => !c.wrong) && lostByGuess.summary() === null && lostByGuess.invariants().length === 0);
}

// ── 비공개 ──
{
  const e = new GameEngine({ seed: 14 });
  const asText = () => JSON.stringify([e.publicView(), e.history(), e.remainingIds()]);
  const leaks = (text) => ['answer', 'reason', 'plan', 'tags', 'category', 'parents', 'seed', 'side', 'axis'].filter((key) => text.includes(`"${key}"`));
  check('게임 중 조회 결과에는 정답·해설·힌트 계획·특징·seed가 없다', leaks(asText()).length === 0, leaks(asText()).join(','));
  check('게임 중에는 summary가 없다', e.summary() === null && e.publicView().summary === null);
  check('후보의 공개 모양은 번호·이름·제거·오답뿐이다', e.publicView().candidates.every((c) => same(Object.keys(c).sort(), ['id', 'name', 'removed', 'wrong'])));
  check('공개 힌트의 모양은 라운드·A·B·선택뿐이다(해설 없음)', e.history().every((h) => same(Object.keys(h).sort(), ['optionA', 'optionB', 'round', 'selected'])));
  e.next(); e.next();
  check('라운드가 올라도 비공개는 유지된다', leaks(asText()).length === 0);
  check('debug가 아니면 debugInfo가 없다', e.debugInfo() === null);
  const g = new GameEngine({ seed: 14, debug: true });
  const info = g.debugInfo();
  check('debug 모드에서만 seed·정답·힌트 계획·상태 전이를 볼 수 있다', info && info.seed === 14 && info.answer.name === g.state.answer.name && info.plan.length === MAX_ROUND && info.transitions.length === 2);
  e.guess(answerOf(e).id);
  const summary = e.summary();
  check('이기면 정답과 힌트 해설이 공개된다', summary && summary.won && summary.answer.name === answerOf(e).name && summary.explanations.length === 3 && summary.explanations.every((h) => h.reason.includes(answerOf(e).name)));
  const lost = new GameEngine({ seed: 14 });
  for (let i = 0; i < MAX_ROUND; i += 1) lost.next();
  check('지면 정답과 5개 힌트 해설이 공개된다', lost.summary() && !lost.summary().won && lost.summary().explanations.length === MAX_ROUND && lost.summary().answer.name === lost.state.answer.name);
  const view = lost.publicView();
  check('끝난 뒤 공개 상태에도 후보의 특징·카테고리는 없다', leaks(JSON.stringify(view)).filter((k) => k !== 'answer' && k !== 'reason').length === 0);
  const byGuess = new GameEngine({ seed: 14 });
  byGuess.guess(wrongId(byGuess));
  check('오답으로 끝난 뒤에도 정답·해설 말고는 새지 않는다(후보의 특징·카테고리·seed·힌트 계획 없음)', leaks(JSON.stringify(byGuess.publicView())).filter((k) => k !== 'answer' && k !== 'reason').length === 0
    && byGuess.publicView().summary.answer.name === byGuess.state.answer.name);
}

// ── 불변 조건: 무작위로 마구 눌러도 ──
{
  let problems = 0; let detail = ''; let steps = 0; let finished = 0; let wrongEnds = 0; let roundEnds = 0; let wins = 0;
  for (let seed = 1; seed <= 400 && problems === 0; seed += 1) {
    const e = new GameEngine({ seed });
    const rng = createRng(seed, 'fuzz');
    const answerId = e.state.answer.id;
    const history = [];
    let seen = e.transitions.length;
    for (let i = 0; i < 40; i += 1) {
      const roll = rng.int(10);
      const id = rng.int(20); // 17~19는 범위 밖
      if (roll < 3) e.remove(rng.chance(0.5) ? [id] : [id, rng.int(18), rng.int(18)]);
      else if (roll === 3 && rng.chance(0.4)) e.guess(id); // 오답이면 바로 끝나므로 자주 내면 판이 너무 일찍 끝난다
      else if (roll < 8) e.next();
      else if (roll === 8) e.remove([1.5, rng.int(5)]);
      else if (e.status !== STATUS.PLAYING) e.restart(seed * 7 + i); // 끝난 게임은 다시 시작
      else if (rng.chance(0.05)) e.quit();
      steps += 1;
      if (e.transitions.length !== seen) {
        seen = e.transitions.length;
        const last = e.transitions[seen - 1];
        if (last === 'PLAYING → LOST') { if (e.state.wrongGuesses.length) wrongEnds += 1; else roundEnds += 1; }
        if (last === 'PLAYING → WON') wins += 1;
      }
      const found = e.invariants();
      const before = history.length;
      history.push(e.history().length);
      const monotone = e.state.currentRound >= 1 && e.state.currentRound <= MAX_ROUND && (before === 0 || history[before] >= history[before - 1] || e.transitions.slice(-1)[0] === 'INIT → PLAYING');
      if (found.length || !monotone || (e.seed === seed && e.state.answer.id !== answerId)) { problems += 1; detail = `seed ${seed} 단계 ${i}: ${found.join(', ') || '힌트 기록이 줄거나 정답이 바뀜'}`; break; }
    }
    if (e.status !== STATUS.PLAYING) finished += 1;
  }
  check(`무작위 명령 ${steps}번: 불변 조건이 한 번도 깨지지 않는다(정답 불변·후보 16개·라운드 1~5·힌트 기록 유지)`, problems === 0, detail);
  check('무작위 진행에서 끝난 판도 충분히 나온다(상태 전이를 두루 거쳤다)', finished > 100, `${finished}`);
  check('무작위 진행이 오답으로 끝난 판·5라운드가 지나 끝난 판·이긴 판을 모두 충분히 거친다', wrongEnds > 40 && roundEnds > 40 && wins > 5, `오답 ${wrongEnds}, 라운드 ${roundEnds}, 승리 ${wins}`);
}

console.log(`\n갈팡질팡 엔진: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
