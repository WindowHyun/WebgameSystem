'use strict';

/**
 * 한 사람의 게임 진행. 입력 한 줄을 받아 엔진을 부르고 렌더러가 만든 줄들을 돌려준다(터미널 cli.js와
 * 사이트 web/galpang-room.js가 같이 쓴다). 게임 규칙은 여기 없다 - 규칙은 엔진, 글은 렌더러, 입력 읽기는 해석기.
 * 여기에 있는 것은 "지금 상태에서 이 명령을 받아 줄 것인가"와 포기(quit) 확인 같은 대화 흐름뿐이다.
 */

const { GameEngine, STATUS } = require('./engine');
const { parse } = require('./parser');
const render = require('./renderer');

const YES = new Set(['y', 'yes', '예', '네', 'ㅇ']);
const NO = new Set(['n', 'no', '아니오', '아니', 'ㄴ']);
// 끝난 게임에서 받아 주는 명령(그 밖의 입력은 "끝났다"고 알려 준다).
const AFTER_END = new Set(['restart', 'history', 'quit', 'empty']);

/**
 * options: { seed, debug }
 *   seed   처음 게임의 seed. restart마다 `${seed}#1`, `${seed}#2`…로 이어 가서, 같은 seed로 시작한 대화는
 *          통째로 재현된다. 없으면 매 게임 무작위.
 */
function createSession(options) {
  const opts = options || {};
  let games = 0;
  const seedFor = (index) => (opts.seed === undefined ? undefined : (index === 0 ? opts.seed : `${opts.seed}#${index}`));
  const engine = new GameEngine({ seed: seedFor(0), debug: opts.debug });
  let pendingQuit = false;
  let shownTransitions = 0;

  function debugLines() {
    const info = engine.debugInfo();
    if (!info) return [];
    const lines = info.transitions.length > shownTransitions && shownTransitions > 0
      ? [`[DEBUG] state: ${info.transitions.slice(shownTransitions).join(', ')}`]
      : [];
    shownTransitions = info.transitions.length;
    return lines;
  }

  /** 게임 시작 화면(+ 디버그 모드면 정답과 힌트 계획). */
  function intro() {
    const lines = render.intro(engine.publicView());
    const info = engine.debugInfo();
    if (info) { shownTransitions = info.transitions.length; lines.push('', ...render.debug(info)); }
    return lines;
  }

  function finish(lines) {
    return { lines: [...lines, ...debugLines()], exit: false };
  }

  function answerQuit(line) {
    const word = String(line == null ? '' : line).normalize('NFKC').trim().toLowerCase();
    if (YES.has(word)) {
      pendingQuit = false;
      engine.quit();
      return { lines: ['게임을 종료합니다.', ...debugLines()], exit: true };
    }
    if (NO.has(word)) {
      pendingQuit = false;
      return { lines: ['게임을 계속합니다.'], exit: false };
    }
    return { lines: ['y 또는 n 으로 답해주세요. (y/n)'], exit: false };
  }

  /** 한 줄을 처리한다. 항상 { lines, exit }를 돌려주고 예외를 던지지 않는다. */
  function handleLine(line) {
    if (pendingQuit) return answerQuit(line);
    const command = parse(line);
    if (command.type === 'empty') return { lines: [], exit: false };
    const finished = engine.status !== STATUS.PLAYING;
    if (finished && !AFTER_END.has(command.type)) return finish(render.GAME_OVER);
    if (command.type === 'error') return finish(render.parseError(command));

    switch (command.type) {
      case 'help': return finish(render.help());
      case 'list': return finish(render.list(engine.publicView(), command.all));
      case 'history': return finish(render.history(engine.publicView()));
      case 'remove': {
        const result = engine.remove(command.numbers);
        if (result.code === 'INVALID_NUMBER') return finish(render.outOfRange(engine.state.candidates.length));
        return finish(render.removed(result));
      }
      case 'guess': {
        const result = engine.guess(command.number);
        if (result.code === 'INVALID_NUMBER') return finish(render.outOfRange(engine.state.candidates.length));
        if (result.code === 'GUESS_REMOVED') return finish([`${result.id}번 후보는 이미 제거한 후보입니다.`]);
        if (result.code === 'WRONG') return finish(['오답입니다.']);
        return finish(render.won(engine.summary()));
      }
      case 'next': {
        const result = engine.next();
        if (result.code === 'LOST') return finish(render.lost(engine.summary()));
        return finish([render.DASH, '', ...render.roundBlock(result.hint)]);
      }
      case 'quit':
        if (finished) return { lines: ['게임을 종료합니다.'], exit: true };
        pendingQuit = true;
        return { lines: ['게임을 종료하시겠습니까? (y/n)'], exit: false };
      case 'restart': {
        if (!finished) return finish(render.STILL_PLAYING);
        games += 1;
        engine.restart(seedFor(games));
        return { lines: intro(), exit: false };
      }
      default: return finish(render.parseError({ code: 'UNKNOWN_COMMAND' }));
    }
  }

  return {
    engine,
    intro,
    handleLine,
    view: () => ({ ...engine.publicView(), pendingQuit }),
    get pendingQuit() { return pendingQuit; },
  };
}

module.exports = { createSession };
