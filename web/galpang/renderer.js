'use strict';

/**
 * 글자 출력. 엔진이 돌려준 값(publicView·결과 코드)을 사람이 읽을 줄들로 바꾼다. 줄 목록을 돌려줄 뿐 직접
 * 출력하지 않는다 - 터미널(cli.js)도 사이트(web/galpang-room.js)도 같은 글을 쓴다. 규칙은 모른다.
 */

const LINE = '='.repeat(32);
const DASH = '-'.repeat(32);

// 끝난 글의 마지막 줄. 터미널은 restart·quit 명령을 안내한다. 여럿이 하는 사이트 방은 준비가 먼저라서 다른 글을 넘긴다.
const RESTART_HINT = 'restart 를 입력하면 새 게임을 시작하고, quit 을 입력하면 종료합니다.';

const COMMAND_SUMMARY = ['list', 'remove <번호>', 'guess <번호>', 'next', 'history', 'help', 'quit'];

function roundBlock(hint) {
  return [`[ROUND ${hint.round}]`, '', `A. ${hint.optionA}`, `B. ${hint.optionB}`, '', `힌트: ${hint.selected}`];
}

function candidateLines(view, all) {
  return view.candidates
    .filter((candidate) => all || !candidate.removed)
    .map((candidate) => `${candidate.id}. ${candidate.name}${all && candidate.removed ? ' [제거됨]' : ''}`);
}

/** 게임 시작 화면. */
function intro(view) {
  const latest = view.hints[view.hints.length - 1];
  return [
    LINE, '        갈팡질팡', LINE, '',
    `${view.candidates.length}개의 후보 중 숨겨진 정답을 찾아주세요.`, '',
    `최대 라운드: ${view.maxRound}`, '',
    '[후보]', '', ...candidateLines(view, true), '',
    DASH, '', ...roundBlock(latest), '',
    DASH, '', '명령어:', ...COMMAND_SUMMARY,
  ];
}

function list(view, all) {
  if (all) return ['[전체 후보]', '', ...candidateLines(view, true)];
  return ['[남은 후보]', '', ...candidateLines(view, false)];
}

function history(view) {
  const lines = ['[힌트 기록]'];
  for (const hint of view.hints) {
    lines.push('', `ROUND ${hint.round}`, `A. ${hint.optionA}`, `B. ${hint.optionB}`, `→ ${hint.selected}`);
  }
  return lines;
}

function help() {
  return [
    '사용 가능한 명령어', '',
    'list', '현재 남아 있는 후보 확인', '',
    'list all', '전체 후보 확인', '',
    'remove <번호>', '후보 제거', '',
    'guess <번호>', '정답 제출', '',
    'next', '다음 라운드 진행', '',
    'history', '현재까지 힌트 확인', '',
    'help', '명령어 도움말', '',
    'quit', '게임 종료',
  ];
}

/** 끝난 뒤의 힌트 해설. 해설(속마음)은 이긴 뒤나 진 뒤에만 나온다. */
function explanations(summary) {
  const lines = ['[힌트 해설]'];
  for (const hint of summary.explanations) {
    lines.push('', `ROUND ${hint.round}`, `A. ${hint.optionA}`, `B. ${hint.optionB}`, `선택: ${hint.selected}`, '', hint.reason);
  }
  return lines;
}

function won(summary, closing = RESTART_HINT) {
  return [
    LINE, '정답입니다!', LINE, '',
    `정답: ${summary.answer.name}`, '',
    `${summary.round}라운드 만에 성공했습니다.`, '',
    ...explanations(summary), '',
    closing,
  ];
}

/** 틀린 답을 내서 끝났을 때: 낸 답과 정답, 지금까지 공개된 힌트의 해설. */
function lostByGuess(summary, closing = RESTART_HINT) {
  return [
    LINE, '오답입니다.', LINE, '',
    '정답이 아닌 후보를 제출해서 게임이 끝났습니다.', '',
    `제출한 답: ${summary.guessed.id}번 ${summary.guessed.name}`,
    `정답: ${summary.answer.name}`, '',
    `${summary.round}라운드에서 끝났습니다.`, '',
    ...explanations(summary), '',
    closing,
  ];
}

