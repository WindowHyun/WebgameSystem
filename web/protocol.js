'use strict';

/**
 * 브라우저 → 서버 메시지 검증.
 *
 * LAN 버전(../protocol.js)은 "LAN의 누구나 아무 패킷이나 보낼 수 있다"는 전제로 모든
 * 게임 메시지를 검증해야 했다. 웹 버전은 규칙 판정이 전부 서버에 있으므로, 검증할 것은
 * 브라우저가 보내는 조작 요청 몇 가지뿐이다.
 *
 * web/ 아래는 LAN 버전을 지워도 그대로 돌아가도록 자기완결적으로 둔다.
 */

// nickname: 방이 실제로 쓰는 이름 길이(글자 수).
// nicknameInput: 참가 요청에서 받아 주는 길이. iPhone 한글 입력기는 입력칸의 글자 수 제한(24자)을
//   넘기는 일이 있어서, 여기서 24자로 거절하면 이름 때문에 입장조차 못 했다. 넉넉히 받고 방이 24자로 자른다.
const LIMITS = { nickname: 24, nicknameInput: 64, text: 300, word: 60, id: 64, token: 64, command: 100 };

/**
 * 참가 이름을 방이 쓰는 길이(LIMITS.nickname 글자)로 다듬는다. 모든 방(라이어·포커·블랙잭·더 마인드)이
 * 이것 하나를 쓴다 - 예전에는 같은 자르기가 방마다 숫자 24를 박은 채 복사돼 있었다.
 * 글자는 사람이 보는 한 글자(자소 묶음) 단위로 센다. 코드 포인트(Array.from)로 자르면 가족·국기·
 * 피부색 이모지처럼 여러 코드 포인트로 된 글자가 반으로 갈려 깨진 글자로 남았다.
 */
const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ko', { granularity: 'grapheme' }) : null;
function cleanNickname(value) {
  const text = String(value == null ? '' : value).trim();
  const chars = graphemes ? Array.from(graphemes.segment(text), (part) => part.segment) : Array.from(text);
  return chars.slice(0, LIMITS.nickname).join('');
}

function str(v, max) { return typeof v === 'string' && v.trim().length > 0 && v.length <= max; }
function optStr(v, max) { return v === undefined || v === null || (typeof v === 'string' && v.length <= max); }

const CLIENT_MESSAGES = {
  join: (m) => (str(m.nickname, LIMITS.nicknameInput) && optStr(m.token, LIMITS.token) && (m.spectator === undefined || typeof m.spectator === 'boolean') ? null : 'nickname/token'),
  mode: (m) => (typeof m.spectator === 'boolean' ? null : 'spectator'),
  kick: (m) => (str(m.targetId, LIMITS.id) ? null : 'targetId'),
  kickVote: (m) => (str(m.proposalId, LIMITS.id) && typeof m.agree === 'boolean' ? null : 'proposalId/agree'),
  start: () => null,
  leave: () => null,
  ping: () => null,   // [E-3] 화면이 연결이 살아 있는지 확인하는 용도
  cover: () => null,  // [보스 키] 한 명이 가리면 모두의 화면을 가린다
  coverState: (m) => (typeof m.covered === 'boolean' ? null : 'covered'), // 내 화면이 가려졌는지 - 가려진 동안 제한시간을 멈춘다
  chat: (m) => (str(m.text, LIMITS.text) ? null : 'text'),
  callVote: () => null,
  proposalVote: (m) => (typeof m.agree === 'boolean' ? null : 'agree'),
  vote: (m) => (str(m.targetId, LIMITS.id) ? null : 'targetId'),
  guess: (m) => (str(m.word, LIMITS.word) ? null : 'word'),
};

