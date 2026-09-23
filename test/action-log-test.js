'use strict';

/**
 * [관리 로그] "[포커] 김하늘 > 콜 100원" 형식으로 누가 무엇을 했는지 남는가.
 *
 * 형식보다 더 중요한 것은 로그로 새면 안 되는 것들이다. 로그를 보는 사람(운영자)이
 * 게임에 끼는 경우가 흔하므로, 게임 중에 로그를 보고 답을 알 수 있으면 안 된다.
 *   - 라이어: 제시어, 누가 라이어인지, 대화 내용, 정답으로 낸 단어
 *   - 블랙잭: 게임 화면의 기록에 카드·점수(관리 로그에는 운영 결정으로 남긴다)
 *   - 포커: 판이 끝나기 전의 카드
 * 그리고 닉네임에 줄바꿈을 넣어 없던 줄을 로그에 끼워 넣을 수 없어야 한다.
 */

const WebSocket = require('ws');
const { createRoom } = require('../web/room');
const { createPokerRoom } = require('../web/poker-room');
const { createBlackjackRoom } = require('../web/blackjack-room');
const { createGameServer } = require('../web/game-server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

function recorder() {
  const lines = [];
  return { lines, onAction: (who, what) => lines.push(`${who} > ${what}`) };
}
const has = (lines, text) => lines.some((l) => l.includes(text));

function testPoker() {
  console.log('\n=== 포커 ===');
  const log = recorder();
  const room = createPokerRoom({ onChange() {}, onAction: log.onAction, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
  const a = room.join({ nickname: '김하늘' });
  const b = room.join({ nickname: '박서준' });
  room.setReady(a.playerId, true); room.setReady(b.playerId, true);
  room.begin(a.playerId);
  const view = () => room.stateFor(a.playerId);
  const first = view().turnPlayerId;
  const firstName = view().players.find((p) => p.id === first).nickname;
  room.raise(first, 500);
  const second = view().turnPlayerId;
  const secondName = view().players.find((p) => p.id === second).nickname;
  const cardsWhileBetting = view().players.map((p) => p.card).filter((c) => c && !c.hidden);
  const beforeEnd = log.lines.slice();
  room.call(second);

  check('입장이 남는다', has(log.lines, '김하늘 > 입장 (칩 1,000,000원)'), log.lines[0]);
  check('누가 시작했는지 남는다', has(log.lines, '김하늘 > 게임 시작 (2명: 김하늘, 박서준)'));
  check('레이즈가 금액과 함께 남는다', has(log.lines, `${firstName} > 레이즈 500원 (판돈 600원)`));
  check('콜이 실제로 낸 금액과 함께 남는다', has(log.lines, `${secondName} > 콜 600원`));
  check('판이 끝나면 쇼다운 카드가 남는다', has(log.lines, '진행 > 쇼다운: '));
  check('누가 얼마를 가져갔는지 남는다', log.lines.some((l) => / > 팟 1,200원 획득/.test(l)) || has(log.lines, '동점 재대결'),
    log.lines.slice(-2).join(' / '));
  // 배팅 중(콜 전)까지의 로그에는 어떤 카드도 없어야 한다.
  const cardText = cardsWhileBetting.map((c) => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[c.rank] || c.rank) + c.suit);
  check('판이 끝나기 전 로그에는 카드가 없다',
    !beforeEnd.some((l) => cardText.some((c) => l.includes(c))), beforeEnd.join(' / '));
  room.dispose();
}

function testBlackjackCardsAndTotals() {
  console.log('\n=== 블랙잭 ===');
  // [운영 결정] 관리 로그에는 받은 카드와 그때의 점수를 남긴다(운영자가 판을 되짚도록).
  // 대신 참가자끼리 보는 게임 화면의 기록에는 여전히 남기지 않는다 - 그게 블러핑의 전제다.
  const cardName = (c) => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[c.rank] || c.rank) + c.suit;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const log = recorder();
    const room = createBlackjackRoom({ onChange() {}, onAction: log.onAction, actionTimeoutMs: 0, proposalTimeoutMs: 0 });
    const a = room.join({ nickname: '갑' }); const b = room.join({ nickname: '을' });
    room.setReady(a.playerId, true); room.setReady(b.playerId, true);
    room.begin(a.playerId);
    const hitter = room.stateFor(a.playerId).turnPlayerId;
    const other = hitter === a.playerId ? b.playerId : a.playerId;
    const name = room.stateFor(hitter).players.find((p) => p.id === hitter).nickname;
    const dealt = room.stateFor(hitter).players.find((p) => p.id === hitter);
    for (let i = 0; i < 5; i += 1) room.hit(hitter);
    const me = room.stateFor(hitter).players.find((p) => p.id === hitter);
    if (!me.isBusted) { room.dispose(); continue; }

    check('처음 받은 두 장과 점수가 남는다',
      has(log.lines, `${name} > 카드 받음: ${dealt.cards.map(cardName).join(' ')} → ${dealt.score}점, 2장`),
      log.lines.filter((l) => l.includes('카드 받음')).join(' / '));
    check('상대가 받은 두 장도 남는다', log.lines.filter((l) => l.includes('> 카드 받음:')).length === 2);
    const last = me.cards[me.cards.length - 1];
    check('히트로 뽑은 카드와 그때의 점수가 남는다',
      has(log.lines, `${name} > 히트: ${cardName(last)} 받음 → ${me.score}점, 21 초과, ${me.cards.length}장`),
      log.lines.filter((l) => l.includes('히트')).slice(-1)[0]);
    // 히트마다 누적 점수가 실제 손패와 맞는지 - 한 줄씩 다시 계산해 본다.
    const hitLines = log.lines.filter((l) => l.startsWith(`${name} > 히트:`));
    let running = dealt.score;
    let consistent = hitLines.length === me.cards.length - 2;
    me.cards.slice(2).forEach((card, i) => {
      running += card.rank > 10 ? 10 : card.rank;
      if (!hitLines[i] || !hitLines[i].includes(`${cardName(card)} 받음 → ${running}점`)) consistent = false;
    });
    check('히트할 때마다 적힌 점수가 실제 손패의 누적 점수와 같다', consistent, hitLines.join(' / '));

    const seenByOther = room.stateFor(other).history.map((h) => h.text);
    check('게임 화면의 기록에는 여전히 카드도 점수도 없다',
      !seenByOther.some((t) => /점|초과|♠|♥|♦|♣/.test(t)), seenByOther.join(' / '));
    room.stand(hitter);
    check('스탠드할 때의 점수가 남는다', has(log.lines, `${name} > 스탠드 → ${me.score}점, 21 초과`));
    room.dispose();
    return;
  }
  check('21 초과가 한 번은 나와야 검사할 수 있다', false);
}

