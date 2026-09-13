'use strict';

/** 전체 회귀 테스트 실행: node test/run-all.js */

const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  'blackjack-room-test.js',                // 딜러 없는 블랙잭 규칙
  'poker-room-test.js',                    // 인디언 포커 기본 규칙
  'card-game-edge-test.js',                // 카드 게임 악용·중단 방지 규칙
  'card-server-leave-test.js',             // 명시적 퇴장 즉시 제거·중복 입장 방지
  'moderation-test.js',                   // 관전·강퇴 및 재접속 회귀
  'web-room-test.js',                     // 게임 규칙
  'fuzz-test.js',                          // 무작위 조작으로 규칙 두들기기
  'connection-test.js',                    // 연결 유지 / 죽은 연결 정리
  'render-http-test.js',                   // Render 정적 파일·상태 확인 최적화
  'vercel-adapter-test.js',                // Vercel export 서버에서 실제 WebSocket 연결
];
let failed = 0;

for (const suite of suites) {
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
  console.log('');
}

console.log(failed === 0 ? '전체 통과' : `${failed}개 스위트 실패`);
process.exit(failed === 0 ? 0 : 1);
