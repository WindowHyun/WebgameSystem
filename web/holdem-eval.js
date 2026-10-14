'use strict';

/**
 * 텍사스 홀덤 패 평가.
 *
 * 카드는 이 사이트의 다른 카드 게임과 같은 모양이다: { rank: 1~13, suit: '♠'|'♥'|'♦'|'♣' }.
 * 에이스는 1로 들어오지만 홀덤에서는 가장 높은 카드(14)이면서, A-2-3-4-5 스트레이트에서는 가장 낮은 카드(1)다.
 *
 * 7장(내 카드 2장 + 공용 카드 5장) 중 가장 좋은 5장을 고른다. 21가지 조합을 모두 평가하는 쪽을 골랐다 -
 * 판 하나에 최대 6명이라 126번이고, "어떤 조합이 이기는가"를 규칙 그대로 읽을 수 있어서
 * 스트레이트·플러시를 따로 찾아내는 영리한 방식보다 틀릴 곳이 적다.
 */

const CATEGORY_NAMES = ['하이 카드', '원 페어', '투 페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시'];
const ROYAL_NAME = '로열 플러시';

const high = (rank) => (rank === 1 ? 14 : rank);

/** 정확히 5장. { category: 0~8, ranks: [비교용 숫자들 - 앞에 올수록 중요] } */
function evaluateFive(cards) {
  const values = cards.map((card) => high(card.rank)).sort((a, b) => b - a);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const distinct = [...new Set(values)];
  let straightHigh = 0;
  if (distinct.length === 5) {
    if (values[0] - values[4] === 4) straightHigh = values[0];
    else if (values[0] === 14 && values[1] === 5 && values[4] === 2) straightHigh = 5; // A-2-3-4-5: 에이스가 가장 낮다
  }
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  // 많이 나온 숫자가 먼저, 같으면 높은 숫자가 먼저: 풀하우스는 [트리플, 페어], 투 페어는 [높은 페어, 낮은 페어, 키커].
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(([, count]) => count).join('');
  const byGroup = groups.map(([value]) => value);

  if (straightHigh && flush) return { category: 8, ranks: [straightHigh] };
  if (shape === '41') return { category: 7, ranks: byGroup };
  if (shape === '32') return { category: 6, ranks: byGroup };
  if (flush) return { category: 5, ranks: values };
  if (straightHigh) return { category: 4, ranks: [straightHigh] };
  if (shape === '311') return { category: 3, ranks: byGroup };
  if (shape === '221') return { category: 2, ranks: byGroup };
  if (shape === '2111') return { category: 1, ranks: byGroup };
  return { category: 0, ranks: values };
}

/** 두 평가를 비교한다. 앞이 세면 양수, 뒤가 세면 음수, 같으면 0. */
function compareEvaluations(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.ranks.length, b.ranks.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.ranks[i] || 0) - (b.ranks[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function nameOf(evaluation) {
  return evaluation.category === 8 && evaluation.ranks[0] === 14 ? ROYAL_NAME : CATEGORY_NAMES[evaluation.category];
}

/** 5~7장 중 가장 좋은 5장. { category, ranks, name, best: [카드 5장] } */
function bestHand(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) throw new Error('패는 5~7장이어야 합니다.');
  let best = null;
  const pick = [];
  (function walk(start) {
    if (pick.length === 5) {
      const chosen = pick.map((i) => cards[i]);
      const evaluation = evaluateFive(chosen);
      if (!best || compareEvaluations(evaluation, best) > 0) best = { ...evaluation, best: chosen };
      return;
    }
    for (let i = start; i < cards.length; i += 1) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  }(0));
  return { ...best, name: nameOf(best) };
}

module.exports = { bestHand, compareEvaluations, evaluateFive, CATEGORY_NAMES };
