/**
 * 더 마인드 화면. 규칙과 판정은 전부 서버(web/mind-room.js)가 한다 - 이 화면은 받은 상태를
 * 그리고 버튼을 서버에 전할 뿐이다. 연결 유지·재접속은 public/game-socket.js가 한다(다른 카드 게임과 같다).
 */
(function () {
  'use strict';

  var NAME_KEY = 'game-portal-nickname';
  var TOKEN_KEY = 'mind-game-token';
  var nickname = sessionStorage.getItem(NAME_KEY);
  if (!nickname) { location.href = '/'; return; }

  var state = null;

  function $(id) { return document.getElementById(id); }

  var socket = null;
  function send(type, extra) { if (socket) socket.send(type, extra); }
  /**
   * "카드 내기"를 두 번 누르면 카드 두 장이 연달아 나간다(두 번째는 대개 실수가 된다).
   * 누르면 다음 상태가 올 때까지 버튼을 잠근다. 응답이 오지 않아도 잠시 뒤 풀어 준다.
   */
  var pendingPlay = false;
  var pendingTimer = null;
  // [이슈] 잠금은 "내 카드가 실제로 줄었을 때"(또는 레벨·단계가 바뀌었을 때)만 푼다. 예전에는
  // 아무 상태나 오면 풀어서, 두 번 누르는 사이에 다른 사람 때문에 온 상태가 끼면 두 번째
  // 누름이 그대로 나가 카드 두 장이 연달아 나갔다.
  var pendingHand = 0;
  var pendingLevel = 0;
  function settlePending(next) {
    if (!pendingPlay || !next.you) return;
    if (next.you.hand.length < pendingHand || next.level !== pendingLevel || next.phase !== 'playing') pendingPlay = false;
  }

  function escapeHtml(value) { var el = document.createElement('div'); el.textContent = value; return el.innerHTML; }
  var errorTimer = null;
  function showError(text) {
    $('error').textContent = text;
    $('error').style.display = 'block';
    clearTimeout(errorTimer); // 앞의 토스트가 뒤에 온 것까지 같이 지우지 않게 한다
    errorTimer = setTimeout(function () { $('error').style.display = 'none'; }, 3000);
  }

  /**
   * 내용이 바뀔 때만 다시 그린다. 카드에는 등장 애니메이션(poker.css의 .card)이 있어서, 예전처럼
   * 상태가 올 때마다 innerHTML을 새로 넣으면 남이 무엇을 누를 때마다 내 카드가 0.2초씩
   * 사라졌다 나타났다(화면이 굼뜨게 느껴지는 원인이었다).
   */
  var drawn = {};
  function setHtml(id, html) {
    if (drawn[id] === html) return;
    drawn[id] = html;
    $(id).innerHTML = html;
  }

  /**
   * 누르는 즉시 눌림 표시를 한다. 서버까지 다녀오는 동안(Render까지 왕복 수백 ms) 버튼에 아무
   * 변화가 없어서 눌렸는지 알 수 없었다. 다음 상태나 오류가 오면 풀고, 답이 없어도 잠시 뒤 푼다.
   * 그동안 버튼을 잠가 두 번 눌러 켰다 꺼지는 일도 막는다.
   */
  var sending = [];
  var sendingTimer = null;
  function markSending(button) {
    button.classList.add('sending');
    button.disabled = true;
    sending.push(button);
    clearTimeout(sendingTimer);
    sendingTimer = setTimeout(function () { releaseSending(); if (state) render(); }, 1500);
  }
  function releaseSending() {
    clearTimeout(sendingTimer);
    sending.forEach(function (button) { button.classList.remove('sending'); button.disabled = false; });
    sending = [];
  }

  // ─────────────────────────── 실수 연출 ───────────────────────────
  // [요청] 잘못 낸 순간에 임팩트를 준다. 낸 카드에 ✕ 도장이 찍히고 판이 붉게 번쩍이며 목숨 하트가 깨진다.
  // 더 작은 카드를 쥐고 있던 사람 화면에서는 그 카드가 자기 손패에서 바로 찢어지고,
  // 다른 사람 화면에서는 그 사람 칸에서 튀어나와 뒤집힌 뒤 가운데 더미 옆에서 찢어진다.
  // 모양은 CSS 클래스(mind.css)로 정하고 스크립트는 위치만 정한다 - 사이트 CSP(style-src 'self')를 지킨다.
  // 서버가 사건마다 번호(seq)를 붙인다. 새로 생긴 사건만 연출하고, 접속·재접속 때 받은 지난 사건은 넘긴다.
  var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var seenEventSeq = null;
  var fxLayer = null;
  var LAND_MS = 380;    // 낸 카드가 가운데로 날아오는 시간
  var IMPACT_MS = 420;  // 도장이 찍히고 나서 카드가 찢어지기 시작할 때까지

  function calm() { return !!(motionQuery && motionQuery.matches); }
  function canAnimate() { return typeof document.body.animate === 'function' && !document.hidden; }
  function fx() {
    if (!fxLayer) {
      fxLayer = document.createElement('div');
      fxLayer.className = 'mind-fx';
      fxLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(fxLayer);
    }
    return fxLayer;
  }
  function rectOf(el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function place(el, r) { el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px'; }
  function motion(el, frames, ms, options) {
    var opts = { duration: ms, easing: 'ease', fill: 'forwards' };
    Object.keys(options || {}).forEach(function (key) { opts[key] = options[key]; });
    return el.animate(frames, opts);
  }
  function later(ms, fn) { setTimeout(fn, ms); }
  function drop(el) { return function () { if (el.parentNode) el.parentNode.removeChild(el); }; }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function shakeFrames(a) {
    return [0, -a, a, -a * 0.7, a * 0.7, -a * 0.35, 0].map(function (x) { return { transform: 'translateX(' + x + 'px) rotate(' + (x * 0.35).toFixed(2) + 'deg)' }; });
  }
  function replay(el, name) { el.classList.remove(name); void el.offsetWidth; el.classList.add(name); }
  function slotOf(id) { return document.querySelector('#players .player[data-id="' + id + '"]'); }

  /** 새 상태를 그리기 전에 지금 화면의 위치를 잡아 둔다. 그린 뒤에는 손패가 이미 바뀌어 있다. */
  function beforeDraw(next) {
    var snap = { event: null, hand: {}, level: state ? state.level : 0, pileLength: state ? state.pile.length : 0 };
    Array.prototype.forEach.call(document.querySelectorAll('#hand .card'), function (card) {
      var r = rectOf(card);
      if (r.w > 0) snap.hand[card.getAttribute('data-value')] = r; // 숨겨진 손패(대기 중 등)는 위치가 없다
    });
    var event = next.lastEvent;
    if (event && typeof event.seq === 'number') {
      // 처음 받은 상태의 사건은 이미 지난 일이다. 번호가 줄었으면 서버가 새로 뜬 것이다(그것도 넘긴다).
      if (seenEventSeq !== null && event.seq > seenEventSeq) snap.event = event;
      seenEventSeq = event.seq;
    } else if (seenEventSeq === null) {
      seenEventSeq = 0;
    }
    return snap;
  }

  function afterDraw(snap, next) {
    if (!canAnimate()) return;
    var quiet = calm();
    var top = next.pile.length ? next.pile[next.pile.length - 1] : null;
    var landed = !!top && next.level === snap.level && next.pile.length === snap.pileLength + 1;
    if (landed && !quiet) flyToPile(top, snap, next);
    var event = snap.event;
    if (!event || event.kind !== 'mistake' || !event.played || !event.lost) return;
    later(landed && !quiet ? LAND_MS : 0, function () { impact(event, next, snap, quiet); });
  }

  /** 새로 나온 카드가 낸 사람 칸(내가 냈으면 내 손패의 그 자리)에서 가운데 더미로 날아온다. */
  function flyToPile(top, snap, next) {
    var pileTop = $('pile-top');
    var to = rectOf(pileTop);
    var from = top.byId === (next.you && next.you.id) ? snap.hand[String(top.value)] : null;
    var scale = from ? from.w / to.w : 0.35;
    if (!from) { var slot = slotOf(top.byId); if (slot) from = rectOf(slot); }
    if (!from) return;
    var dx = from.x + from.w / 2 - (to.x + to.w / 2);
    var dy = from.y + from.h / 2 - (to.y + to.h / 2);
    motion(pileTop, [
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale.toFixed(2) + ') rotate(-10deg)', opacity: 0.7 },
      { transform: 'translate(' + (dx * 0.45) + 'px,' + (dy * 0.45 - 24) + 'px) scale(.85) rotate(-4deg)', opacity: 1, offset: 0.55 },
      { transform: 'none', opacity: 1 }
    ], LAND_MS, { easing: 'cubic-bezier(.3,.7,.35,1)', fill: 'none' });
  }

  function impact(event, next, snap, quiet) {
    var me = next.you && next.you.id;
    var pileTop = $('pile-top');
    var top = next.pile.length ? next.pile[next.pile.length - 1] : null;
    // ✕ 도장: 실수를 부른 그 카드가 아직 가운데에 있을 때만(실수로 레벨이 끝나면 더미가 비었다)
    if (top && top.value === event.played.value && top.byId === event.played.byId) pileTop.classList.add('bad');
    replay($('board'), 'hit');
    replay($('status-chip'), 'hit');
    if (!quiet) brokenHeart($('status-chip'));
    var mine = null;
    var others = [];
    event.lost.forEach(function (entry) {
      if (entry.id === me) mine = entry; else others.push(entry);
      var slot = slotOf(entry.id);
      if (slot) replay(slot, 'hit');
    });
    // 동작 줄이기: 날리거나 찢지 않고, 버려지는 카드를 가운데 더미 옆에 빨간 테두리로 잠깐 보여 준다.
    if (quiet) { tearBesidePile(event.lost, true); return; }
    if (mine) tearInHand(mine.cards, snap);
    if (others.length) tearBesidePile(others, false);
  }

  function brokenHeart(chip) {
    var r = rectOf(chip);
    var heart = document.createElement('div');
    heart.className = 'fx-heart';
    heart.textContent = '💔';
    heart.style.left = (r.x + 6) + 'px';
    heart.style.top = (r.y - 4) + 'px';
    fx().appendChild(heart);
    motion(heart, [
      { transform: 'translateY(6px) scale(.4)', opacity: 0 },
      { transform: 'translateY(-10px) scale(1.25)', opacity: 1, offset: 0.3 },
      { transform: 'translateY(-34px) scale(1)', opacity: 0 }
    ], 900, { easing: 'ease-out' });
    later(950, drop(heart));
  }

  /** 쥐고 있던 사람: 자기 손패의 그 자리에서 찢어진다. 남은 카드는 다 찢어진 뒤에 당겨진다. */
  function tearInHand(values, snap) {
    var count = 0;
    values.forEach(function (value, i) {
      var r = snap.hand[String(value)];
      if (!r) return;
      count += 1;
      var card = document.createElement('div');
      card.className = 'card mind-card doomed';
      card.textContent = String(value);
      place(card, r);
      fx().appendChild(card);
      later(IMPACT_MS + i * 120, function () { doom(card, false); });
    });
    if (!count) return;
    var hold = IMPACT_MS + (count - 1) * 120 + 450;
    Array.prototype.forEach.call(document.querySelectorAll('#hand .card'), function (card) {
      var old = snap.hand[card.getAttribute('data-value')];
      if (!old) return; // 새 레벨에서 새로 받은 카드
      var now = rectOf(card);
      var dx = old.x - now.x;
      var dy = old.y - now.y;
      if (!dx && !dy) return;
      motion(card, [{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], 300,
        { delay: hold, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' });
    });
  }

  /** 다른 사람: 그 사람 칸에서 튀어나와 뒤집히고, 가운데 더미 옆에서 찢어진다. */
  function tearBesidePile(entries, quiet) {
    var pile = rectOf($('pile-top'));
    var board = rectOf($('board'));
    var small = window.innerWidth <= 760;
    var w = small ? 40 : 50;
    var h = small ? 56 : 70;
    var cards = [];
    entries.forEach(function (entry) { entry.cards.forEach(function (value) { cards.push({ id: entry.id, value: value }); }); });
    cards = cards.slice(0, 8);
    var right = board.x + board.w - 10 - (pile.x + pile.w + 12);
    var left = pile.x - 12 - (board.x + 10);
    var onRight = right >= left;
    var space = Math.max(w, onRight ? right : left);
    var step = cards.length > 1 ? Math.min(w + 6, Math.max(14, (space - w) / (cards.length - 1))) : 0;
    cards.forEach(function (c, i) {
      var x = onRight ? pile.x + pile.w + 12 + i * step : pile.x - 12 - w - i * step;
      var to = { x: x, y: pile.y + (pile.h - h) / 2, w: w, h: h };
      var slot = slotOf(c.id);
      var from = slot ? rectOf(slot) : to;
      later(IMPACT_MS + i * 140, function () { reveal(c.value, from, to, quiet, i); });
    });
  }

  function reveal(value, from, to, quiet, i) {
    var card = document.createElement('div');
    card.className = 'card mind-card back';
    place(card, to);
    fx().appendChild(card);
    if (quiet) {
      card.className = 'card mind-card doomed';
      card.textContent = String(value);
      motion(card, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], 1500);
      later(1550, drop(card));
      return;
    }
    var dx = from.x + from.w / 2 - (to.x + to.w / 2);
    var dy = from.y + from.h / 2 - (to.y + to.h / 2);
    motion(card, [
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.3) rotate(' + (-20 + i * 10) + 'deg)', opacity: 0.4 },
      { transform: 'translate(' + (dx * 0.4) + 'px,' + (dy * 0.4 - 34) + 'px) scale(.9) rotate(' + (-8 + i * 6) + 'deg)', opacity: 1, offset: 0.55 },
      { transform: 'none', opacity: 1 }
    ], 440, { easing: 'cubic-bezier(.3,.7,.35,1)', fill: 'none' });
    later(440, function () {
      motion(card, [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], 110, { easing: 'ease-in' });
      later(110, function () {
        card.className = 'card mind-card doomed';
        card.textContent = String(value);
        motion(card, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], 130, { easing: 'ease-out' });
        later(390, function () { doom(card, false); });
      });
    });
  }

  /** 떨다가 찢어진다. 동작 줄이기에서는 빨간 테두리로 잠깐 보였다가 사라진다. */
  function doom(card, quiet) {
    if (quiet) {
      motion(card, [{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], 900);
      later(950, drop(card));
      return;
    }
    motion(card, shakeFrames(3.5), 200, { fill: 'none' });
    later(200, function () { rip(card); });
  }

  /** 찢는 선: 위에서 아래로 가운데 근처를 들쭉날쭉 지나간다. 매번 다르다. 값은 카드 크기에 대한 %. */
  function tearLine() {
    var main = [];
    var steps = 6;
    for (var i = 0; i <= steps; i += 1) main.push([50 + rnd(-1, 1) * (i === 0 || i === steps ? 10 : 17), (i / steps) * 100]);
    var points = [];
    main.forEach(function (p, j) {
      points.push(p);
      var n = main[j + 1];
      if (n) points.push([(p[0] + n[0]) / 2 + rnd(-6, 6), (p[1] + n[1]) / 2 + rnd(-2, 2)]);
    });
    return points;
  }

  /** 금이 위에서 아래로 번지고, 같은 카드 두 장을 톱니 모양으로 반씩 잘라(clip-path) 벌어지며 떨어뜨린다. */
  function rip(card) {
    if (!card.parentNode) return;
    var r = rectOf(card);
    var points = tearLine();
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'fx-crack');
    svg.setAttribute('viewBox', '0 0 ' + r.w + ' ' + r.h);
    place(svg, r);
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', points.map(function (p, i) { return (i ? 'L' : 'M') + (p[0] / 100 * r.w).toFixed(1) + ' ' + (p[1] / 100 * r.h).toFixed(1); }).join(' '));
    path.setAttribute('pathLength', '1');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#3f0e40');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-dasharray', '1');
    path.setAttribute('stroke-dashoffset', '1');
    svg.appendChild(path);
    fx().appendChild(svg);
    motion(path, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], 150, { easing: 'ease-in' });
    later(150, function () {
      drop(svg)();
      if (!card.parentNode) return;
      var at = function (p) { return p[0].toFixed(1) + '% ' + p[1].toFixed(1) + '%'; };
      var bottom = points[points.length - 1];
      var shapes = [
        ['0% 0%'].concat(points.map(at), ['0% 100%']).join(', '),
        points.map(at).concat(['100% 100%', '100% 0%']).join(', ')
      ];
      shapes.forEach(function (shape, i) {
        var piece = card.cloneNode(true);
        piece.classList.add('piece');
        place(piece, r);
        piece.style.clipPath = 'polygon(' + shape + ')';
        piece.style.webkitClipPath = 'polygon(' + shape + ')';
        piece.style.transformOrigin = bottom[0].toFixed(1) + '% 100%'; // 아래쪽 찢긴 점을 축으로 위가 V자로 벌어진다
        fx().appendChild(piece);
        var side = i ? 1 : -1;
        var ms = rnd(900, 1050);
        motion(piece, [
          { transform: 'translate(0,0) rotate(0deg)', easing: 'cubic-bezier(.15,.85,.3,1)' },
          { transform: 'translate(' + side * rnd(4, 8) + 'px,' + rnd(0, 3) + 'px) rotate(' + side * rnd(9, 15) + 'deg)', offset: 0.3, easing: 'cubic-bezier(.5,0,.9,.5)' },
          { transform: 'translate(' + side * rnd(18, 34) + 'px,' + rnd(120, 170) + 'px) rotate(' + side * rnd(35, 60) + 'deg)', opacity: 0 }
        ], ms);
        later(ms + 60, drop(piece));
      });
      drop(card)();
      crumbs(r, points);
    });
  }

  /** 종이 부스러기: 찢어지는 선을 따라 위에서 아래로 튄다. */
  function crumbs(r, points) {
    for (var i = 0; i < 12; i += 1) {
      var p = points[Math.floor(Math.random() * points.length)];
      var bit = document.createElement('div');
      var size = rnd(2.5, 5.5);
      bit.className = 'fx-bit';
      place(bit, { x: r.x + p[0] / 100 * r.w, y: r.y + p[1] / 100 * r.h, w: size, h: size * rnd(0.6, 1.2) });
      fx().appendChild(bit);
      var dx = rnd(-28, 28);
      var ms = rnd(520, 760);
      var delay = p[1] * 1.2;
      motion(bit, [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: 'translate(' + (dx * 0.6) + 'px,' + (-rnd(8, 26)) + 'px) rotate(' + rnd(-120, 120) + 'deg)', opacity: 1, offset: 0.35 },
        { transform: 'translate(' + dx + 'px,' + rnd(30, 70) + 'px) rotate(' + rnd(-300, 300) + 'deg)', opacity: 0 }
      ], ms, { delay: delay, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'both' });
      later(delay + ms + 60, drop(bit));
    }
  }


  var PHASE = { lobby: '대기 중', focus: '집중', playing: '진행 중', result: '게임 종료' };

  /** 게임 시작 전에 누가 준비를 안 했는지 먼저 보여 준다(public/poker.js와 같은 창). */
  var startConfirmOpen = false;
  function renderStartConfirm() {
    var lobby = state.phase === 'lobby' || state.phase === 'result';
    if (startConfirmOpen && (!lobby || !state.canStart)) startConfirmOpen = false;
    $('start-confirm').classList.toggle('hidden', !startConfirmOpen);
    if (!startConfirmOpen) return;
    var joining = state.players.filter(function (p) { return p.ready && p.connected !== false; });
    var left = state.players.filter(function (p) { return !(p.ready && p.connected !== false); });
    var names = function (list) { return list.map(function (p) { return p.nickname; }).join(', '); };
    $('start-confirm-title').textContent = '준비한 ' + joining.length + '명으로 시작할까요?';
    $('start-confirm-ready').textContent = '준비: ' + names(joining);
    $('start-confirm-waiting').textContent = left.length
      ? '준비 안 함: ' + names(left) + ' · 이번 게임에서 빠집니다.'
      : '모두 준비했습니다.';
  }
  function closeStartConfirm() { startConfirmOpen = false; renderStartConfirm(); }

  function renderStarVote() {
    var vote = state.starVote;
    var show = !!vote && !vote.yourVote && state.you.inGame;
    $('star-vote').classList.toggle('hidden', !show);
    if (!vote) return;
    $('star-vote-title').textContent = vote.byName + '님이 수리검을 쓰자고 합니다.';
    $('star-vote-count').textContent = '모두 동의하면 각자 가장 작은 카드를 1장씩 버립니다. (동의 ' + vote.agreed + '/' + vote.total + '명)';
  }

  /** 수리검 투표 중인 사람(제안했거나 이미 동의한 사람)에게 누구를 기다리는지 보여 준다. */
  function starVoteMessage(vote) {
    if (!vote.yourVote) return '수리검 투표 중입니다.';
    var waiting = vote.waitingFor && vote.waitingFor.length ? ' · ' + vote.waitingFor.join(', ') + '님을 기다리는 중' : '';
    return '수리검 투표 중 · 동의 ' + vote.agreed + '/' + vote.total + '명' + waiting;
  }

  function render() {
    document.body.dataset.phase = state.phase;
    var you = state.you;
    var me = state.players.find(function (p) { return p.id === you.id; }) || { ready: false };
    var lobby = state.phase === 'lobby' || state.phase === 'result';
    var live = state.phase === 'focus' || state.phase === 'playing';
    $('phase').textContent = PHASE[state.phase] || state.phase;
    $('level').textContent = state.level ? state.level + ' / ' + state.levels : '-';
    $('status-chip').textContent = state.level ? '목숨 ' + state.lives + ' · 수리검 ' + state.stars : '2~4명';

    $('lobby').classList.toggle('hidden', !lobby);
    $('focus-controls').classList.toggle('hidden', !(state.phase === 'focus' && you.inGame));
    $('play-controls').classList.toggle('hidden', !(state.phase === 'playing' && you.inGame));
    $('ready').textContent = me.ready ? '준비 취소' : '준비';
    $('start').disabled = !state.canStart;
    $('focus').textContent = you.focused ? '집중 취소' : '집중 완료';
    $('focus').classList.toggle('secondary', !!you.focused);
    var lowest = you.hand.length ? you.hand[0] : null;
    $('play').textContent = lowest === null ? '낼 카드 없음' : '카드 내기 · ' + lowest;
    $('play').disabled = lowest === null || !!state.starVote || pendingPlay;
    ['star', 'star-focus'].forEach(function (id) {
      $(id).textContent = '수리검 (' + state.stars + ')';
      $(id).disabled = state.stars <= 0 || !!state.starVote;
    });

    var message;
    if (state.result) {
      message = state.result.message + ' 다시 하려면 준비를 눌러 주세요.';
    } else if (lobby) {
      message = state.canStart
        ? '준비한 ' + state.readyCount + '명으로 새 게임을 시작할 수 있습니다.'
        : state.readyCount > state.maxPlayers
          ? '더 마인드는 ' + state.maxPlayers + '명까지 할 수 있습니다. 준비한 사람을 ' + state.maxPlayers + '명 이하로 맞춰 주세요. (현재 ' + state.readyCount + '명)'
          : '준비한 참가자가 ' + state.minPlayers + '~' + state.maxPlayers + '명이면 누구나 시작할 수 있습니다. (현재 ' + state.readyCount + '명)';
    } else if (!you.inGame) {
      message = '진행 중인 게임을 구경하고 있습니다. 다음 게임부터 참여할 수 있습니다.';
    } else if (state.phase === 'focus') {
      var waiting = state.players.filter(function (p) { return p.inGame && !p.focused; }).map(function (p) { return p.nickname; });
      message = (state.pauseReason || '모두 집중하면 시작합니다.')
        + (you.focused && waiting.length ? ' · ' + waiting.join(', ') + '님을 기다리는 중' : '');
    } else {
      message = state.starVote ? starVoteMessage(state.starVote) : '말없이, 작은 수부터. "지금이다" 싶을 때 내세요.';
    }
    $('message').textContent = message;

    setHtml('players', state.players.map(function (p) {
      var status;
      if (p.connected === false) status = '끊김';
      else if (lobby) status = p.ready ? '준비' : '대기';
      else if (!p.inGame) status = '구경';
      else if (state.phase === 'focus') status = p.focused ? '집중' : '대기';
      else status = p.cardCount ? '진행' : '다 냄';
      var small = p.inGame && (live || state.result) ? '카드 ' + p.cardCount + '장' : '';
      var initial = Array.from(p.nickname)[0] || '나';
      return '<div class="player" data-id="' + p.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(p.nickname)
        + (p.id === you.id ? ' (나)' : '') + '</b><small>' + small + '</small><span class="status">' + status + '</span></div>';
    }).join(''));

    var showGame = state.level > 0 && (live || !!state.result);
    $('rules').classList.toggle('hidden', showGame);
    $('game-view').classList.toggle('hidden', !showGame);
    if (showGame) {
      $('lives').textContent = '❤️ 목숨 ' + state.lives;
      $('stars').textContent = '⭐ 수리검 ' + state.stars;
      $('reward').textContent = live && state.reward ? '이 레벨을 깨면 ' + (state.reward === 'star' ? '수리검' : '목숨') + ' +1' : '';
      var event = state.lastEvent;
      $('event').className = 'event' + (event ? ' ' + event.kind : ' hidden');
      $('event').textContent = event ? event.text : '';
      var top = state.pile.length ? state.pile[state.pile.length - 1] : null;
      // 새 카드가 나왔을 때만 가운데 카드를 새로 만든다 - 방금 나온 카드에 등장 애니메이션이 걸린다.
      var topKey = state.level + ':' + state.pile.length + ':' + (top ? top.value : '');
      if (drawn.pileTop !== topKey) {
        drawn.pileTop = topKey;
        var oldTop = $('pile-top');
        var newTop = oldTop.cloneNode(false);
        newTop.className = 'card mind-card' + (top ? '' : ' empty');
        newTop.textContent = top ? String(top.value) : '-';
        oldTop.parentNode.replaceChild(newTop, oldTop);
      }
      setHtml('pile-list', state.pile.slice(0, -1).map(function (card) { return '<span>' + Number(card.value) + '</span>'; }).join(''));
      var reasons = { mistake: '실수', star: '수리검', left: '빠짐' };
      $('discards').classList.toggle('hidden', !state.discarded.length);
      $('discards').textContent = state.discarded.length
        ? '버린 카드: ' + state.discarded.map(function (d) { return d.value + '(' + d.owner + ' · ' + (reasons[d.reason] || d.reason) + ')'; }).join(', ')
        : '';
      // 게임이 끝났는데 내 손에 남은 카드가 없으면 "다 냈습니다"를 보여 줄 이유가 없다.
      document.querySelector('.hand-area').classList.toggle('hidden', !!state.result && !you.hand.length);
      $('hand-label').textContent = you.inGame ? '내 카드 ' + you.hand.length + '장' + (you.hand.length ? ' · 테두리가 다음에 낼 카드' : '') : '구경 중';
      var handKey = state.level + '|' + (state.result ? 'end' : 'live') + '|' + (you.inGame ? you.hand.join(',') : '-');
      if (drawn.handKey !== handKey) {
        // 새로 받은 패(레벨 시작·새 게임)만 나눠 주는 모습으로 보인다. 카드를 내거나 버려서 줄었을 때는
        // 남은 카드가 다시 날아 들어오지 않게 애니메이션을 끈다(still).
        var dealt = drawn.handLevel !== state.level || drawn.handEnded || you.hand.length > drawn.handCount;
        drawn.handKey = handKey;
        drawn.handLevel = state.level;
        drawn.handEnded = !!state.result;
        drawn.handCount = you.hand.length;
        $('hand').innerHTML = you.inGame
          ? (you.hand.length ? you.hand.map(function (value) { return '<div class="card mind-card' + (dealt ? '' : ' still') + '" data-value="' + Number(value) + '">' + Number(value) + '</div>'; }).join('') : '<span class="none">다 냈습니다</span>')
          : '';
      }
      var leftovers = state.result ? state.players.filter(function (p) { return p.hand && p.hand.length; }) : [];
      $('reveal').classList.toggle('hidden', !leftovers.length);
      $('reveal').textContent = leftovers.length
        ? '남아 있던 카드 - ' + leftovers.map(function (p) { return p.nickname + ': ' + p.hand.join(', '); }).join(' / ')
        : '';
    }

    setHtml('history', state.history.slice().reverse().map(function (item) { return '<div>' + escapeHtml(item.text) + '</div>'; }).join(''));
    renderStarVote();
    renderStartConfirm();
  }

  $('ready').onclick = function () {
    var me = state.players.find(function (p) { return p.id === state.you.id; });
    markSending($('ready'));
    send('ready', { ready: !(me && me.ready) });
  };
  $('leave').onclick = function (event) { event.preventDefault(); if (socket) socket.leave(); };
  $('start').onclick = function () { startConfirmOpen = true; renderStartConfirm(); };
  $('start-cancel').onclick = closeStartConfirm;
  $('start-go').onclick = function () { closeStartConfirm(); send('start'); };
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && startConfirmOpen) closeStartConfirm(); });
  $('focus').onclick = function () { markSending($('focus')); send('focus', { focused: !state.you.focused }); };
  $('play').onclick = function () {
    if (pendingPlay) return;
    pendingPlay = true;
    pendingHand = state.you.hand.length;
    pendingLevel = state.level;
    $('play').disabled = true;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () { pendingPlay = false; if (state) render(); }, 1500);
    send('play');
  };
  $('pause').onclick = function () { markSending($('pause')); send('pause'); };
  $('star').onclick = function () { markSending($('star')); send('star'); };
  $('star-focus').onclick = function () { markSending($('star-focus')); send('star'); };
  $('star-yes').onclick = function () { if (!state.starVote) return; markSending($('star-yes')); markSending($('star-no')); send('starVote', { voteId: state.starVote.id, agree: true }); };
  $('star-no').onclick = function () { if (!state.starVote) return; markSending($('star-yes')); markSending($('star-no')); send('starVote', { voteId: state.starVote.id, agree: false }); };
  document.querySelectorAll('button[data-help]').forEach(function (button) {
    function showHelp() { $('action-help').textContent = button.dataset.help; }
    button.addEventListener('mouseenter', showHelp);
    button.addEventListener('focus', showHelp);
    button.addEventListener('touchstart', showHelp, { passive: true });
  });
  // 연결·재접속·확인·보스 키 알림은 public/game-socket.js가 한다. 여기서는 더 마인드 메시지만 처리한다.
  socket = window.GameSocket.open({
    game: 'mind',
    tokenKey: TOKEN_KEY,
    nickname: nickname,
    onMessage: function (data) {
      if (data.type === 'error') { pendingPlay = false; releaseSending(); showError(data.message); if (state) render(); return; }
      if (data.type === 'mindState') {
        settlePending(data);
        releaseSending();
        var snap = beforeDraw(data);
        state = data;
        render();
        afterDraw(snap, data);
      }
    }
  });
}());
