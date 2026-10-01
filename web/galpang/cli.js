#!/usr/bin/env node
'use strict';

/**
 * 갈팡질팡 터미널 실행기.
 *
 *   node web/galpang/cli.js                  새 게임
 *   node web/galpang/cli.js --seed 100       같은 seed면 후보·정답·힌트가 같다(재현용)
 *   node web/galpang/cli.js --debug          정답·힌트 계획·상태 전이를 보여 준다(개발용)
 *   npm run galpang -- --seed 100
 *
 * 입력을 읽고 세션(session.js)에 넘기고 줄들을 출력하는 일만 한다. 규칙은 엔진에 있다.
 */

const readline = require('readline');
const { createSession } = require('./session');

function parseArgs(argv) {
  const options = { debug: false, seed: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--debug') options.debug = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--seed') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: '--seed 뒤에 값을 적어 주세요. 예: --seed 100' };
      options.seed = /^-?\d+$/.test(value) ? Number(value) : value;
      i += 1;
    } else return { error: `알 수 없는 옵션입니다: ${arg}` };
  }
  return options;
}

function main(argv, io) {
  const out = (io && io.out) || ((text) => process.stdout.write(`${text}\n`));
  const options = parseArgs(argv);
  if (options.error) { out(options.error); return Promise.resolve(2); }
  if (options.help) {
    out(['사용법: node web/galpang/cli.js [--seed <값>] [--debug]', '  --seed   같은 값이면 같은 게임(재현용)', '  --debug  정답과 힌트 계획을 보여 줌(개발용)'].join('\n'));
    return Promise.resolve(0);
  }
  const session = createSession({ seed: options.seed, debug: options.debug });
  out(session.intro().join('\n'));
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: (io && io.input) || process.stdin, terminal: false });
    const prompt = () => { if (!(io && io.quiet)) process.stdout.write('\n> '); };
    let done = false; // 끝낸 뒤에 이미 읽어 둔 입력이 더 있어도 처리하지 않는다
    prompt();
    rl.on('line', (line) => {
      if (done) return;
      const { lines, exit } = session.handleLine(line);
      if (lines.length) out(lines.join('\n'));
      if (exit) { done = true; rl.close(); return; }
      prompt();
    });
    rl.on('close', () => resolve(0));
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = { main, parseArgs };
