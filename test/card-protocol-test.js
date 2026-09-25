'use strict';

/**
 * 카드 게임 요청 형식 검사(web/protocol.js의 validateCardGameMessage).
 *
 *   - 화면(public/poker.js·blackjack.js·mind.js)이 실제로 보내는 요청은 모두 통과한다.
 *     여기서 막히면 그 버튼이 통째로 안 먹는다.
 *   - 형식이 틀린 요청(모르는 type, 문자열 불리언, 객체 ID, 너무 긴 이름 등)은 방에 닿기 전에 거절한다.
 *   - 게임마다 자기 요청만 받는다(포커에 hit, 블랙잭에 starVote 등은 거절).
 *
 * 실행: node test/card-protocol-test.js
 */

const { validateCardGameMessage } = require('../web/protocol');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

const ID = 'a1b2c3d4e5f60718';
const TOKEN = 'f'.repeat(36);
// 화면이 보내는 모양 그대로(금액 칸을 비우면 Number('')=0, 글자를 넣으면 NaN → JSON에서 null).
const COMMON = [
  { type: 'ping' },
  { type: 'cover' },
  { type: 'coverState', covered: true },
  { type: 'coverState', covered: false },
  { type: 'join', nickname: '김하늘', token: null },
  { type: 'join', nickname: '김하늘', token: TOKEN },
  { type: 'join', nickname: '😀'.repeat(12) },
  { type: 'ready', ready: true },
  { type: 'leave' },
  { type: 'start' },
];
const BETTING = [
  { type: 'baseBet', amount: 1000 },
  { type: 'baseBet', amount: 0 },
  { type: 'baseBet', amount: null },
  { type: 'baseBetVote', proposalId: ID, agree: true },
  { type: 'call' },
  { type: 'raise', amount: 100 },
  { type: 'raise', amount: 150.5 },
  { type: 'allin' },
  { type: 'fold' },
  { type: 'donate', targetId: ID, amount: 100 },
];
const SENT = {
  poker: [...COMMON, ...BETTING],
  blackjack: [...COMMON, ...BETTING, { type: 'hit' }, { type: 'stand' }],
  mind: [
    ...COMMON,
    { type: 'focus', focused: true },
    { type: 'focus', focused: false },
    { type: 'focus' },
    { type: 'pause' },
    { type: 'play' },
    { type: 'star' },
    { type: 'starVote', voteId: ID, agree: false },
  ],
};

for (const [game, messages] of Object.entries(SENT)) {
  const rejected = messages.map((m) => [m, validateCardGameMessage(game, m)]).filter(([, why]) => why);
  check(`${game}: 화면이 보내는 요청 ${messages.length}가지는 모두 통과한다`, rejected.length === 0,
    rejected.map(([m, why]) => `${JSON.stringify(m)} → ${why}`).join(' / '));
}

const BAD = [
  ['객체가 아닌 요청', 'poker', null],
  ['배열', 'poker', []],
  ['type 없음', 'poker', { amount: 100 }],
  ['모르는 type', 'poker', { type: 'nonsense' }],
  ['프로토타입 이름 type', 'poker', { type: '__proto__' }],
  ['문자열 금액', 'poker', { type: 'raise', amount: '100' }],
  ['객체 금액', 'blackjack', { type: 'donate', targetId: ID, amount: { $gt: 0 } }],
  ['객체 ID', 'poker', { type: 'baseBetVote', proposalId: { $ne: null }, agree: true }],
  ['빈 ID', 'mind', { type: 'starVote', voteId: '', agree: true }],
  ['문자열 불리언(ready)', 'poker', { type: 'ready', ready: 'true' }],
  ['문자열 불리언(focused)', 'mind', { type: 'focus', focused: 'yes' }],
  ['문자열 불리언(covered)', 'blackjack', { type: 'coverState', covered: 1 }],
  ['빈 이름', 'mind', { type: 'join', nickname: '   ' }],
  ['너무 긴 이름', 'poker', { type: 'join', nickname: 'x'.repeat(25) }],
  ['너무 긴 토큰', 'blackjack', { type: 'join', nickname: '갑', token: 'x'.repeat(65) }],
  ['포커에 블랙잭 요청', 'poker', { type: 'hit' }],
  ['블랙잭에 더 마인드 요청', 'blackjack', { type: 'starVote', voteId: ID, agree: true }],
  ['더 마인드에 배팅 요청', 'mind', { type: 'raise', amount: 100 }],
  ['모르는 게임', 'liar', { type: 'ping' }],
  ['프로토타입 이름 게임', '__proto__', { type: 'ping' }],
];
for (const [name, game, msg] of BAD) {
  const why = validateCardGameMessage(game, msg);
  check(`거절: ${name}`, typeof why === 'string' && why.length > 0, `${JSON.stringify(msg)} → ${why}`);
}

console.log(`\n카드 게임 요청 형식: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
