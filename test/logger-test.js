'use strict';

/**
 * 로그 파일(logger.js) - 5MB를 넘으면 .1로 밀어내고 새로 쓴다.
 *
 *   - 크기는 글자 수가 아니라 바이트로 센다. 한 글자가 3바이트인 한글 로그를 글자 수로 세면
 *     5MB 제한인데도 실제 파일은 최대 15MB까지 쌓였다(리뷰 P3-01).
 *
 * 진짜 로그(시스템 임시 폴더의 liar-game.log)를 건드리지 않도록, 따로 만든 임시 폴더를 쓰는
 * 자식 프로세스에서 로그를 남긴다.
 *
 * 실행: node test/logger-test.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

const MAX_BYTES = 5 * 1024 * 1024;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
try {
  // 한글 1000자(약 3KB) 줄을 300줄씩(약 0.9MB) 여덟 번, 쓰기 묶음(200ms)이 나뉘도록 쉬어 가며 남긴다.
  // 모두 합치면 약 7MB지만 글자 수로는 240만 자라서, 글자 수로 세면 5MB(524만)에 한참 못 미친다.
  const child = `
    const { log } = require(${JSON.stringify(path.join(__dirname, '..', 'logger.js'))});
    const line = '가'.repeat(1000);
    let round = 0;
    (function next() {
      if (round++ === 8) { setTimeout(() => {}, 600); return; }
      for (let i = 0; i < 300; i += 1) log(line);
      setTimeout(next, 450);
    })();
  `;
  const env = { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir };
  const r = spawnSync(process.execPath, ['-e', child], { env, stdio: 'ignore', timeout: 60000 });
  check('로그를 남기는 프로세스가 정상 종료한다', r.status === 0, r.error ? r.error.message : `종료 코드 ${r.status}`);

  const current = path.join(dir, 'liar-game.log');
  const rotated = `${current}.1`;
  const size = (file) => (fs.existsSync(file) ? fs.statSync(file).size : 0);
  const total = size(current) + size(rotated);
  check('한글 로그 약 7MB를 모두 파일에 남겼다', total > 6.5 * 1024 * 1024, `${total} 바이트`);
  check('5MB를 넘으면 .1로 밀어낸다(글자 수가 아니라 바이트로 센다)', fs.existsSync(rotated), `.1 없음, 현재 ${size(current)} 바이트`);
  check('지금 쓰는 파일은 5MB를 넘지 않는다', size(current) <= MAX_BYTES, `${size(current)} 바이트`);
  check('밀어낸 파일도 5MB를 크게 넘지 않는다(쓰기 한 묶음 이내)', size(rotated) <= MAX_BYTES + 1024 * 1024, `${size(rotated)} 바이트`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n로그 파일: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
