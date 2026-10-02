'use strict';

/**
 * 갈팡질팡 게임 엔진. 규칙·상태 변경은 모두 여기서 한다. 입력을 읽는 일(parser.js)과 글자로 보여 주는 일
 * (renderer.js)은 하지 않는다 - 엔진은 결과 코드와 값만 돌려준다.
 *
 * 사용자 입력이 잘못돼도 예외를 던지지 않는다(결과 코드로 알린다). 예외는 엔진 내부 버그일 때만 난다.
 *
 * 정답 제출은 한 번뿐이다: 맞히면 WON, 틀리면 그 자리에서 LOST(정답·힌트 해설 공개)로 끝난다. 정답 후보를 지워도
 * 그 자리에서 LOST다(정답이 후보에서 없어졌으니 더는 맞힐 수 없다). 5라운드가 다 지나도 LOST다. 제거한 후보나 범위
 * 밖 번호를 제출하는 것은 제출로 치지 않고 아무것도 바꾸지 않는다(잘못 눌러 게임이 끝나지 않게).
 *
 * 그래서 후보를 지우는 것은 "이 후보는 정답이 아니다"라는 내기다 - 지웠는데 게임이 이어지면 그 후보는 정답이 아니었다.
 *
 * 숨겨진 정답은 게임이 끝나기 전에는 어떤 메서드로도 나가지 않는다(publicView·summary 참고).
 */

const crypto = require('crypto');
const { createRng } = require('./rng');
const { STATUS, GameState, CANDIDATE_COUNT, MAX_ROUND, ALLOWED, isFinished } = require('./state');
const { pickCandidates, chooseAnswer } = require('./generator');
const { buildPlan, publicHint } = require('./hint');
const WORDS = require('./data/words.json');
const AXES = require('./data/hints.json');

const randomSeed = () => crypto.randomInt(0, 2 ** 32);

class GameEngine {
  /**
   * options: { seed, debug, words, axes }
   *   seed   같은 값이면 후보·정답·힌트가 같다. 없으면 무작위.
   *   debug  true면 debugInfo()로 정답·힌트 계획·상태 전이를 볼 수 있다(일반 게임에서는 쓰지 않는다).
   */
  constructor(options) {
    const opts = options || {};
    this.words = opts.words || WORDS;
    this.axes = opts.axes || AXES;
    this.debug = !!opts.debug;
    this.transitions = [];
    this._create(opts.seed === undefined ? randomSeed() : opts.seed);
  }

  // ───────────────────────────── 생성 ─────────────────────────────

  /** INIT: 후보와 정답과 힌트를 만들고 PLAYING으로 넘어간다. 끝난 게임이었다면 그 상태에서 INIT으로 간다. */
  _create(seed) {
    this.state = new GameState(seed);
    this._enter(STATUS.INIT);
    const state = this.state;
    state.candidates = pickCandidates(this.words, createRng(seed, 'candidates'), CANDIDATE_COUNT);
    state.answer = chooseAnswer(state.candidates, createRng(seed, 'answer'));
    state.plan = buildPlan({
      answer: state.answer, candidates: state.candidates, axes: this.axes, rng: createRng(seed, 'hints'), rounds: MAX_ROUND,
    });
    state.hintHistory = [publicHint(state.plan[0])];
    this._answerId = state.answer.id;
    this._enter(STATUS.PLAYING);
  }

  /** 허용된 상태 전이만 한다. 어긋나면 엔진 버그이므로 예외를 던진다. 전이는 디버그 로그에 남는다. */
  _enter(next) {
    const from = this._current || null;
    if (from !== null && !ALLOWED[from].includes(next)) throw new Error(`허용되지 않는 상태 전이: ${from} → ${next}`);
    if (from === null && next !== STATUS.INIT) throw new Error(`처음에는 INIT이어야 합니다: ${next}`);
    this._current = next;
    this.state.status = next;
    this.transitions.push(from === null ? `→ ${next}` : `${from} → ${next}`);
  }

  get status() { return this.state.status; }
  get round() { return this.state.currentRound; }
  get seed() { return this.state.seed; }

  // ───────────────────────────── 조작 ─────────────────────────────

  _inRange(id) {
    return Number.isInteger(id) && id >= 1 && id <= this.state.candidates.length;
  }

