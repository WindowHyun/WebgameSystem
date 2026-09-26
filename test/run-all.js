'use strict';

/**
 * 테스트 실행기.
 *
 *   npm test            = node test/run-all.js         핵심: 서버·게임 규칙(브라우저 없이, 몇 분)
 *   npm run test:ui     = node test/run-all.js --ui    화면: 브라우저로 띄우는 테스트(모바일 포함)
 *   npm run test:all    = node test/run-all.js --all   배포 전 전체: 핵심 + 화면 + 오래 걸리는 것
 *
 *   이름 일부를 덧붙이면 그 스위트만 돈다:  node test/run-all.js --ui cover mind
 *   --verbose를 붙이면 각 스위트의 출력을 그대로 보여 준다(기본은 한 줄 요약, 실패만 자세히).
 *
 * [리뷰 P2-05·06] 예전에는 이 파일의 배열에 손으로 등록한 스위트만 돌았다. 그래서 npm test가
 * "전체 통과"라고 해도 브라우저 테스트 16개(모바일 포함)는 한 번도 돌지 않았고, 새 테스트를
 * 만들고 등록을 잊으면 조용히 빠졌다. 이제 test/ 안의 *-test.js를 모두 찾아서, 브라우저
 * (playwright)를 쓰는지로 핵심/화면을 나눈다. 새 테스트는 만들기만 하면 해당 묶음에 들어간다.
 *
 * 각 스위트는 자기 프로세스 그룹에서 돈다. 시간이 넘거나 Ctrl+C를 누르면 그 스위트가 띄운
 * 서버(web/server.js 자식 프로세스 등)까지 그룹째 끈다. 직계 자식만 끄면 손주가 포트를 쥔 채
 * 남아서, 뒤에 도는 스위트들이 "포트 사용 중"으로 줄줄이 실패했다.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 한 번에 20분 넘게 걸리는 것. --all이거나 이름으로 콕 집었을 때만 돈다.
const SLOW = new Set(['background-return-test.js']);
const TIMEOUT_MS = { core: 10 * 60 * 1000, ui: 20 * 60 * 1000, slow: 45 * 60 * 1000 };

const args = process.argv.slice(2);
const wantUi = args.includes('--ui');
const wantAll = args.includes('--all');
const verbose = args.includes('--verbose');
const filters = args.filter((a) => !a.startsWith('--'));

// 몇몇 테스트(restart·play)는 PORT가 있으면 그 포트를 쓴다. 셸에 PORT가 잡혀 있으면(Render 셸,
// 다른 서버를 띄워 둔 터미널) 그 포트와 부딪히므로 스위트에는 넘기지 않는다. 각자 기본 포트를 쓴다.
const childEnv = { ...process.env };
delete childEnv.PORT;

function kindOf(file) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  if (!/require\((['"])playwright\1\)/.test(source)) return 'core';
  return SLOW.has(file) ? 'slow' : 'ui';
}

const all = fs.readdirSync(__dirname).filter((f) => f.endsWith('-test.js')).sort().map((file) => ({ file, kind: kindOf(file) }));
const suites = all.filter(({ file, kind }) => {
  if (filters.length) return filters.some((word) => file.includes(word)); // 이름으로 고르면 종류와 상관없이 돈다
  if (wantAll) return true;
  if (wantUi) return kind === 'ui';
  return kind === 'core';
});

if (suites.length === 0) {
  console.log('실행할 스위트가 없습니다. 이름을 확인하세요.');
  process.exit(1);
}

const label = filters.length ? '고른' : wantAll ? '전체' : wantUi ? '화면' : '핵심';
console.log(`${label} 테스트 ${suites.length}개를 실행합니다.\n`);

// 서버 로그([2026-...] ...)를 빼고 사람이 읽을 줄만 남긴다.
const readable = (text) => text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('[20'));

const GROUPS = process.platform !== 'win32'; // 윈도에는 프로세스 그룹이 없어 taskkill /T로 대신한다
let current = null; // 지금 도는 스위트

/** 스위트와 그 스위트가 띄운 프로세스를 모두 끈다. */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (GROUPS) process.kill(-child.pid, 'SIGKILL');
    else spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (error) { /* 이미 끝났다 */ }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killTree(current);
    console.log(`\n중단됨(${signal})`);
    process.exit(130);
  });
}

function runSuite(file, kind) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: path.join(__dirname, '..'),
      env: childEnv,
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      detached: GROUPS, // 자기 프로세스 그룹 - 끌 때 그룹째 끈다
    });
    current = child;
    const out = { stdout: '', stderr: '' };
    if (!verbose) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out.stdout += chunk; });
      child.stderr.on('data', (chunk) => { out.stderr += chunk; });
    }
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, TIMEOUT_MS[kind]);
    const finish = (status, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      current = null;
      resolve({ status, signal, error, timedOut, ...out });
    };
    child.on('error', (error) => finish(null, null, error));
    // 출력이 다 들어온 뒤(close)에 끝낸다. 손주가 출력 통로를 쥐고 안 놓으면 종료(exit) 5초 뒤에 끝낸다.
    child.on('close', (status, signal) => finish(status, signal));
    child.on('exit', (status, signal) => { setTimeout(() => finish(status, signal), 5000).unref(); });
  });
}

(async () => {
  const failed = [];
  const started = Date.now();
  for (const { file, kind } of suites) {
    const t0 = Date.now();
    if (verbose) console.log(`▶ ${file}`);
    else process.stdout.write(`▶ ${file} ... `);
    const r = await runSuite(file, kind);
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const timedOut = r.timedOut;
    const ok = r.status === 0 && !timedOut && !r.error;
    const lines = verbose ? [] : readable(`${r.stdout || ''}\n${r.stderr || ''}`);
    // 요약은 끝에서부터 결과를 말하는 줄을 고른다(node:test 스위트는 마지막 줄이 걸린 시간이다).
    const out = readable(r.stdout || '');
    const summary = out.slice().reverse().find((line) => /통과|실패|문제 없음|발견|^# pass /.test(line)) || out.pop() || '';
    if (ok) {
      console.log(verbose ? `  통과 (${seconds}초)\n` : `통과 (${seconds}초)${summary ? ` - ${summary.trim()}` : ''}`);
      continue;
    }
    failed.push(file);
    const why = timedOut ? `시간 초과(${Math.round(TIMEOUT_MS[kind] / 60000)}분)` : r.error ? r.error.message : `종료 코드 ${r.status}${r.signal ? `, ${r.signal}` : ''}`;
    console.log(`${verbose ? '  ' : ''}실패 (${seconds}초, ${why})`);
    if (!verbose) {
      // 실패한 줄을 먼저, 그다음 마지막 출력을 보여 준다.
      const fails = lines.filter((line) => /FAIL|Error|실패|✗/.test(line)).slice(0, 30);
      const tail = lines.slice(-15).filter((line) => !fails.includes(line));
      for (const line of [...fails, ...tail]) console.log(`    ${line}`);
    }
    console.log('');
  }

  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  console.log('');
  console.log(failed.length === 0
    ? `전체 통과 (${label} ${suites.length}개, ${minutes}분)`
    : `${failed.length}개 스위트 실패 (${label} ${suites.length}개 중, ${minutes}분): ${failed.join(', ')}`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
