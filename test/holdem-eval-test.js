'use strict';

/**
 * 텍사스 홀덤 패 평가(web/holdem-eval.js).
 *
 *   - 아홉 가지 족보를 알아보고 이름을 맞게 붙인다(로열 플러시 포함).
 *   - 같은 족보끼리는 숫자·키커 순서로 가린다.
 *   - 에이스는 높기도 낮기도 하지만, 돌아서 이어지는 것(Q-K-A-2-3)은 스트레이트가 아니다.
 *   - 7장 중에서 가장 좋은 5장을 고른다. 공용 카드만으로 만든 패와 비기는 것도 가린다.
 *
 * 실행: node test/holdem-eval-test.js
 */

const { bestHand, compareEvaluations } = require('../web/holdem-eval');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

const SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANKS = { A: 1, T: 10, J: 11, Q: 12, K: 13 };
/** 'As Kd 7h' → 카드 배열. 숫자는 그대로(2~9), T=10, J·Q·K·A. */
function hand(text) {
  return text.trim().split(/\s+/).map((token) => {
    const label = token.slice(0, -1);
    return { rank: RANKS[label] || Number(label), suit: SUITS[token.slice(-1)] };
  });
}
const rate = (text) => bestHand(hand(text));
const beats = (a, b) => compareEvaluations(rate(a), rate(b)) > 0;
const ties = (a, b) => compareEvaluations(rate(a), rate(b)) === 0;

// ── 족보 이름 ──────────────────────────────────────────────
const NAMES = [
  ['로열 플러시', 'As Ks Qs Js Ts 2d 3c'],
  ['스트레이트 플러시', '9h 8h 7h 6h 5h Ad 2c'],
  ['포카드', '7s 7h 7d 7c Ks 2d 3c'],
  ['풀하우스', '9s 9h 9d 4c 4s 2d Kc'],
  ['플러시', 'As 9s 7s 4s 2s Kd Qc'],
  ['스트레이트', '9s 8h 7d 6c 5s Kd 2c'],
  ['트리플', 'Qs Qh Qd 8c 5s 2d 3c'],
  ['투 페어', 'Js Jh 4d 4c As 2d 8c'],
  ['원 페어', 'Ts Th 8d 6c 4s 2d Ac'],
  ['하이 카드', 'As Kh 9d 7c 5s 3d 2c'],
];
for (const [name, cards] of NAMES) check(`족보: ${name}`, rate(cards).name === name, `${rate(cards).name}`);

// ── 에이스 ────────────────────────────────────────────────
check('A-2-3-4-5는 스트레이트이고 에이스가 가장 낮다', rate('As 2h 3d 4c 5s 9d Kc').name === '스트레이트' && rate('As 2h 3d 4c 5s 9d Kc').ranks[0] === 5);
check('A-2-3-4-5(휠)는 2-3-4-5-6에 진다', beats('2s 3h 4d 5c 6s 9d Kc', 'As 2h 3d 4c 5s 9d Kc'));
check('10-J-Q-K-A는 에이스가 높은 스트레이트다', rate('Ts Jh Qd Kc As 2d 3c').ranks[0] === 14);
check('Q-K-A-2-3처럼 에이스를 돌아 이어지는 것은 스트레이트가 아니다', rate('Qs Kh Ad 2c 3s 7d 9c').name !== '스트레이트');
check('A-2-3-4-5 같은 무늬는 스트레이트 플러시이지 로열이 아니다', rate('As 2s 3s 4s 5s 9d Kc').name === '스트레이트 플러시');
check('에이스 원 페어는 킹 원 페어를 이긴다', beats('As Ah 7d 5c 3s 2d 9c', 'Ks Kh 7d 5c 3s 2d 9c'));

