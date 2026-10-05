'use strict';

/**
 * 판을 바꾸는 명령(후보 제거·정답 제출·다음 라운드)을 엔진에 하고, 화면에 보일 줄들을 돌려준다.
 *
 * 혼자 하는 터미널 세션(session.js)과 여럿이 하는 사이트 방(web/galpang-room.js)이 같이 쓴다. 방은 이 명령을
 * 바로 하지 않고 접속자 과반수의 동의를 받은 뒤에 하므로, "해도 되는지 미리 보기"(problem)와 "하기"(perform)를
 * 따로 둔다. 규칙은 엔진에 있고 글은 렌더러에 있다 - 여기는 둘을 잇기만 한다.
 */

const { STATUS } = require('./state');
const render = require('./renderer');

/**
 * 제안을 올리기 전에 거절할 이유가 있으면 그 안내 줄들을, 없으면 null을 돌려준다. 엔진은 건드리지 않는다.
 * 정답이 무엇인지에 따라 달라지는 것은 보지 않는다 - 지우려는 후보가 정답인지는 제안 단계에서 새면 안 된다.
 */
function problem(engine, command) {
  const count = engine.state.candidates.length;
  const inRange = (id) => Number.isInteger(id) && id >= 1 && id <= count;
  const removed = (id) => engine.state.removedCandidates.has(id);
  if (command.type === 'remove') {
    if (!command.numbers.every(inRange)) return render.outOfRange(count);
    const unique = [...new Set(command.numbers)];
    // 전부 이미 지운 후보면 제안할 것이 없다. 안내는 터미널이 같은 입력에 보이는 글과 같다.
    if (unique.every(removed)) return render.removed({ removed: [], alreadyRemoved: unique });
  }
  if (command.type === 'guess') {
    if (!inRange(command.number)) return render.outOfRange(count);
    if (removed(command.number)) return [`${command.number}번 후보는 이미 제거한 후보입니다.`];
  }
  return null;
}

/**
 * 명령을 하고 { lines }를 돌려준다. 게임이 끝났는지는 engine.status로 본다.
 * command: { type: 'remove', numbers } | { type: 'guess', number } | { type: 'next' } | { type: 'quit' }
 * options.closing: 끝난 글의 마지막 줄(없으면 터미널의 "restart 를 입력하면…"). 사이트 방은 준비·시작 안내를 넘긴다.
 */
function perform(engine, command, options) {
  const closing = (options && options.closing) || undefined;
  switch (command.type) {
    case 'remove': {
      const result = engine.remove(command.numbers);
      if (result.code === 'INVALID_NUMBER') return { lines: render.outOfRange(engine.state.candidates.length) };
      // 정답 후보를 지웠으면 그 자리에서 끝난다: 지운 번호들 뒤에 결과를 이어 보인다.
      if (result.code === 'LOST') return { lines: [...render.removed(result), '', ...render.lost(engine.summary(), closing)] };
      return { lines: render.removed(result) };
    }
    case 'guess': {
      const result = engine.guess(command.number);
      if (result.code === 'INVALID_NUMBER') return { lines: render.outOfRange(engine.state.candidates.length) };
      if (result.code === 'GUESS_REMOVED') return { lines: [`${result.id}번 후보는 이미 제거한 후보입니다.`] };
      // 맞히면 WON, 틀리면 바로 LOST(정답 공개)다.
      return { lines: result.code === 'WON' ? render.won(engine.summary(), closing) : render.lost(engine.summary(), closing) };
    }
    case 'next': {
      const result = engine.next();
      if (result.code === 'LOST') return { lines: render.lost(engine.summary(), closing) };
      return { lines: [render.DASH, '', ...render.roundBlock(result.hint)] };
    }
    case 'quit':
      engine.quit();
      return { lines: ['게임을 종료합니다.'] };
    default:
      return { lines: render.parseError({ code: 'UNKNOWN_COMMAND' }) };
  }
}

const isLive = (engine) => engine.status === STATUS.PLAYING;

module.exports = { problem, perform, isLive };