  /**
   * 후보 제거. 번호가 하나라도 범위 밖이면 아무것도 바꾸지 않고 거절한다(오타로 일부만 지워지지 않게).
   * 이미 제거한 번호는 건너뛴다. 정답 후보를 지우면(한꺼번에 여러 개를 지우다 섞여 있어도) 그 자리에서 LOST로
   * 끝난다(code LOST, reason ANSWER_REMOVED). 이때도 같이 지운 후보는 지워진 것으로 표시된다.
   */
  remove(ids) {
    if (this.state.status !== STATUS.PLAYING) return { ok: false, code: 'NOT_PLAYING' };
    const unique = [...new Set(ids)];
    const invalid = unique.filter((id) => !this._inRange(id));
    if (invalid.length) return { ok: false, code: 'INVALID_NUMBER', invalid };
    const removed = [];
    const alreadyRemoved = [];
    for (const id of unique) {
      if (this.state.removedCandidates.has(id)) { alreadyRemoved.push(id); continue; }
      this.state.removedCandidates.add(id);
      this.state.candidates[id - 1].removed = true;
      removed.push(id);
    }
    const base = { ok: true, removed, alreadyRemoved, remaining: this.remainingIds().length };
    if (removed.includes(this.state.answer.id)) {
      this._enter(STATUS.LOST);
      return { ...base, code: 'LOST', reason: 'ANSWER_REMOVED', round: this.state.currentRound };
    }
    return { ...base, code: 'REMOVED' };
  }

  /**
   * 정답 제출. 기회는 한 번이다 - 맞히면 WON, 틀리면 바로 LOST로 끝난다(라운드는 그대로, 정답은 summary()로 공개).
   * 제거한 후보나 범위 밖 번호는 제출로 치지 않는다.
   */
  guess(id) {
    if (this.state.status !== STATUS.PLAYING) return { ok: false, code: 'NOT_PLAYING' };
    if (!this._inRange(id)) return { ok: false, code: 'INVALID_NUMBER', invalid: [id] };
    if (this.state.removedCandidates.has(id)) return { ok: false, code: 'GUESS_REMOVED', id };
    if (id === this.state.answer.id) {
      this._enter(STATUS.WON);
      return { ok: true, code: 'WON', round: this.state.currentRound };
    }
    this.state.wrongGuesses.push(id);
    this._enter(STATUS.LOST);
    return { ok: true, code: 'LOST', reason: 'WRONG_GUESS', id, round: this.state.currentRound };
  }

  /** 다음 라운드. 마지막 라운드에서 부르면 정답을 못 맞힌 것으로 끝난다. */
  next() {
    const state = this.state;
    if (state.status !== STATUS.PLAYING) return { ok: false, code: 'NOT_PLAYING' };
    if (state.currentRound >= state.maxRound) {
      this._enter(STATUS.LOST);
      return { ok: true, code: 'LOST', reason: 'ROUNDS', round: state.currentRound };
    }
    state.currentRound += 1;
    const hint = publicHint(state.plan[state.currentRound - 1]);
    state.hintHistory.push(hint);
    return { ok: true, code: 'NEXT', round: state.currentRound, hint: { ...hint } };
  }

  quit() {
    if (this.state.status !== STATUS.PLAYING) return { ok: false, code: 'NOT_PLAYING' };
    this._enter(STATUS.QUIT);
    return { ok: true, code: 'QUIT' };
  }

  /** 끝난 게임에서만 새 게임을 만든다. seed를 주지 않으면 무작위. */
  restart(seed) {
    if (!isFinished(this.state.status)) return { ok: false, code: 'IN_PROGRESS' };
    this._create(seed === undefined ? randomSeed() : seed);
    return { ok: true, code: 'RESTARTED' };
  }

  // ───────────────────────────── 조회 ─────────────────────────────

  remainingIds() {
    return this.state.candidates.filter((candidate) => !candidate.removed).map((candidate) => candidate.id);
  }

  history() {
    return this.state.hintHistory.map((hint) => ({ ...hint }));
  }

  /**
   * 화면·출력에 내보내도 되는 상태. 정답, 정답 번호, 힌트 계획, 힌트의 속마음(reason), 후보의 카테고리·특징은
   * 들어 있지 않다. 정답은 끝난 뒤 summary()로만 나간다.
   */
  publicView() {
    const state = this.state;
    return {
      status: state.status,
      round: state.currentRound,
      maxRound: state.maxRound,
      candidates: state.candidates.map((candidate) => ({
        id: candidate.id, name: candidate.name, removed: candidate.removed, wrong: state.wrongGuesses.includes(candidate.id),
      })),
      remaining: this.remainingIds().length,
      hints: this.history(),
      summary: this.summary(),
    };
  }