// ── 같은 족보끼리의 순서 ───────────────────────────────────
check('높은 족보가 낮은 족보를 이긴다(플러시 > 스트레이트)', beats('As 9s 7s 4s 2s Kd Qc', '9s 8h 7d 6c 5s Kd 2c'));
check('풀하우스는 트리플 숫자부터 비교한다(777-22 > 666-AA)', beats('7s 7h 7d 2c 2s 9d Kc', '6s 6h 6d As Ah 9d Kc'));
check('같은 트리플이면 페어 숫자로 가린다', beats('7s 7h 7d Kc Ks 2d 3c', '7c 7h 7d Qc Qs 2d 3c'));
check('투 페어는 높은 페어, 낮은 페어, 키커 순으로 가린다', beats('Ks Kh 5d 5c 2s 9d 3c', 'Qs Qh Jd Jc 2s 9d 3c')
  && beats('Ks Kh 6d 6c 2s 9d 3c', 'Ks Kh 5d 5c As 9d 3c')
  && beats('Ks Kh 5d 5c Ac 9d 3c', 'Kd Kc 5h 5s Qs 9d 3c'));
check('원 페어는 키커를 하나씩 비교한다', beats('8s 8h Ad 5c 3s 2d 9c', '8d 8c Kd 5h 3c 2h 9h'));
check('포카드는 숫자, 같으면 키커로 가린다', beats('9s 9h 9d 9c 2s 3d 4c', '8s 8h 8d 8c As Kd Qc') && beats('9s 9h 9d 9c Ks 3d 4c', '9s 9h 9d 9c Qs 3d 4c'));
check('플러시는 높은 카드부터 하나씩 비교한다', beats('As Ks 9s 5s 2s 3d 4c', 'Ah Qh Jh 9h 8h 3d 4c'));
check('하이 카드도 다섯 장을 모두 본다', beats('As Kh 9d 7c 5s 3d 2c', 'Ad Kc 9h 7s 4d 3h 2s'));

// ── 7장 중 가장 좋은 5장 ───────────────────────────────────
check('7장 중 가장 좋은 5장을 고른다(플러시와 스트레이트가 같이 있으면 플러시)', rate('As 9s 7s 4s 2s 8h 6d').name === '플러시');
check('가장 좋은 5장이 best로 돌아온다', rate('As Ks Qs Js Ts 2d 3c').best.length === 5
  && rate('As Ks Qs Js Ts 2d 3c').best.every((card) => card.suit === '♠'));
check('풀하우스가 둘이면 트리플을 우선 쓴다(777-22-AAA → AAA-77)', (() => {
  const result = rate('As Ah Ad 7s 7h 7d 2c');
  return result.name === '풀하우스' && result.ranks[0] === 14 && result.ranks[1] === 7;
})());
check('트리플이 둘이어도 풀하우스 하나만 만든다(페어가 둘이면 높은 쪽)', (() => {
  const result = rate('Ks Kh Kd 5s 5h 4d 4c');
  return result.name === '풀하우스' && result.ranks[0] === 13 && result.ranks[1] === 5;
})());
check('페어가 셋이어도 투 페어이고 키커는 남은 가장 높은 카드다', (() => {
  const result = rate('Ks Kh 7d 7c 4s 4d As');
  return result.name === '투 페어' && result.ranks.join() === '13,7,14';
})());

// ── 공용 카드만으로 만든 패는 모두에게 같다 ─────────────────
check('공용 카드가 더 좋으면 비긴다', ties('2s 3h As Ah Ad Kc Kd', '4s 5h As Ah Ad Kc Kd'));
check('키커까지 같으면 비긴다', ties('2s 3h Ks Kh 9d 7c 5s', '4d 2h Ks Kh 9d 7c 5s'));
check('무늬만 다르면 비긴다', ties('As Kh Qd Jc 9s 3d 2c', 'Ad Kc Qh Js 9d 3h 2s'));

// ── 잘못된 입력 ───────────────────────────────────────────
for (const [name, cards] of [['4장', 'As Kh Qd Jc'], ['8장', 'As Kh Qd Jc 9s 3d 2c 4h']]) {
  let message = '';
  try { rate(cards); } catch (error) { message = error.message; }
  check(`${name}은 거절한다`, message.length > 0);
}

console.log(`\n홀덤 패 평가: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
