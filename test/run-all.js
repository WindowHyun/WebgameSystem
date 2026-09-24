'use strict';

/** 전체 회귀 테스트 실행: node test/run-all.js */

const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  'blackjack-room-test.js',                // 딜러 없는 블랙잭 규칙
  'poker-room-test.js',                    // 인디언 포커 기본 규칙
  'card-game-edge-test.js',                // 카드 게임 악용·중단 방지 규칙
  'raise-floor-test.js',                   // 레이즈는 직전 레이즈 폭 이상이어야 한다
  'tie-rematch-test.js',                   // 동점 재대결이 폴드한 사람 카드를 지우지 않는다
  'short-stack-allin-test.js',             // 상대가 올인해도 더 적은 칩으로 올인할 수 있다
  'betting-integrity-test.js',             // 동점 재대결·이탈·끊김·기록 때문에 판돈이 엉뚱하게 가지 않는다
  'ante-test.js',                          // 앤티: 판 시작 때 전원이 기본 배팅금을 낸다, 폴드하면 잃는다
  'action-log-test.js',                   // 관리 로그: [게임] 닉네임 > 행동, 제시어·카드·점수는 새지 않는다
  'cover-pause-test.js',                   // 보스 키: 가려진 동안 제한시간 멈춤
  'reconnect-fold-test.js',                // 끊김·새로고침은 유예 뒤 폴드, 무효 판에서 떠난 사람 몫 환불, 스탠드 뒤 자리 정리
  'mind-room-test.js',                     // 더 마인드: 레벨·오름차순·실수·수리검·보상·승패·집중·끊김·로그
  'card-server-leave-test.js',             // 명시적 퇴장 즉시 제거·중복 입장 방지
  'liar-reconnect-test.js',                // 라이어 게임: 모바일 백그라운드 재접속 자리 인계
  'moderation-test.js',                   // 관전·강퇴 및 재접속 회귀
  'web-room-test.js',                     // 게임 규칙
  'fuzz-test.js',                          // 무작위 조작으로 규칙 두들기기
  'connection-test.js',                    // 연결 유지 / 죽은 연결 정리
  'render-http-test.js',                   // Render 정적 파일·상태 확인 최적화
  'security-headers-test.js',              // 보안 헤더 / 프록시 뒤 클라이언트 IP 판별
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