/** 정답 후보를 지워서 끝났을 때: 지운 정답과 지금까지 공개된 힌트의 해설. */
function lostByRemoval(summary, closing = RESTART_HINT) {
  return [
    LINE, '정답 후보를 지웠습니다.', LINE, '',
    '정답이 후보에서 없어져서 게임이 끝났습니다.', '',
    `정답: ${summary.answer.id}번 ${summary.answer.name}`, '',
    `${summary.round}라운드에서 끝났습니다.`, '',
    ...explanations(summary), '',
    closing,
  ];
}

function lost(summary, closing = RESTART_HINT) {
  if (summary.how === 'wrong') return lostByGuess(summary, closing);
  if (summary.how === 'removed') return lostByRemoval(summary, closing);
  return [
    LINE, '게임 종료', LINE, '',
    `${summary.maxRound}라운드 안에 정답을 맞히지 못했습니다.`, '',
    `정답: ${summary.answer.name}`, '',
    ...explanations(summary), '',
    closing,
  ];
}

function removed(result) {
  const lines = result.removed.map((id) => `${id}번 제거`);
  for (const id of result.alreadyRemoved) lines.push(`${id}번 후보는 이미 제거되었습니다.`);
  return lines;
}

function outOfRange(count) {
  return ['잘못된 후보 번호입니다.', `1~${count} 사이의 번호를 입력해주세요.`];
}

function parseError(error) {
  switch (error.code) {
    case 'UNKNOWN_COMMAND': return ['알 수 없는 명령어입니다.', '', 'help 를 입력하면 명령어 목록을 확인할 수 있습니다.'];
    case 'NOT_A_NUMBER': return ['후보 번호는 숫자로 입력해주세요.'];
    case 'MISSING_ARGUMENT':
      return error.command === 'remove'
        ? ['제거할 후보 번호를 입력해주세요.', '예: remove 3 5']
        : ['정답으로 제출할 후보 번호를 입력해주세요.', '예: guess 5'];
    case 'TOO_MANY_ARGUMENTS': return ['정답은 번호 하나만 제출할 수 있습니다.', '예: guess 5'];
    case 'UNEXPECTED_ARGUMENT':
      return error.command === 'list' ? ['list 뒤에는 all 만 붙일 수 있습니다.'] : ['이 명령어에는 번호를 붙일 수 없습니다.'];
    default: return ['알 수 없는 명령어입니다.'];
  }
}

const GAME_OVER = gameOver('restart 를 입력하면 새 게임을 시작할 수 있습니다.');
/** 끝난 게임에 보낸 명령에 대한 안내. closing은 마지막 줄(터미널은 restart 안내, 방은 준비·시작 안내). */
function gameOver(closing) { return ['게임이 종료되었습니다.', '', closing]; }
const STILL_PLAYING = ['진행 중인 게임이 있습니다.', '', '포기하려면 quit 을 입력하세요.'];

/** 개발용(--debug) 출력. 일반 게임에서는 쓰지 않는다. */
function debug(info) {
  return [
    `[DEBUG] seed = ${info.seed}`,
    `[DEBUG] answer = ${info.answer.id}. ${info.answer.name}`,
    ...info.plan.map((hint) => `[DEBUG] ROUND ${hint.round} ${hint.axis}(L${hint.level}) ${hint.optionA} / ${hint.optionB} → ${hint.selected}`),
    `[DEBUG] transitions = ${info.transitions.join(', ')}`,
  ];
}

module.exports = {
  LINE, DASH, intro, roundBlock, list, history, help, explanations, won, lost, removed, outOfRange, parseError, debug, GAME_OVER, gameOver, STILL_PLAYING,
};