/**
 * [리뷰 P1-02] 카드 게임(포커·블랙잭·더 마인드·갈팡질팡)도 라이어처럼 들어오는 요청의 형식을 여기서 한 번에
 * 검사한다. 예전에는 게임 서버 분기와 각 방 안에 검사가 흩어져 있어서, 새 요청을 추가할 때 빠뜨리기 쉬웠다.
 * 여기서는 형식만 본다. 금액은 숫자(칸을 비우면 브라우저가 보내는 null 포함)인지만 보고, 100원 단위나
 * 보유 칩 같은 규칙은 방이 알맞은 안내와 함께 거절한다.
 */
const amountOk = (m) => m.amount === null || (typeof m.amount === 'number' && Number.isFinite(m.amount));
const CARD_COMMON = {
  ping: () => null,
  cover: () => null,
  coverState: (m) => (typeof m.covered === 'boolean' ? null : 'covered'),
  join: (m) => (str(m.nickname, LIMITS.nicknameInput) && optStr(m.token, LIMITS.token) ? null : 'nickname/token'),
  leave: () => null,
  ready: (m) => (typeof m.ready === 'boolean' ? null : 'ready'),
  start: () => null,
};
const BETTING = {
  baseBet: (m) => (amountOk(m) ? null : 'amount'),
  baseBetVote: (m) => (str(m.proposalId, LIMITS.id) && typeof m.agree === 'boolean' ? null : 'proposalId/agree'),
  call: () => null,
  raise: (m) => (amountOk(m) ? null : 'amount'),
  allin: () => null,
  fold: () => null,
  donate: (m) => (str(m.targetId, LIMITS.id) && amountOk(m) ? null : 'targetId/amount'),
};
const CARD_GAME_MESSAGES = {
  poker: { ...CARD_COMMON, ...BETTING },
  blackjack: { ...CARD_COMMON, ...BETTING, hit: () => null, stand: () => null },
  mind: {
    ...CARD_COMMON,
    focus: (m) => (m.focused === undefined || typeof m.focused === 'boolean' ? null : 'focused'),
    pause: () => null,
    play: () => null,
    star: () => null,
    starVote: (m) => (str(m.voteId, LIMITS.id) && typeof m.agree === 'boolean' ? null : 'voteId/agree'),
  },
  // 혼자 하는 게임: 준비·시작이 없고 조작은 모두 명령어 한 줄이다. Enter만 친 빈 줄도 받는다(방이 무시한다).
  galpang: {
    ping: CARD_COMMON.ping,
    cover: CARD_COMMON.cover,
    coverState: CARD_COMMON.coverState,
    join: CARD_COMMON.join,
    leave: CARD_COMMON.leave,
    command: (m) => (typeof m.line === 'string' && m.line.length <= LIMITS.command ? null : 'line'),
  },
};

function checkAgainst(table, msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return '메시지가 객체가 아님';
  if (typeof msg.type !== 'string') return 'type 없음';
  const check = Object.hasOwn(table, msg.type) ? table[msg.type] : null;
  if (!check) return `알 수 없는 type: ${String(msg.type).slice(0, 32)}`;
  const bad = check(msg);
  return bad ? `${msg.type}의 ${bad} 필드가 형식에 맞지 않음` : null;
}

/** 라이어 게임 요청. 문제가 없으면 null, 있으면 사유 문자열. */
function validateClientMessage(msg) {
  return checkAgainst(CLIENT_MESSAGES, msg);
}

/** 카드 게임 요청. game은 'poker' | 'blackjack' | 'mind' | 'galpang'. 문제가 없으면 null, 있으면 사유 문자열. */
function validateCardGameMessage(game, msg) {
  if (!Object.hasOwn(CARD_GAME_MESSAGES, game)) return `알 수 없는 게임: ${String(game).slice(0, 32)}`;
  return checkAgainst(CARD_GAME_MESSAGES[game], msg);
}

/** 제시어 비교용 정규화. 공백·대소문자 차이로 맞힌 정답이 오답 처리되지 않게 한다. */
function normalizeWord(word) {
  return String(word == null ? '' : word).trim().toLowerCase().replace(/\s+/g, '');
}

module.exports = { validateClientMessage, validateCardGameMessage, CARD_GAME_MESSAGES, normalizeWord, cleanNickname, LIMITS };