function testLiarNeverLeaksAnswer() {
  console.log('\n=== 라이어 ===');
  const log = recorder();
  const room = createRoom({ onChange() {}, onAction: log.onAction, random: () => 0 });
  const ids = ['김하늘', '박서준', '이도현'].map((n) => room.join({ nickname: n }).playerId);
  room.start(ids[1]);
  const { round } = room._debug();
  const word = round.word;
  const liarName = round.roster.find((r) => r.id === round.liarId).nickname;
  const secret = `아주 비밀스러운 ${word} 설명`;

  // 한 바퀴 설명 → 2차는 반대 → 바로 투표 → 라이어 지목 → 제시어를 댄다.
  for (let i = 0; i < 3; i += 1) {
    const d = room._debug();
    room.say(d.round.speakOrder[d.round.speakIndex], secret);
  }
  for (const id of ids) room.respondProposal(id, false);
  for (const id of ids) {
    const target = id === round.liarId ? ids.find((x) => x !== id) : round.liarId;
    room.vote(id, target);
  }
  room.guess(round.liarId, word); // 맞힌다 - 제출한 단어가 곧 제시어다

  const all = log.lines.join('\n');
  check('게임 시작이 남는다', has(log.lines, '박서준 > 게임 시작 (3명)'));
  check('설명한 사실이 남는다', has(log.lines, '> 설명 (1차)'));
  check('찬반이 무엇에 대한 것인지 함께 남는다', has(log.lines, '> 2차 설명 반대'));
  check('투표가 대상과 함께 남는다', log.lines.some((l) => /> 투표 → /.test(l)));
  check('정답을 낸 사실은 남는다', has(log.lines, `${liarName} > 정답 제출`));
  check('결과가 사유와 함께 남는다', has(log.lines, '결과 > 담당자 승리 (정답 제출로 결정)'));
  check('제시어는 어디에도 없다', !all.includes(word), log.lines.find((l) => l.includes(word)));
  check('대화 내용은 없다', !all.includes('비밀스러운'));
  check('누가 라이어인지 말하는 줄이 없다', !/라이어|담당자는/.test(all.replace(/담당자 승리/g, '')));
  room.dispose();
}

/** 실제 서버: 한 줄 형식과, 닉네임 줄바꿈으로 가짜 줄을 끼워 넣을 수 없는지. */
async function testServerLines() {
  console.log('\n=== 서버 로그 한 줄 ===');
  const captured = [];
  const original = console.error;
  console.error = (line) => { captured.push(String(line)); };
  const port = 4531;
  const server = createGameServer({ port, host: '127.0.0.1' });
  try {
    await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?game=poker`);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'join', nickname: '악당\n[포커] 가짜 > 올인' }));
    await wait(300);
    ws.close();
    await wait(200);
  } finally {
    await server.stop();
    console.error = original;
  }
  const lines = captured.join('\n').split('\n');
  check('형식이 "[포커] 닉네임 > 행동"이다', lines.some((l) => l.includes('[포커] 악당 [포커] 가짜 > 올인 > 입장')),
    lines.filter((l) => l.includes('포커')).join(' / '));
  check('닉네임의 줄바꿈으로 가짜 줄을 끼워 넣을 수 없다', !lines.some((l) => l.startsWith('[포커] 가짜')));
}

async function main() {
  testPoker();
  testBlackjackCardsAndTotals();
  testLiarNeverLeaksAnswer();
  await testServerLines();
  console.log(`\n관리 로그: ${pass}개 통과, ${fail}개 실패`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
