'use strict';

/**
 * 카드 게임 요청 형식 검사(web/protocol.js의 validateCardGameMessage).
 *
 *   - 화면(public/poker.js·blackjack.js·mind.js)이 실제로 보내는 요청은 모두 통과한다.
 *     여기서 막히면 그 버튼이 통째로 안 먹는다.
 *   - 형식이 틀린 요청(모르는 type, 문자열 불리언, 객체 ID, 너무 긴 이름 등)은 방에 닿기 전에 거절한다.
 *   - 게임마다 자기 요청만 받는다(포커에 hit, 블랙잭에 starVote 등은 거절).
 *   - 형식 검사 표(web/protocol.js)와 방이 처리하는 표(web/game-server.js)가 같은 요청을 말한다.
 *     한쪽에만 추가하면 "검사는 통과했는데 아무 일도 안 일어나는" 요청이나 "처리는 되는데 늘
 *     거절되는" 버튼이 생긴다.
 *
 * 실행: node test/card-protocol-test.js
 */

const { validateCardGameMessage, CARD_GAME_MESSAGES } = require('../web/protocol');
const { CARD_GAME_ACTIONS } = require('../web/game-server');

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
  // iPhone 한글 입력기는 입력칸의 24자 제한을 넘기는 일이 있다. 받아 두고 방이 24자로 자른다.
  { type: 'join', nickname: '가'.repeat(30) },
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
  ['너무 긴 이름', 'poker', { type: 'join', nickname: 'x'.repeat(65) }],
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

// 서버가 게임과 상관없이 먼저 처리하는 요청(web/game-server.js의 카드 게임 연결 처리).
const BUILT_IN = ['ping', 'cover', 'coverState', 'join', 'leave'];
const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
check('형식 검사 표와 처리 표가 같은 게임들을 말한다', sameList(Object.keys(CARD_GAME_MESSAGES), Object.keys(CARD_GAME_ACTIONS)),
  `검사 ${Object.keys(CARD_GAME_MESSAGES)} / 처리 ${Object.keys(CARD_GAME_ACTIONS)}`);
for (const game of Object.keys(CARD_GAME_MESSAGES)) {
  const accepted = Object.keys(CARD_GAME_MESSAGES[game]).filter((type) => !BUILT_IN.includes(type));
  const handled = Object.keys(CARD_GAME_ACTIONS[game] || {});
  check(`${game}: 형식 검사가 받는 요청과 방이 처리하는 요청이 같다`, sameList(accepted, handled),
    `검사만: ${accepted.filter((t) => !handled.includes(t)).join(',') || '-'} / 처리만: ${handled.filter((t) => !accepted.includes(t)).join(',') || '-'}`);
  const missing = BUILT_IN.filter((type) => !(type in CARD_GAME_MESSAGES[game]));
  check(`${game}: 서버가 먼저 처리하는 요청(ping·보스 키·참가·나가기)도 검사를 통과한다`, missing.length === 0, missing.join(','));
}
// 방이 받은 이름은 글자 단위로 24자까지만 쓴다.
{
  const { createPokerRoom } = require('../web/poker-room');
  const { createBlackjackRoom } = require('../web/blackjack-room');
  const { createMindRoom } = require('../web/mind-room');
  for (const [game, create] of [['poker', createPokerRoom], ['blackjack', createBlackjackRoom], ['mind', createMindRoom]]) {
    const room = create({ onChange() {}, onAction() {} });
    try {
      const joined = room.join({ nickname: '가'.repeat(30) });
      const emoji = room.join({ nickname: '😀'.repeat(30) });
      const names = [joined, emoji].map((r) => (r && r.playerId ? room.stateFor(r.playerId).players.find((p) => p.id === r.playerId).nickname : null));
      check(`${game}: 긴 이름은 24글자로 잘라 들어간다(이모지도 반으로 쪼개지지 않는다)`,
        names[0] === '가'.repeat(24) && names[1] === '😀'.repeat(24), names.map((n) => n && `${Array.from(n).length}자`).join(', '));
    } finally {
      if (room.dispose) room.dispose();
    }
  }
}

console.log(`\n카드 게임 요청 형식: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
