'use strict';

/**
 * 명령어 해석기. 글자 한 줄을 명령 객체로 바꾼다. 게임 상태는 보지 않는다(번호가 범위 안인지, 지금 그 명령을
 * 쓸 수 있는지는 엔진·세션이 정한다). 어떤 입력에도 예외를 던지지 않는다.
 *
 * 입력 정규화: 앞뒤 공백 제거 → 전각 문자(숫자·쉼표·공백)를 반각으로 → 소문자 → 쉼표를 공백으로 →
 * 연속 공백 하나로. 그래서 `REMOVE   3`, `remove 1,3,5`, `remove 1, 3` 모두 같게 읽는다.
 *
 * 결과:
 *   { type: 'empty' }                                   빈 입력
 *   { type: 'help' | 'next' | 'history' | 'quit' | 'restart' }
 *   { type: 'list', all: boolean }
 *   { type: 'remove', numbers: number[] }
 *   { type: 'guess', number: number }
 *   { type: 'error', code }   UNKNOWN_COMMAND | NOT_A_NUMBER | MISSING_ARGUMENT | TOO_MANY_ARGUMENTS | UNEXPECTED_ARGUMENT
 */

const COMMANDS = {
  remove: ['remove', '제거'],
  list: ['list', '후보'],
  guess: ['guess', '정답'],
  next: ['next', '다음'],
  history: ['history', '기록'],
  help: ['help', '도움말'],
  quit: ['quit', '종료'],
  restart: ['restart', '재시작'],
};
const BY_WORD = new Map();
for (const [type, words] of Object.entries(COMMANDS)) for (const word of words) BY_WORD.set(word, type);

const NUMBER = /^[+-]?\d+(\.\d+)?$/;
const ALL_WORDS = new Set(['all', '전체']);

function normalize(line) {
  return String(line == null ? '' : line)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parse(line) {
  const text = normalize(line);
  if (!text) return { type: 'empty' };
  const [word, ...args] = text.split(' ');
  const type = BY_WORD.get(word);
  if (!type) return { type: 'error', code: 'UNKNOWN_COMMAND' };

  if (type === 'remove') {
    if (!args.length) return { type: 'error', code: 'MISSING_ARGUMENT', command: type };
    if (!args.every((arg) => NUMBER.test(arg))) return { type: 'error', code: 'NOT_A_NUMBER', command: type };
    return { type: 'remove', numbers: args.map(Number) };
  }
  if (type === 'guess') {
    if (!args.length) return { type: 'error', code: 'MISSING_ARGUMENT', command: type };
    if (args.length > 1) return { type: 'error', code: 'TOO_MANY_ARGUMENTS', command: type };
    if (!NUMBER.test(args[0])) return { type: 'error', code: 'NOT_A_NUMBER', command: type };
    return { type: 'guess', number: Number(args[0]) };
  }
  if (type === 'list') {
    if (!args.length) return { type: 'list', all: false };
    if (args.length === 1 && ALL_WORDS.has(args[0])) return { type: 'list', all: true };
    return { type: 'error', code: 'UNEXPECTED_ARGUMENT', command: type };
  }
  if (args.length) return { type: 'error', code: 'UNEXPECTED_ARGUMENT', command: type };
  return { type };
}

module.exports = { parse, normalize, COMMANDS };
