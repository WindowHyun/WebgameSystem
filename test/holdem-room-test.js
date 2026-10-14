'use strict';

/**
 * 텍사스 홀덤 방(web/holdem-room.js).
 *
 *   - 딜러는 없다: 카드는 자동으로 나눠지고 참가자는 모두 플레이어다. 블라인드는 판마다 한 칸씩 돌아가며 낸다(기준 자리인 버튼은
 *     화면에 내보내지 않는다). 둘이서 할 때는 스몰 블라인드 자리가 프리플랍에서 먼저 말한다.
 *   - 거리: 프리플랍 → 플랍(3장) → 턴 → 리버. 거리마다 배팅이 끝나야 다음으로 넘어가고, 거리마다 말하는 순서가 정해져 있다.
 *   - 쇼다운: 내 카드 2장 + 공용 5장 중 가장 좋은 5장으로 가린다. 비기면 팟을 나누고 남는 몫은 버튼 다음 자리부터 준다.
 *   - 카드 공개: 배팅 중에는 내 카드만 보이고, 모두 폴드해서 끝난 판은 이긴 사람도 카드를 보이지 않는다.
 *   - 올인: 사이드 팟이 없다. 올인이 나오면 그 금액이 상한이 되고(넘치는 몫은 돌려준다), 더 배팅하지 않고 공용 카드를 깐다.
 *   - 제한시간: 공짜로 넘어갈 수 있으면 체크, 아니면 폴드. 끊긴 사람은 유예 동안 자리를 지킨다.
 *   - 칩이 어떤 경우에도 새거나 늘지 않는다(무작위로 수백 판을 돌려 확인한다).
 *
 * 실행: node test/holdem-room-test.js
 */

const { createHoldemRoom, INITIAL_CHIPS } = require('../web/holdem-room');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 도구 ──────────────────────────────────────────────────
const SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANKS = { A: 1, T: 10, J: 11, Q: 12, K: 13 };
const cards = (text) => text.trim().split(/\s+/).map((token) => ({ rank: RANKS[token.slice(0, -1)] || Number(token.slice(0, -1)), suit: SUITS[token.slice(-1)] }));
/** 나눠 줄 순서대로 적으면(자리 순서대로 두 장씩, 그다음 공용 카드 5장) 그 순서로 뽑히는 덱을 만든다. */
const stacked = (text) => () => cards(text).reverse();

/** 방과 참가자 n명(A, B, C...)을 만든다. 모두 준비까지 시켜 둔다. */
function table(names, options) {
  const { chips, ...roomOptions } = options || {};
  // chips: { B: 300 }처럼 이름별 시작 칩. 적은 칩이 있는 판을 만들 때 쓴다.
  const initialChips = chips ? (index) => (chips[names[index]] === undefined ? INITIAL_CHIPS : chips[names[index]]) : undefined;
  const room = createHoldemRoom({ onChange() {}, actionTimeoutMs: 0, initialChips, ...roomOptions });
  const seats = names.map((nickname) => room.join({ nickname }));
  const id = Object.fromEntries(names.map((name, i) => [name, seats[i].playerId]));
  const ready = () => seats.forEach((seat) => room.setReady(seat.playerId, true));
  ready();
  const view = (who) => room.stateFor(id[who || names[0]]);
  const me = (who, viewer) => view(viewer).players.find((p) => p.id === id[who]);
  const nameOf = (pid) => names.find((name) => id[name] === pid);
  const turn = () => nameOf(view().turnPlayerId);
  const total = () => { const s = view(); return s.pot + s.players.reduce((sum, p) => sum + p.chips, 0); };
  return { room, names, seats, id, ready, view, me, turn, nameOf, total };
}
/** 차례인 사람이 call(체크)만 해서 거리를 끝낸다. */
function checkAround(t) {
  const street = t.view().street;
  let guard = 0;
  while (t.view().phase === 'betting' && t.view().street === street && guard++ < 20) t.room.call(t.view().turnPlayerId);
}