  /**
   * 게임이 이겨서나 져서 끝난 뒤의 결과(정답 공개 + 힌트 해설). 그 전에는 null. 포기(QUIT)는 공개하지 않는다.
   * how: 'won'(맞힘) | 'wrong'(틀린 답을 제출해 끝남, guessed에 낸 후보) | 'removed'(정답 후보를 지워서 끝남)
   *      | 'rounds'(5라운드가 다 지남)
   */
  summary() {
    const state = this.state;
    if (state.status !== STATUS.WON && state.status !== STATUS.LOST) return null;
    const won = state.status === STATUS.WON;
    const guessed = state.wrongGuesses.length ? state.candidates[state.wrongGuesses[0] - 1] : null;
    return {
      won,
      how: won ? 'won' : guessed ? 'wrong' : state.removedCandidates.has(state.answer.id) ? 'removed' : 'rounds',
      round: state.currentRound,
      maxRound: state.maxRound,
      answer: { id: state.answer.id, name: state.answer.name },
      guessed: guessed ? { id: guessed.id, name: guessed.name } : null,
      explanations: state.hintHistory.map((hint) => ({ ...hint, reason: state.plan[hint.round - 1].reason })),
    };
  }

  /** 디버그 모드에서만. 정답·힌트 계획·상태 전이. */
  debugInfo() {
    if (!this.debug) return null;
    const state = this.state;
    return {
      seed: state.seed,
      answer: { id: state.answer.id, name: state.answer.name },
      plan: state.plan.map(({ round, axis, level, optionA, optionB, selected, reason }) => ({ round, axis, level, optionA, optionB, selected, reason })),
      transitions: this.transitions.slice(),
    };
  }

  /** 핵심 불변 조건을 검사해 어긋난 것을 글로 돌려준다(비어 있으면 정상). 테스트가 매 단계 부른다. */
  invariants() {
    const state = this.state;
    const problems = [];
    const ids = state.candidates.map((candidate) => candidate.id);
    if (state.candidates.length !== CANDIDATE_COUNT) problems.push(`후보 수 ${state.candidates.length}`);
    if (new Set(state.candidates.map((candidate) => candidate.name)).size !== state.candidates.length) problems.push('후보 이름 중복');
    if (!state.candidates.includes(state.answer)) problems.push('정답이 후보에 없음');
    if (state.answer.id !== this._answerId) problems.push('정답이 바뀜');
    if (state.currentRound < 1 || state.currentRound > state.maxRound) problems.push(`라운드 ${state.currentRound}`);
    for (const id of state.removedCandidates) if (!ids.includes(id)) problems.push(`없는 후보 ${id} 제거`);
    // 오답은 한 번뿐이고, 있으면 게임은 LOST로 끝나 있다. 정답과 제거한 후보는 오답이 될 수 없다.
    if (state.wrongGuesses.length > 1) problems.push(`오답이 ${state.wrongGuesses.length}번`);
    if (state.wrongGuesses.length && state.status !== STATUS.LOST) problems.push('오답을 냈는데 LOST가 아님');
    if (state.wrongGuesses.includes(state.answer.id)) problems.push('정답이 오답으로 기록됨');
    // 정답 후보를 지우면 게임이 끝나므로, 진행 중에는 정답이 지워져 있을 수 없다.
    if (state.status === STATUS.PLAYING && state.removedCandidates.has(state.answer.id)) problems.push('정답을 지웠는데 게임이 계속됨');
    const flagged = state.candidates.filter((candidate) => candidate.removed).map((candidate) => candidate.id).sort((a, b) => a - b);
    const set = [...state.removedCandidates].sort((a, b) => a - b);
    if (JSON.stringify(flagged) !== JSON.stringify(set)) problems.push('제거 표시가 어긋남');
    if (state.hintHistory.length !== state.currentRound) problems.push(`힌트 ${state.hintHistory.length}개, 라운드 ${state.currentRound}`);
    state.hintHistory.forEach((hint, index) => {
      const planned = state.plan[index];
      if (!planned || hint.round !== index + 1 || hint.optionA !== planned.optionA || hint.optionB !== planned.optionB || hint.selected !== planned.selected) {
        problems.push(`힌트 ${index + 1}이 계획과 다름`);
      }
    });
    return problems;
  }
}

module.exports = { GameEngine, STATUS, CANDIDATE_COUNT, MAX_ROUND };