(async () => {
  // ── 블라인드와 자리 돌리기(딜러 없이 모두가 플레이어) ──────────
  {
    const t = table(['A', 'B', 'C']);
    check('세 명이 준비하면 시작할 수 있다', t.room.begin(t.id.A) === null);
    const s = t.view();
    check('첫 판은 첫 자리가 버튼이라 스몰 블라인드는 둘째, 빅 블라인드는 셋째 자리다', s.smallBlindId === t.id.B && s.bigBlindId === t.id.C);
    check('상태에 딜러(사람)를 가리키는 값이 없다 - 세 명 모두 플레이어다', !('dealerId' in s) && s.players.length === 3 && s.players.every((p) => p.inRound && p.cards && p.cards.length === 2));
    check('스몰 블라인드는 기본 배팅금의 절반, 빅 블라인드는 기본 배팅금을 낸다', t.me('B').roundBet === 50 && t.me('C').roundBet === 100 && s.pot === 150 && s.smallBlind === 50);
    check('프리플랍은 빅 블라인드 다음 사람부터 말한다', t.turn() === 'A');
    check('블라인드를 낸 만큼 칩이 줄었다', t.me('B').chips === INITIAL_CHIPS - 50 && t.me('C').chips === INITIAL_CHIPS - 100);
    check('프리플랍에는 공용 카드가 없다', s.board.length === 0 && s.street === 'preflop' && s.you.handName === null);
    check('내 카드는 2장 보이고 남의 카드는 뒷면이다', t.me('A').cards.length === 2 && t.me('A').cards.every((c) => c.rank)
      && t.me('B', 'A').cards.length === 2 && t.me('B', 'A').cards.every((c) => c.hidden));
  }
  {
    const t = table(['A', 'B']);
    t.room.begin(t.id.A);
    const s = t.view();
    check('둘이서 할 때는 스몰 블라인드 자리가 프리플랍에서 먼저 말한다', s.smallBlindId === t.id.A && s.bigBlindId === t.id.B && t.turn() === 'A');
    t.room.call(t.id.A); // 스몰 블라인드가 50원을 더 내고 맞춘다
    check('빅 블라인드는 체크할 기회(옵션)를 받는다', t.view().phase === 'betting' && t.view().street === 'preflop' && t.turn() === 'B');
    t.room.call(t.id.B);
    check('프리플랍이 끝나면 플랍이 열린다(공용 3장)', t.view().street === 'flop' && t.view().board.length === 3 && t.view().pot === 200);
    check('둘이서 할 때 플랍부터는 빅 블라인드 자리가 먼저 말한다', t.turn() === 'B');
    checkAround(t);
    check('턴(공용 4장)', t.view().street === 'turn' && t.view().board.length === 4);
    checkAround(t);
    check('리버(공용 5장)', t.view().street === 'river' && t.view().board.length === 5);
    checkAround(t);
    check('리버 배팅이 끝나면 판이 끝나고 팟이 나눠진다', t.view().phase === 'result' && t.view().pot === 0 && t.total() === INITIAL_CHIPS * 2);
  }
  {
    // 둘이서 하다가 다음 판: 블라인드 자리가 상대에게 넘어간다.
    const t = table(['A', 'B']);
    t.room.begin(t.id.A);
    t.room.fold(t.id.A); // 스몰 블라인드 자리가 폴드
    t.ready();
    t.room.begin(t.id.A);
    check('다음 판에는 블라인드 자리가 한 칸 돈다', t.view().smallBlindId === t.id.B && t.view().bigBlindId === t.id.A);
    t.room.fold(t.id.B);
    t.ready();
    t.room.begin(t.id.A);
    check('한 바퀴 돌아 처음으로 돌아온다', t.view().smallBlindId === t.id.A && t.view().bigBlindId === t.id.B);
  }
  {
    // 버튼 자리 사람이 나가면 그 자리에 앉은 사람이 다음 버튼이 된다(건너뛰지 않는다).
    const t = table(['A', 'B', 'C', 'D']);
    t.room.begin(t.id.A); // 버튼 A
    t.room.fold(t.id.D); t.room.fold(t.id.A); t.room.fold(t.id.B); // C(빅)가 이긴다
    t.room.leave(t.id.A);
    t.seats = t.seats.filter((seat) => seat.playerId !== t.id.A);
    ['B', 'C', 'D'].forEach((name) => t.room.setReady(t.id[name], true));
    t.room.begin(t.id.B);
    check('버튼 자리 사람이 나가면 그 다음 사람(B)이 새 버튼이라 스몰 블라인드는 C, 빅 블라인드는 D다', t.view('B').smallBlindId === t.id.C && t.view('B').bigBlindId === t.id.D, `${t.nameOf(t.view('B').smallBlindId)}/${t.nameOf(t.view('B').bigBlindId)}`);
  }

  // ── 시작 조건과 차례 ────────────────────────────────────
  {
    const room = createHoldemRoom({ onChange() {}, actionTimeoutMs: 0 });
    const a = room.join({ nickname: 'A' });
    const b = room.join({ nickname: 'B' });
    check('혼자서는 시작할 수 없다', room.begin(a.playerId) === '준비한 참가자가 2명 이상이어야 합니다.');
    room.setReady(a.playerId, true);
    check('준비한 사람이 한 명이면 시작할 수 없다', room.begin(a.playerId) === '준비한 참가자가 2명 이상이어야 합니다.');
    room.setReady(b.playerId, true);
    check('시작하면 판이 진행 중이 된다', room.begin(a.playerId) === null && room.stateFor(a.playerId).phase === 'betting');
    check('진행 중에는 다시 시작할 수 없다', room.begin(a.playerId) === '이미 게임이 진행 중입니다.');
    check('진행 중에는 준비를 바꿀 수 없다', room.setReady(a.playerId, false) === '대기 중에만 준비 상태를 바꿀 수 있습니다.');
    const other = room.stateFor(a.playerId).turnPlayerId === a.playerId ? b.playerId : a.playerId;
    check('차례가 아닌 사람의 행동은 거절한다', room.call(other) === '지금은 본인 차례가 아닙니다.'
      && room.raise(other, 100) === '지금은 본인 차례가 아닙니다.' && room.allin(other) === '지금은 본인 차례가 아닙니다.' && room.fold(other) === '지금은 본인 차례가 아닙니다.');
    room.dispose();
  }
  {
    const room = createHoldemRoom({ onChange() {} });
    const seats = ['A', 'B', 'C', 'D', 'E', 'F'].map((nickname) => room.join({ nickname }));
    check('방은 최대 5명이다', seats.slice(0, 5).every((s) => !s.error) && seats[5].error === '방이 가득 찼습니다. (최대 5명)');
    room.dispose();
  }

  // ── 쇼다운과 카드 공개 ──────────────────────────────────
  {
    // A: 에이스 한 쌍 + 공용의 에이스·2 → 풀하우스(에이스 풀 2). B: 스페이드 5장 → 플러시.
    const t = table(['A', 'B'], { makeDeck: stacked('As Ah  Ks Qs  Ad 2s 7s 2c 9s') });
    t.room.begin(t.id.A);
    check('배팅 중에는 상대 카드가 안 보이고 내 카드만 보인다', t.me('B', 'A').cards.every((c) => c.hidden) && t.me('A', 'A').cards.every((c) => c.rank));
    t.room.call(t.id.A); t.room.call(t.id.B);
    const flop = t.view().board;
    check('공용 카드는 덱에서 순서대로 나온다(플랍 3장)', flop.map((c) => c.rank).join() === '1,2,7' && flop.map((c) => c.suit).join() === '♦,♠,♠');
    checkAround(t); checkAround(t); checkAround(t);
    const s = t.view();
    check('쇼다운에서 더 센 패가 이긴다(A 풀하우스 > B 플러시)', s.phase === 'result' && s.result.winners.length === 1 && s.result.winners[0].id === t.id.A && s.result.winners[0].handName === '풀하우스', JSON.stringify(s.result));
    check('이긴 사람이 팟 전부를 가져간다', t.me('A').chips === INITIAL_CHIPS + 100 && t.me('B').chips === INITIAL_CHIPS - 100 && s.pot === 0);
    check('공용 카드가 깔린 뒤에는 내 패 이름을 알려 준다(상대 것은 알려 주지 않는다)', t.view('A').you.handName === '풀하우스' && t.view('B').you.handName === '플러시');
    check('쇼다운까지 간 판은 겨룬 사람의 카드와 패 이름이 공개된다', s.result.revealed && s.result.hands.length === 2
      && t.me('B', 'A').cards.every((c) => c.rank) && t.me('B', 'A').handName === '플러시');
    check('결과에 공용 카드 5장과 가장 좋은 5장이 담긴다', s.result.board.length === 5 && s.result.hands.every((h) => h.best.length === 5));
  }
  {
    // 모두 폴드해서 끝난 판: 이긴 사람도 카드를 보이지 않는다.
    const t = table(['A', 'B', 'C']);
    t.room.begin(t.id.A);
    t.room.fold(t.id.A); t.room.fold(t.id.B);
    const s = t.view('B');
    check('상대가 모두 폴드하면 남은 사람이 팟을 가져간다', s.phase === 'result' && s.result.winners[0].id === t.id.C && s.result.amount === 150 && !s.result.revealed);
    check('폴드로 끝난 판은 이긴 사람의 카드를 공개하지 않는다', t.me('C', 'B').cards.every((c) => c.hidden) && t.me('C', 'C').cards.every((c) => c.rank));
    check('폴드한 사람의 카드는 남에게 보이지 않는다', t.me('A', 'B').cards === null && t.me('A', 'A').cards.every((c) => c.rank));
    check('폴드로 끝나면 이긴 사람이 블라인드를 합친 팟을 받는다', t.me('C').chips === INITIAL_CHIPS + 50 && t.total() === INITIAL_CHIPS * 3);
  }

  // ── 비김: 팟 나누기 ─────────────────────────────────────
  {
    // 공용 카드가 로열 플러시: 모두 비긴다. 4명: 버튼 A, 스몰 B(폴드), 빅 C, D. 팟 350 = 100×3 + 죽은 돈 50.
    const t = table(['A', 'B', 'C', 'D'], { makeDeck: stacked('2c 3d  4c 5d  6c 7d  8c 9d  As Ks Qs Js Ts') });
    t.room.begin(t.id.A);
    t.room.call(t.id.D); // UTG가 100 콜
    t.room.call(t.id.A); // 버튼 자리가 100 콜
    t.room.fold(t.id.B); // 스몰 블라인드는 50을 두고 폴드
    t.room.call(t.id.C); // 빅 블라인드 체크
    for (let i = 0; i < 3; i += 1) checkAround(t);
    const s = t.view();
    const got = Object.fromEntries(s.result.winners.map((w) => [t.nameOf(w.id), w.amount]));
    check('비기면 팟을 나눈다(로열 플러시가 공용 카드에 있다)', s.phase === 'result' && s.result.winners.length === 3 && s.result.amount === 350, JSON.stringify(got));
    check('나누어떨어지지 않는 50원은 버튼 다음 자리에 앉은 이긴 사람이 받는다', got.C === 150 && got.D === 100 && got.A === 100, JSON.stringify(got));
    check('나눈 뒤에도 칩 총합이 그대로다', t.total() === INITIAL_CHIPS * 4);
  }

  // ── 레이즈 ─────────────────────────────────────────────
  {
    const t = table(['A', 'B', 'C']);
    t.room.begin(t.id.A);
    check('레이즈는 100원 단위여야 한다', t.room.raise(t.id.A, 150) === '레이즈는 100원 단위로 입력해 주세요.');
    check('레이즈는 기본 배팅금 이상이어야 한다', t.room.raise(t.id.A, 0) === '레이즈는 100원 단위로 입력해 주세요.');
    check('레이즈하면 배팅액이 오른다(빅 블라인드 100 + 레이즈 300 = 400)', t.room.raise(t.id.A, 300) === null && t.view().currentBet === 400 && t.me('A').roundBet === 400);
    check('직전 레이즈 폭보다 작게는 올릴 수 없다', /직전 레이즈 금액인 300원 이상/.test(t.room.raise(t.id.B, 100) || ''));
    check('직전 폭 이상이면 다시 올릴 수 있다', t.room.raise(t.id.B, 300) === null && t.view().currentBet === 700);
    check('콜하려면 부족한 만큼만 낸다(빅 블라인드는 이미 100 냈으므로 600)', (() => { const before = t.me('C').chips; t.room.call(t.id.C); return before - t.me('C').chips === 600; })());
    check('레이즈로 올린 판은 모두 맞출 때까지 거리가 끝나지 않는다', t.view().street === 'preflop' && t.turn() === 'A');
    t.room.call(t.id.A);
    check('모두 맞추면 플랍으로 넘어가고 거리별 배팅액이 0으로 돌아온다', t.view().street === 'flop' && t.view().currentBet === 0 && t.view().players.every((p) => p.roundBet === 0) && t.view().pot === 2100);
  }
  {
    const t = table(['A', 'B']);
    t.room.begin(t.id.A);
    check('칩 전부를 레이즈로 낼 수는 없다(올인을 쓴다)', t.room.raise(t.id.A, INITIAL_CHIPS) === '레이즈 후 칩이 남아야 합니다. 전액은 올인을 사용하세요.');
  }

  // ── 올인 ───────────────────────────────────────────────
  {
    // 칩이 적은 B가 올인하면 상한이 B의 금액이 되고, 더 낸 A는 넘치는 몫을 돌려받는다. 더 배팅하지 않고 공용 카드를 깐다.
    // A: 에이스 한 쌍, B: 7-2 (공용 카드가 도와주지 않으면 진다)
    const t = table(['A', 'B', 'C'], { chips: { B: 800 }, makeDeck: stacked('As Ah  7d 2c  Kc Qd  9s 8h 3d 4c 5s') });
    t.room.begin(t.id.A); // 버튼 A, 스몰 B, 빅 C
    t.room.raise(t.id.A, 900); // A가 1,000까지 올린다
    check('올리고 나면 배팅액이 1,000이다', t.view().currentBet === 1000);
    check('칩이 모자란 사람은 콜할 수 없다(올인을 쓴다)', t.room.call(t.id.B) === '콜할 칩이 부족합니다. 올인을 선택하세요.');
    check('올인한다', t.room.allin(t.id.B) === null);
    const s = t.view();
    check('B는 가진 칩 전부(블라인드 50 포함 800)를 걸었고 A는 넘치는 200을 돌려받았다', t.me('B').chips === 0 && t.me('B').isAllIn && s.allInCap === 800 && t.me('A').roundBet === 800, JSON.stringify(s.players.map((p) => [p.chips, p.roundBet])));
    check('올인 뒤에는 레이즈할 수 없다', t.room.raise(t.id.C, 100) === '올인 이후에는 레이즈할 수 없습니다.');
    t.room.call(t.id.C); // C는 900을 더 내고 맞춘다
    const end = t.view();
    check('모두 맞추면 더 배팅하지 않고 공용 카드를 한꺼번에 깔아 겨룬다', end.phase === 'result' && end.board.length === 5 && end.result.revealed);
    check('칩 총합은 올인과 쇼다운을 거쳐도 그대로다', t.total() === INITIAL_CHIPS * 2 + 800);
  }
  {
    // 올인이라고 말하지 않아도 가진 칩을 전부 내고 콜했다면 올인이다: 상한이 정해지고 더 배팅하지 않는다.
    const t = table(['A', 'B', 'C'], { chips: { B: 1000 } });
    t.room.begin(t.id.A);
    t.room.raise(t.id.A, 900);
    check('가진 칩이 딱 맞는 콜은 허용된다', t.room.call(t.id.B) === null && t.me('B').chips === 0 && t.me('B').isAllIn);
    check('그 콜이 이 판의 상한이 되어 아직 말하지 않은 사람은 올릴 수 없다', t.view().allInCap === 1000 && t.room.raise(t.id.C, 100) === '올인 이후에는 레이즈할 수 없습니다.');
    t.room.call(t.id.C);
    check('모두 맞추면 칩이 0인 사람에게 차례가 가지 않고 곧바로 겨룬다', t.view().phase === 'result' && t.view().board.length === 5 && t.total() === INITIAL_CHIPS * 2 + 1000);
  }
  {
    // 칩이 많은 사람이 올인하면 상대가 받을 수 있는 만큼만 걸린다.
    const t = table(['A', 'B'], { chips: { B: 1000 } });
    t.room.begin(t.id.A);
    t.room.allin(t.id.A); // A는 1,000,000이 있지만 B는 1,000(블라인드 100 포함)밖에 못 맞춘다
    const s = t.view();
    check('칩이 많은 쪽의 올인은 상대가 받을 수 있는 최대까지만 걸린다', s.allInCap === 1000 && t.me('A').roundBet === 1000 && t.me('A').chips === INITIAL_CHIPS - 1000 && !t.me('A').isAllIn, JSON.stringify(s.players.map((p) => [p.chips, p.roundBet, p.isAllIn])));
    t.room.call(t.id.B); // B는 900을 더 내면 가진 것을 전부 거는 콜이다
    check('가진 칩 전부로 콜하면 올인이 되고 바로 겨룬다', t.view().phase === 'result' && t.total() === INITIAL_CHIPS + 1000);
  }
  {
    // 올인 상한이 정해진 뒤 더 많은 칩으로 맞추려는 사람은 환불을 받는다.
    const t = table(['A', 'B', 'C'], { chips: { B: 500 } });
    t.room.begin(t.id.A);
    t.room.raise(t.id.A, 2000); // A: 2,100
    t.room.allin(t.id.B); // B는 스몰 블라인드 50을 낸 상태에서 500 전부
    check('올인한 금액이 상한이 되어 앞서 더 낸 A는 차액을 돌려받는다', t.view().allInCap === 500 && t.me('A').roundBet === 500 && t.me('A').chips === INITIAL_CHIPS - 500, JSON.stringify(t.view().players.map((p) => [p.chips, p.roundBet])));
    check('칩 총합은 그대로다', t.total() === INITIAL_CHIPS * 2 + 500);
    t.room.call(t.id.C);
    check('남은 사람이 맞추면 바로 쇼다운이다', t.view().phase === 'result' && t.total() === INITIAL_CHIPS * 2 + 500);
  }
  {
    // 블라인드조차 못 내는 짧은 스택: 가진 만큼 내고 올인한다.
    const t = table(['A', 'B', 'C'], { chips: { C: 60 } });
    t.room.begin(t.id.A);
    check('칩이 빅 블라인드보다 적으면 가진 만큼만 내고 올인한다', t.me('C').chips === 0 && t.me('C').isAllIn && t.me('C').roundBet === 60);
    check('이때 상한이 60으로 정해져 스몰 블라인드를 낸 사람은 차액을 돌려받는다', t.view().allInCap === 60 && t.me('B').roundBet === 50);
    check('다른 사람은 60만 맞추면 된다', t.view().currentBet === 60 && t.turn() === 'A');
    t.room.call(t.id.A);
    check('첫 사람이 맞추면 스몰 블라인드가 마저 10을 내야 한다', t.turn() === 'B' && t.view().phase === 'betting');
    t.room.call(t.id.B);
    check('모두 맞췄으니 더 배팅하지 않고 겨룬다', t.view().phase === 'result' && t.view().board.length === 5);
    check('칩 총합은 그대로다', t.total() === INITIAL_CHIPS * 2 + 60);
  }
  {
    // 스몰 블라인드가 올인이고 빅 블라인드는 칩이 남은 경우, 빅 블라인드는 할 일이 없으니 곧바로 겨룬다.
    const t = table(['A', 'B'], { chips: { A: 30 } });
    t.room.begin(t.id.A);
    check('둘 중 한 명이 블라인드로 올인하면 아무도 더 할 게 없어 바로 겨룬다', t.view().phase === 'result' && t.view().board.length === 5 && t.total() === INITIAL_CHIPS + 30, t.view().phase);
  }

  // ── 제한시간 ───────────────────────────────────────────
  {
    // 공짜로 넘어갈 수 있으면 체크, 아니면 폴드.
    const t = table(['A', 'B'], { actionTimeoutMs: 40 });
    t.room.begin(t.id.A);
    check('제한시간이 흐르는 동안 남은 시간이 상태에 실린다', t.view().turnTotalMs === 40 && t.view().turnRemainingMs > 0 && t.view().turnRemainingMs <= 40);
    await wait(120);
    // A(스몰 블라인드)는 50을 더 내야 하므로 시간이 지나면 폴드다.
    check('낼 돈이 있는데 시간이 지나면 폴드된다', t.view().phase === 'result' && t.view().result.winners[0].id === t.id.B);
    t.room.dispose();
  }
  {
    const t = table(['A', 'B'], { actionTimeoutMs: 80 });
    t.room.begin(t.id.A);
    t.room.call(t.id.A); // 스몰 블라인드 콜 → 빅 블라인드(B) 차례, 체크하면 공짜
    await wait(200);
    const s = t.view();
    check('낼 돈이 없으면 시간이 지나도 폴드가 아니라 체크다', s.phase === 'betting' && s.street !== 'preflop' && t.me('B').chips === INITIAL_CHIPS - 100, `${s.phase} ${s.street}`);
    t.room.dispose();
  }
  {
    const t = table(['A', 'B'], { actionTimeoutMs: 200 });
    t.room.begin(t.id.A);
    t.room.setCovered(t.id.A, true);
    const frozen = t.view().turnRemainingMs;
    await wait(80);
    check('차례인 사람이 화면을 가리면 제한시간이 멈춘다', t.view().paused === true && Math.abs(t.view().turnRemainingMs - frozen) < 15, `${frozen} → ${t.view().turnRemainingMs}`);
    await wait(250);
    check('가린 동안에는 시간이 지나도 폴드되지 않는다', t.view().phase === 'betting');
    t.room.setCovered(t.id.A, false);
    check('돌아오면 다시 흐른다', t.view().paused === false);
    t.room.dispose();
  }

  // ── 접속 끊김·나가기 ────────────────────────────────────
  {
    const t = table(['A', 'B', 'C'], { disconnectGraceMs: 60 });
    t.room.begin(t.id.A);
    t.room.disconnect(t.id.A); // 차례인 A가 끊김
    check('끊겨도 곧바로 폴드하지 않는다', t.view('B').players.find((p) => p.id === t.id.A) && !t.view('B').players.find((p) => p.id === t.id.A).isFolded);
    const back = t.room.join({ nickname: 'A', token: t.seats[0].token });
    check('유예 안에 돌아오면 같은 자리에서 이어서 한다', back.restored && back.playerId === t.id.A && t.turn() === 'A');
    t.room.disconnect(t.id.A);
    await wait(150);
    check('유예가 지나도 안 돌아오면 폴드되고 판이 이어진다', t.view('B').phase === 'betting' && t.turn() === 'B' && !t.view('B').players.some((p) => p.id === t.id.A));
    const returned = t.room.join({ nickname: 'A', token: t.seats[0].token });
    check('나중에 돌아오면 가진 칩을 되찾는다(낸 블라인드는 없다)', !returned.error && t.room.stateFor(returned.playerId).you.chips === INITIAL_CHIPS && t.room.stateFor(returned.playerId).you.inRound === false);
    t.room.dispose();
  }
  {
    const t = table(['A', 'B', 'C']);
    t.room.begin(t.id.A);
    t.room.leave(t.id.A);
    check('차례인 사람이 나가면 다음 사람에게 차례가 간다', t.view('B').phase === 'betting' && t.turn() === 'B' && t.view('B').players.length === 2);
    t.room.leave(t.id.B);
    check('남은 사람이 한 명이면 그 사람이 팟을 가져간다', t.view('C').phase === 'result' && t.view('C').result.winners[0].id === t.id.C);
    check('나간 사람이 낸 돈도 팟에 남아 이긴 사람이 받는다', t.me('C', 'C').chips === INITIAL_CHIPS + 50, String(t.me('C', 'C').chips));
    t.room.dispose();
  }
  {
    // 나갔다 돌아오면 칩이 되살아나지 않는다.
    const t = table(['A', 'B']);
    t.room.begin(t.id.A);
    t.room.fold(t.id.A);
    t.room.leave(t.id.A);
    const back = t.room.join({ nickname: 'A', token: t.seats[0].token });
    check('나갔다 돌아와도 칩이 되살아나지 않는다', t.room.stateFor(back.playerId).you.chips === INITIAL_CHIPS - 50);
    t.room.dispose();
  }
  {
    // 진행 중에 들어온 사람은 다음 판부터.
    const t = table(['A', 'B']);
    t.room.begin(t.id.A);
    const late = t.room.join({ nickname: 'C' });
    const s = t.room.stateFor(late.playerId);
    check('판 도중에 들어온 사람은 이번 판에 끼지 않고 다음 판부터 한다', s.you.inRound === false && s.phase === 'betting' && s.players.find((p) => p.id === late.playerId).isFolded);
    check('판 도중에 들어온 사람은 남의 카드를 볼 수 없다', s.players.every((p) => p.id === late.playerId || (p.cards || []).every((c) => c.hidden)));
    t.room.dispose();
  }

  // ── 블라인드 투표 ───────────────────────────────────────
  {
    const t = table(['A', 'B', 'C']);
    t.room.setReady(t.id.A, false);
    check('기본 배팅금은 100원 단위로만 정할 수 있다', t.room.setBaseBet(t.id.A, 150) === '빅 블라인드는 100원 단위로 설정해 주세요.');
    check('제안하면 투표가 열린다', t.room.setBaseBet(t.id.A, 400) === null && t.view('B').baseBetProposal.amount === 400);
    check('과반수 찬성이면 바뀐다', (() => { const p = t.view('B').baseBetProposal; t.room.voteBaseBet(t.id.B, p.id, true); return t.view('C').baseBet === 400 && t.view('C').smallBlind === 200 && t.view('C').baseBetProposal === null; })());
    t.ready();
    t.room.begin(t.id.A);
    check('바뀐 블라인드로 판이 시작된다(200 / 400)', t.me('B').roundBet === 200 && t.me('C').roundBet === 400 && t.view().pot === 600 && t.view().minRaise === 400);
    check('판 도중에는 블라인드를 바꿀 수 없다', t.room.setBaseBet(t.id.A, 100) === '게임 중에는 변경할 수 없습니다.');
    t.room.dispose();
  }

  {
    // 같은 이름은 번호를 붙여 구분한다.
    const t = table(['같은이름', '같은이름', '세번째']);
    check('겹치는 닉네임에는 번호가 붙는다', t.view('세번째').players.map((p) => p.nickname).join() === '같은이름,같은이름(2),세번째');
    t.room.dispose();
  }
  {
    // 투표는 시간이 지나면 취소된다.
    const t = table(['A', 'B', 'C'], { proposalTimeoutMs: 40 });
    t.room.setBaseBet(t.id.A, 500);
    check('블라인드 투표가 열려 있는 동안은 시작할 수 없다', t.room.begin(t.id.B) === '블라인드 투표가 끝난 뒤 시작해 주세요.');
    await wait(120);
    check('투표 시간이 지나면 취소되고 블라인드는 그대로다', t.view().baseBetProposal === null && t.view().baseBet === 100 && t.room.begin(t.id.B) === null);
    t.room.dispose();
  }
  {
    // 투표 도중 인원이 바뀌면 취소, 반대가 과반이면 부결.
    const t = table(['A', 'B', 'C']);
    t.room.setBaseBet(t.id.A, 300);
    t.room.disconnect(t.id.C);
    check('투표 도중 누가 끊기면 투표가 취소된다', t.view('A').baseBetProposal === null);
    t.room.dispose();
    const four = table(['A', 'B', 'C', 'D']);
    four.room.setBaseBet(four.id.A, 300);
    const proposal = four.view('B').baseBetProposal;
    four.room.voteBaseBet(four.id.B, proposal.id, false);
    check('같은 사람이 두 번 투표할 수 없다', four.room.voteBaseBet(four.id.B, proposal.id, true) === '이미 투표했습니다.');
    check('제안한 사람은 투표 대상이 아니다', four.room.voteBaseBet(four.id.A, proposal.id, true) === '제안자는 투표 대상이 아닙니다.');
    four.room.voteBaseBet(four.id.C, proposal.id, false);
    check('반대가 과반이면 부결되어 블라인드는 그대로다', four.view('A').baseBetProposal === null && four.view('A').baseBet === 100);
    four.room.dispose();
  }
  {
    // 아무도 없으면 새 방이다: 잃은 칩도 처음으로 돌아간다. 칩이 없는 사람은 준비해도 판에 끼지 못한다.
    const t = table(['A', 'B']);
    t.room.begin(t.id.A);
    t.room.fold(t.id.A);
    check('폴드로 칩이 줄었다', t.me('A').chips === INITIAL_CHIPS - 50);
    t.room.disconnect(t.id.A);
    t.room.disconnect(t.id.B);
    const fresh = t.room.join({ nickname: 'A' });
    check('모두 나간 방은 새 방이라 칩이 처음으로 돌아간다', t.room.stateFor(fresh.playerId).you.chips === INITIAL_CHIPS && t.room.stateFor(fresh.playerId).players.length === 1);
    t.room.dispose();
    const poor = table(['A', 'B', 'C'], { chips: { C: 0 } });
    check('칩이 없는 사람이 준비해도 시작 인원에 세지 않는다', poor.view().readyCount === 2 && poor.room.begin(poor.id.A) === null && !poor.view().players.find((p) => p.id === poor.id.C).inRound);
    poor.room.dispose();
  }

  // ── 기부 ───────────────────────────────────────────────
  {
    const t = table(['A', 'B'], { chips: { B: 50 } });
    check('칩이 부족한 사람에게 기부할 수 있다', t.room.donate(t.id.A, t.id.B, 200) === null && t.me('B').chips === 250);
    check('칩이 충분한 사람에게는 기부할 수 없다', t.room.donate(t.id.B, t.id.A, 100) === '현재 칩이 부족한 참가자에게만 기부할 수 있습니다.');
    t.room.begin(t.id.A);
    check('판 도중에는 기부할 수 없다', t.room.donate(t.id.A, t.id.B, 100) === '기부는 대기 중에만 할 수 있습니다.');
    t.room.dispose();
  }

  // ── 무작위로 수백 판: 칩이 새거나 늘지 않고 판이 반드시 끝난다 ──────────
  {
    let seed = 12345;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const pick = (list) => list[Math.floor(random() * list.length)];
    let hands = 0;
    const problems = [];
    for (let game = 0; game < 60 && problems.length === 0; game += 1) {
      const count = 2 + Math.floor(random() * 4);
      const names = ['A', 'B', 'C', 'D', 'E'].slice(0, count);
      const stacks = {};
      names.forEach((name) => { stacks[name] = pick([200, 600, 1500, 5000, INITIAL_CHIPS]); });
      const t = table(names, { chips: stacks });
      const start = t.total();
      for (let round = 0; round < 6 && problems.length === 0; round += 1) {
        const playable = names.filter((name) => t.me(name).chips > 0);
        if (playable.length < 2) break;
        t.ready();
        if (t.room.begin(t.id[playable[0]]) !== null) break;
        hands += 1;
        let guard = 0;
        while (t.view().phase === 'betting' && guard++ < 200) {
          const state = t.view();
          const who = state.turnPlayerId;
          const roll = random();
          const me = state.players.find((p) => p.id === who);
          let reason = null;
          if (roll < 0.45) reason = t.room.call(who);
          else if (roll < 0.65) reason = t.room.raise(who, pick([100, 100, 200, 500, 1000, 4000]));
          else if (roll < 0.8) reason = t.room.allin(who);
          else reason = t.room.fold(who);
          // 거절(칩이 모자란 콜·너무 작은 레이즈 등)이면 폴드나 올인으로 대신한다.
          if (reason && me) reason = me.chips > 0 && random() < 0.5 ? t.room.allin(who) : t.room.fold(who);
          if (t.total() !== start) problems.push(`게임 ${game} 판 ${round}: 칩 총합이 ${start} → ${t.total()}`);
          if (t.view().players.some((p) => p.chips < 0 || p.roundBet < 0)) problems.push(`게임 ${game}: 칩이 음수`);
        }
        const s = t.view();
        if (s.phase !== 'result') problems.push(`게임 ${game} 판 ${round}: 판이 끝나지 않음 (${s.phase}, ${s.street}, 차례 ${s.turnPlayerId})`);
        else {
          if (s.pot !== 0) problems.push(`게임 ${game}: 끝났는데 팟이 ${s.pot}`);
          const won = s.result.winners.reduce((sum, w) => sum + w.amount, 0);
          if (won !== s.result.amount) problems.push(`게임 ${game}: 나눈 몫 ${won} ≠ 팟 ${s.result.amount}`);
          if (s.result.revealed && s.board.length !== 5) problems.push(`게임 ${game}: 쇼다운인데 공용 카드가 ${s.board.length}장`);
          if (s.players.some((p) => p.chips % 50 !== 0)) problems.push(`게임 ${game}: 50원 단위가 깨짐 ${s.players.map((p) => p.chips)}`);
        }
      }
      t.room.dispose();
    }
    check(`무작위 ${hands}판: 칩이 새거나 늘지 않고, 판이 반드시 끝나고, 몫이 팟과 맞는다`, problems.length === 0 && hands > 100, problems.slice(0, 3).join(' / ') || `판 ${hands}개`);
  }

  console.log(`\n홀덤 방: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})();
