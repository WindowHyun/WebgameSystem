(function () {
  'use strict';

  var NAME_KEY = 'game-portal-nickname';
  var TOKEN_KEY = 'holdem-game-token';
  var PREFS_KEY = 'holdem-notify';
  var HOLD_MS = 700;        // 올인은 이만큼 꾹 눌러야 실행된다
  var CONFIRM_MS = 3000;    // 폴드 확인을 기다려 주는 시간
  var STREET_NAMES = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };
  var ACTION_NAMES = { check: '체크', call: '콜', raise: '레이즈', allin: '올인', fold: '폴드' };

  var nickname = sessionStorage.getItem(NAME_KEY);
  if (!nickname) { location.href = '/'; return; }

  var state = null;
  var donationTarget = null;
  var socket = null;

  function $(id) { return document.getElementById(id); }
  function send(type, extra) {
    if (!socket) return false;
    var ok = socket.send(type, extra);
    // 다시 연결하는 중에는 요청이 가지 않는다. 눌렀는데 아무 일도 없으면 원인을 알 수 없으니 알려 준다.
    if (!ok) showError('연결이 끊겨 있어 보내지 못했습니다. 다시 연결하는 중입니다.');
    return ok;
  }
  function money(value) { return Number(value || 0).toLocaleString() + '원'; }
  function escapeHtml(value) { var el = document.createElement('div'); el.textContent = value; return el.innerHTML; }

  /**
   * 참가자 줄에 쓰는 짧은 금액(web/poker.js와 같은 이유: 폰에서는 한 칸이 100px 남짓이라 잘린다).
   * 만 단위로 줄인다.
   */
  function shortMoney(value) {
    var won = Number(value || 0);
    if (won < 10000) return won.toLocaleString();
    var man = won / 10000;
    return (man >= 100 ? Math.round(man) : Math.round(man * 10) / 10) + '만';
  }

  var errorTimer = null;
  function showError(text) {
    $('error').textContent = text;
    $('error').style.display = 'block';
    clearTimeout(errorTimer); // 앞의 토스트가 뒤에 온 것까지 같이 지우지 않게 한다
    errorTimer = setTimeout(function () { $('error').style.display = 'none'; }, 3000);
  }

  // ── 내 차례 알림 ────────────────────────────────────────
  // 탭 제목에 "(내 차례)"를 붙이고, 켜 두면 알림음을 낸다. 사무실에서 몰래 하는 화면이라 소리는 기본이 꺼짐이다.
  // 설정은 이 브라우저에만 남긴다(저장이 막혀 있어도 화면은 그대로 동작한다).
  var prefs = { title: true, sound: false };
  try {
    var saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (saved && typeof saved === 'object') prefs = { title: saved.title !== false, sound: saved.sound === true };
  } catch (error) { /* 저장된 설정이 없거나 깨졌다 - 기본값을 쓴다 */ }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (error) { /* 저장이 막혀 있다 */ } }
  $('notify-title').checked = prefs.title;
  $('notify-sound').checked = prefs.sound;

  var audio = null;
  function beep() {
    try {
      var Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      if (!audio) audio = new Context();
      if (audio.state === 'suspended') audio.resume();
      [[660, 0], [880, 0.14]].forEach(function (note) {
        var osc = audio.createOscillator();
        var gain = audio.createGain();
        osc.frequency.value = note[0];
        gain.gain.setValueAtTime(0.0001, audio.currentTime + note[1]);
        gain.gain.exponentialRampToValueAtTime(0.18, audio.currentTime + note[1] + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + note[1] + 0.16);
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start(audio.currentTime + note[1]);
        osc.stop(audio.currentTime + note[1] + 0.18);
      });
    } catch (error) { /* 소리를 낼 수 없는 환경 - 조용히 넘어간다 */ }
  }
  $('notify-title').onchange = function () { prefs.title = this.checked; savePrefs(); applyTitle(); };
  $('notify-sound').onchange = function () {
    prefs.sound = this.checked;
    savePrefs();
    // 켜는 순간(사용자가 누른 순간)에 한 번 들려 준다. 브라우저는 사용자가 누르기 전에는 소리를 막는다.
    if (prefs.sound) beep();
  };
  var wasMyTurn = false;
  function applyTitle() {
    var mine = !!(state && state.turnPlayerId && state.you && state.turnPlayerId === state.you.id);
    document.title = (mine && prefs.title ? '(내 차례) ' : '') + '텍사스 홀덤';
  }

  // ── 카드 ────────────────────────────────────────────────
  var RANK_LABELS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  function cardHtml(card, extra) {
    if (!card) return '<div class="hcard empty ' + (extra || '') + '"></div>';
    if (card.hidden) return '<div class="hcard back ' + (extra || '') + '" aria-label="뒷면 카드"></div>';
    var red = card.suit === '♥' || card.suit === '♦';
    var label = (RANK_LABELS[card.rank] || card.rank) + card.suit;
    return '<div class="hcard ' + (red ? 'red ' : '') + (extra || '') + '" aria-label="' + label + '">' + label + '</div>';
  }

  // ── 시작 확인 / 제안 (인디언 포커 화면과 같다) ─────────────
  var startConfirmOpen = false;
  function renderStartConfirm() {
    var lobby = state.phase === 'lobby' || state.phase === 'result';
    if (startConfirmOpen && (!lobby || !state.canStart)) startConfirmOpen = false;
    $('start-confirm').classList.toggle('hidden', !startConfirmOpen);
    if (!startConfirmOpen) return;
    // 서버와 같은 기준: 준비했고 칩이 있어야 이번 판에 들어간다.
    var joining = state.players.filter(function (p) { return p.ready && p.chips > 0; });
    var left = state.players.filter(function (p) { return !(p.ready && p.chips > 0); });
    var names = function (list) { return list.map(function (p) { return p.nickname + (p.ready && p.chips <= 0 ? '(칩 없음)' : ''); }).join(', '); };
    $('start-confirm-title').textContent = '준비한 ' + joining.length + '명으로 시작할까요?';
    $('start-confirm-ready').textContent = '준비: ' + names(joining);
    $('start-confirm-waiting').textContent = left.length
      ? '준비 안 함: ' + names(left) + ' · 이번 판에서 빠집니다.'
      : '모두 준비했습니다.';
  }
  function closeStartConfirm() { startConfirmOpen = false; renderStartConfirm(); }

  function renderProposal() {
    var proposal = state.baseBetProposal;
    $('proposal').classList.toggle('hidden', !proposal || proposal.yourVote);
    if (!proposal) return;
    $('proposal-title').textContent = proposal.proposerName + '님이 블라인드 ' + money(proposal.amount / 2) + ' / ' + money(proposal.amount) + '을 제안했습니다.';
    $('proposal-count').textContent = '찬성 ' + proposal.agreed + '명 · 투표 ' + proposal.voted + '/' + proposal.total + '명';
  }

  // ── 제한시간 ────────────────────────────────────────────
  // 서버는 상태를 보낼 때의 남은 시간만 알려 준다. 그다음은 이 화면이 센다(서버 시계와 맞출 필요가 없다).
  // 카드를 나눈 직후의 "카드 확인 시간"(state.peeking)에도 같은 막대와 초 표시를 쓴다.
  var clock = { endsAt: 0, total: 0, frozenMs: null, active: false };
  function syncClock() {
    var peeking = state.phase === 'betting' && state.peeking === true && state.peekRemainingMs !== null && !!state.peekTotalMs;
    var running = state.phase === 'betting' && state.turnRemainingMs !== null && !!state.turnTotalMs;
    clock.active = peeking || running;
    if (!clock.active) return;
    var remaining = peeking ? state.peekRemainingMs : state.turnRemainingMs;
    clock.total = peeking ? state.peekTotalMs : state.turnTotalMs;
    clock.endsAt = performance.now() + remaining;
    clock.frozenMs = !peeking && state.paused ? remaining : null; // 화면이 가려져 멈춘 동안은 그대로 둔다
  }
  function renderClock() {
    var track = $('timer-track');
    track.classList.toggle('hidden', !clock.active);
    if (!clock.active) { $('timer').textContent = ''; return; }
    var left = clock.frozenMs !== null ? clock.frozenMs : Math.max(0, clock.endsAt - performance.now());
    var seconds = Math.ceil(left / 1000);
    $('timer').textContent = state.paused && !state.peeking ? '멈춤' : seconds + '초';
    $('timer-bar').style.width = Math.max(0, Math.min(100, (left / clock.total) * 100)) + '%';
    track.classList.toggle('urgent', !state.paused && !state.peeking && seconds <= 5);
  }
  setInterval(renderClock, 200);

  // ── 레이즈 입력 ─────────────────────────────────────────
  var raiseValue = 100;
  var raiseBounds = { min: 100, max: 100 };
  var lastRaiseMin = null;
  function digits(text) { return Number(String(text).replace(/[^0-9]/g, '')) || 0; }
  function clampRaise(value) {
    var snapped = Math.round(value / 100) * 100;
    return Math.max(raiseBounds.min, Math.min(raiseBounds.max, snapped));
  }
  function setRaise(value) {
    raiseValue = clampRaise(value);
    $('raise-amount').value = String(raiseValue);
    $('raise').textContent = raiseOpen && narrow.matches ? '레이즈 · ' + money(raiseValue) : '레이즈';
    $('raise').setAttribute('aria-label', '레이즈 ' + money(raiseValue));
  }
  /**
   * 서버가 거절하는 값(직전 레이즈 폭보다 작거나 칩이 남지 않는 값)은 아예 못 고르게 범위를 잡는다.
   * 하한이 올라가면 기본값도 같이 끌어올린다. 사용자가 하한보다 큰 값을 직접 적어 뒀다면 건드리지 않는다.
   */
  function syncRaiseBounds(you, toCall) {
    var min = Number(state.minRaise) > 0 ? Number(state.minRaise) : 100;
    var max = Math.floor((you.chips - toCall - 1) / 100) * 100; // 레이즈 후에도 칩이 남아야 한다(전액은 올인)
    raiseBounds = { min: min, max: Math.max(max, 0) };
    var input = $('raise-amount');
    input.setAttribute('aria-label', '레이즈 금액 (최소 ' + money(min) + ')');
    if (lastRaiseMin !== min || raiseValue < min) setRaise(min);
    else setRaise(raiseValue);
    lastRaiseMin = min;
  }
  [].forEach.call(document.querySelectorAll('#quick [data-add]'), function (button) {
    button.onclick = function () { setRaise(raiseValue + Number(button.dataset.add)); };
  });
  $('quick-pot').onclick = function () {
    var you = myPlayer();
    var toCall = Math.max(0, state.currentBet - you.roundBet);
    setRaise(Math.ceil((state.pot + toCall) / 100) * 100); // 팟 크기만큼 올린다
  };
  $('raise-minus').onclick = function () { setRaise(raiseValue - 100); };
  $('raise-plus').onclick = function () { setRaise(raiseValue + 100); };
  $('raise-amount').oninput = function () { raiseValue = digits(this.value); };
  $('raise-amount').onchange = function () { setRaise(digits(this.value)); };
  $('raise-amount').onkeydown = function (event) { if (event.key === 'Enter') { event.preventDefault(); setRaise(digits(this.value)); $('raise').click(); } };

  // ── 올인(꾹 누르기)·폴드(한 번 더 확인) ───────────────────
  // 되돌릴 수 없는 선택이 레이즈 바로 옆에 있어서 잘못 누르기 쉬웠다. 올인은 꾹 눌러야 하고, 폴드는 한 번 더 확인한다.
  var holdTimer = null;
  var holding = false;
  function holdBar() { return $('hold-bar'); }
  function startHold() {
    var button = $('allin');
    if (holding || button.disabled) return;
    holding = true;
    button.classList.add('holding');
    var bar = holdBar();
    bar.style.transition = 'none';
    bar.style.width = '0%';
    void bar.offsetWidth; // 0에서 다시 시작하도록 한 번 그려 준다
    bar.style.transition = 'width ' + HOLD_MS + 'ms linear';
    bar.style.width = '100%';
    holdTimer = setTimeout(function () {
      holdTimer = null;
      cancelHold();
      send('allin');
    }, HOLD_MS);
  }
  function cancelHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    holding = false;
    $('allin').classList.remove('holding');
    var bar = holdBar();
    bar.style.transition = 'none';
    bar.style.width = '0%';
  }
  var allinButton = $('allin');
  allinButton.addEventListener('pointerdown', function (event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    startHold();
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (type) { allinButton.addEventListener(type, cancelHold); });
  allinButton.addEventListener('contextmenu', function (event) { event.preventDefault(); }); // 길게 누를 때 뜨는 메뉴
  // 키보드는 누르고 있는 동안 센다. 누르고 있을 때 반복해서 오는 keydown도, 떼는 keyup도 기본 동작(= 클릭)을 막아서
  // 키로는 "꾹 누르기"로만 올인이 된다(그렇지 않으면 반복 keydown마다 클릭이 날아와 확인 단계로 들어간다).
  allinButton.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!event.repeat) startHold();
  });
  allinButton.addEventListener('keyup', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    cancelHold();
  });
  allinButton.addEventListener('blur', cancelHold);
  // 보조 기기가 보내는 클릭(포인터도 키도 없이 오는 것)은 꾹 누를 수 없으니 폴드처럼 한 번 더 확인한다.
  allinButton.addEventListener('click', function (event) {
    if (event.detail !== 0 || holding) return;
    confirmOnce(allinButton, function () { send('allin'); });
  });

  var confirming = null; // { button, label, html, timer }
  function resetConfirm() {
    if (!confirming) return;
    clearTimeout(confirming.timer);
    confirming.button.classList.remove('confirming');
    confirming.button.removeAttribute('aria-label');
    confirming.label.innerHTML = confirming.html;
    confirming = null;
  }
  // 첫 번째 누름은 질문(버튼의 data-ask)을 보여 주고, CONFIRM_MS 안에 한 번 더 누르면 실행한다.
  // 글자는 버튼 안의 .label 칸만 바꾼다 - 버튼 전체의 innerHTML을 다시 쓰면 올인 버튼 안 막대의 스타일 속성까지
  // 글자로 되돌려 써서 CSP(인라인 스타일 금지)에 걸린다.
  function confirmOnce(button, action) {
    if (confirming && confirming.button === button) {
      resetConfirm();
      action();
      return;
    }
    resetConfirm();
    var label = button.querySelector('.label');
    confirming = { button: button, label: label, html: label.innerHTML, timer: setTimeout(resetConfirm, CONFIRM_MS) };
    button.classList.add('confirming');
    button.setAttribute('aria-label', button.dataset.ask); // 보조 기기에도 질문을 읽어 준다
    label.textContent = button.dataset.ask;
  }
  $('fold').onclick = function () { confirmOnce($('fold'), function () { send('fold'); }); };

  // ── 그리기 ──────────────────────────────────────────────
  function myPlayer() { return state.players.find(function (player) { return player.id === state.you.id; }); }
  function playerName(id) { var p = state.players.find(function (x) { return x.id === id; }); return p ? p.nickname : ''; }

  var DEFAULT_HELP = '버튼에 마우스를 올리거나 선택하면 기능 설명이 표시됩니다.';
  var lastPhase = null;
  var lastBoardCount = 0;

  function renderSeats() {
    var inHand = state.players.filter(function (player) { return player.inRound; });
    var winners = {};
    if (state.phase === 'result' && state.result && state.result.winners) {
      state.result.winners.forEach(function (w) { winners[w.id] = w; });
    }
    if (!inHand.length) {
      $('seats').innerHTML = '<p class="seats-empty">준비가 끝나면 카드가 여기에 놓입니다</p>';
      return;
    }
    $('seats').innerHTML = inHand.map(function (player) {
      var me = player.id === state.you.id;
      var turn = player.id === state.turnPlayerId;
      var win = !!winners[player.id];
      // 카드를 나눈 직후(카드 확인 시간)에는 내 카드를 보라고 알린다.
      var peek = me && state.peeking === true && !player.isFolded;
      var cls = 'seat' + (me ? ' me' : '') + (player.isFolded ? ' folded' : '') + (turn ? ' turn' : '') + (win ? ' winner' : '') + (peek ? ' peek' : '');
      var tag = win ? '승리' : turn ? (me ? '내 차례' : '차례') : peek ? '내 카드 확인' : '';
      var cards;
      if (player.cards && player.cards.length) {
        // 내 카드·남의 뒷면은 등장 효과 없이 바로 보인다(효과 동안 안 보이는 시간이 있으면 카드를 못 본 채 시작하게 된다).
        cards = player.cards.map(function (card) { return cardHtml(card, ''); }).join('');
      } else {
        cards = '<div class="seat-fold">폴드</div>';
      }
      var badges = '';
      if (player.id === state.smallBlindId) badges += '<em class="pos" title="스몰 블라인드">SB</em>';
      if (player.id === state.bigBlindId) badges += '<em class="pos" title="빅 블라인드">BB</em>';
      var pill = '';
      if (state.phase === 'result' && win) {
        pill = '<span class="seat-pill win">+' + money(winners[player.id].amount) + '</span>';
      } else if (state.phase === 'betting' && !player.isFolded) {
        pill = '<span class="seat-pill">건 돈 <b>' + player.roundBet.toLocaleString() + '</b></span>';
      }
      var hand = player.handName && state.phase === 'result' ? '<span class="seat-hand">' + escapeHtml(player.handName) + '</span>' : '';
      var action = state.phase === 'betting' && player.action && !player.isFolded ? '<span class="seat-action">' + ACTION_NAMES[player.action] + '</span>' : '';
      return '<div class="' + cls + '"><div class="seat-tag">' + tag + '</div><div class="seat-cards">' + cards + '</div>'
        + '<div class="seat-name"><b>' + escapeHtml(player.nickname) + (me ? ' (나)' : '') + '</b>' + badges + '</div>'
        + hand + pill + action + '</div>';
    }).join('');
  }

  function renderBoard() {
    var cards = state.board || [];
    var html = '';
    for (var i = 0; i < 5; i += 1) {
      html += cards[i] ? cardHtml(cards[i], i >= lastBoardCount && state.phase === 'betting' ? 'new' : '') : cardHtml(null, '');
    }
    $('board').innerHTML = html;
    lastBoardCount = cards.length;
  }

  function renderPlayers(lobby) {
    $('players').innerHTML = state.players.map(function (player) {
      var waiting = state.phase === 'betting' && !player.inRound;
      // 판이 끝나 대기 중일 때는 지난 판의 폴드·올인이 아니라 다음 판 준비 여부를 보여 준다.
      var status;
      if (lobby) status = player.ready ? '준비' : '대기';
      else if (waiting) status = '다음 판 대기';
      else if (player.isFolded) status = '폴드';
      else if (player.isAllIn) status = '올인';
      else if (player.action && ACTION_NAMES[player.action]) status = ACTION_NAMES[player.action];
      else status = '대기';
      // 끊긴 채로 판에 남은 사람(올인하고 기다리는 사람). 차례가 오지 않으니 기다릴 필요는 없다.
      if (player.connected === false) status = '끊김';
      var initial = Array.from(player.nickname)[0] || '나';
      var bet = player.roundBet > 0 && state.phase === 'betting'
        ? '<span class="wide"> · 건 돈 ' + player.roundBet.toLocaleString() + '</span><span class="narrow"> · +' + shortMoney(player.roundBet) + '</span>' : '';
      return '<div class="player ' + (player.id === state.turnPlayerId ? 'turn' : '') + '" role="button" tabindex="0" title="대기 중 선택하면 기부할 수 있습니다" data-id="' + player.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(player.nickname) + (player.id === state.you.id ? ' (나)' : '') + '</b><small><span class="wide">보유 </span>' + shortMoney(player.chips) + bet + '</small><span class="status">' + status + '</span></div>';
    }).join('');
  }

  function renderControls(you, myTurn, inRound) {
    var toCall = Math.max(0, state.currentBet - you.roundBet);
    var button = $('call');
    button.textContent = toCall ? '콜 · ' + money(toCall) : '체크';
    var locked = !myTurn;
    // 낼 돈이 가진 칩보다 많으면 콜은 서버가 거절한다. 눌러서 빨간 토스트를 보게 하지 말고 처음부터 막고 올인을 안내한다.
    var cannotCall = toCall > you.chips;
    [].forEach.call($('betting').querySelectorAll('button'), function (b) { b.disabled = locked; });
    if (cannotCall) $('call').disabled = true;
    $('allin').disabled = locked || you.chips <= 0;
    syncRaiseBounds(you, toCall);
    // 칩이 모자라 레이즈할 수 없는 사람은 올인이나 콜·폴드를 고른다. 상한이 정해진 뒤에도 레이즈는 막힌다.
    var cannotRaise = raiseBounds.max < raiseBounds.min || state.allInCap !== null;
    $('raise').disabled = locked || cannotRaise;
    [].forEach.call($('quick').querySelectorAll('button'), function (b) { b.disabled = locked || cannotRaise; });
    $('raise-minus').disabled = locked || cannotRaise;
    $('raise-plus').disabled = locked || cannotRaise;
    $('raise-amount').disabled = locked || cannotRaise;
    $('quick-pot').textContent = '팟 ' + shortMoney(Math.ceil((state.pot + toCall) / 100) * 100);
    // 눌러도 되는 상황이 아니면 왜 그런지 말해 준다. 회색 버튼만 보이면 이유를 알 수 없다.
    var note = '';
    if (!inRound) note = '이번 판은 관전 중입니다. 다음 판부터 참여할 수 있습니다.';
    else if (you.isFolded) note = '폴드했습니다. 남은 판을 관전하고 있습니다.';
    else if (state.peeking) note = '카드를 확인하는 중입니다. 곧 배팅이 시작됩니다.';
    else if (!myTurn) note = (state.turnPlayerId ? playerName(state.turnPlayerId) + '님' : '다른 참가자') + ' 차례라 지금은 누를 수 없습니다.';
    else if (cannotCall) note = '칩이 모자라 콜할 수 없습니다. 가진 칩을 모두 거는 올인이나 폴드 중에서 고르세요.';
    else if (state.allInCap !== null) note = '올인으로 이 판의 배팅 상한이 정해져 레이즈할 수 없습니다.';
    else if (raiseBounds.max < raiseBounds.min) note = '칩이 모자라 레이즈할 수 없습니다. 콜·올인·폴드 중에서 고르세요.';
    $('controls-note').textContent = note;
    $('controls-note').classList.toggle('hidden', !note);
    $('betting').classList.toggle('spectating', !inRound || you.isFolded);
    if (locked) { resetConfirm(); cancelHold(); if (raiseOpen) setRaiseOpen(false); }
  }

  function resultText() {
    var result = state.result;
    if (!result) return '';
    if (result.noWinner) return result.message;
    if (result.winners.length === 1) {
      var w = result.winners[0];
      return w.nickname + '님이 팟 ' + money(w.amount) + '을 획득했습니다' + (w.handName ? ' (' + w.handName + ')' : '') + '.';
    }
    return result.winners.map(function (w) { return w.nickname + ' ' + money(w.amount); }).join(', ') + ' - 팟 ' + money(result.amount) + '을 나눠 가졌습니다'
      + (result.winners[0].handName ? ' (' + result.winners[0].handName + ')' : '') + '.';
  }

  function render() {
    document.body.dataset.phase = state.phase;
    var you = myPlayer();
    var lobby = state.phase === 'lobby' || state.phase === 'result';
    var myTurn = state.turnPlayerId === state.you.id;
    var inRound = state.you.inRound;
    $('pot').textContent = money(state.pot);
    $('table-pot').textContent = money(state.pot);
    $('blind-label').textContent = '블라인드 ' + state.smallBlind.toLocaleString() + ' / ' + state.baseBet.toLocaleString();
    $('base-bet').value = state.baseBet;
    $('phase').textContent = state.phase === 'betting' ? (STREET_NAMES[state.street] || '배팅 중') : state.phase === 'result' ? '라운드 종료' : '대기 중';
    $('lobby').classList.toggle('hidden', !lobby);
    $('betting').classList.toggle('hidden', state.phase !== 'betting');
    $('ready').textContent = you.ready ? '준비 취소' : '준비';
    $('start').disabled = !state.canStart;
    $('set-bet').disabled = !!state.baseBetProposal;

    // 내 차례 띠. 내 차례만 노란색으로 눈에 띄게 하고, 남의 차례는 차분하게 둔다.
    var strip = $('turn-strip');
    strip.classList.toggle('mine', myTurn);
    strip.classList.toggle('peek', state.phase === 'betting' && state.peeking === true && inRound);
    var title = '대기 중';
    var message = '참가자들이 준비하면 시작할 수 있습니다.';
    if (lobby) {
      message = state.canStart
        ? '준비한 ' + state.readyCount + '명으로 새 판을 시작할 수 있습니다.'
        : '준비한 참가자가 ' + state.minPlayers + '명 이상이면 누구나 시작할 수 있습니다. (현재 ' + state.readyCount + '명)';
      if (state.phase === 'result') title = '라운드 종료';
    }
    if (state.phase === 'betting') {
      var toCall = Math.max(0, state.currentBet - you.roundBet);
      if (!inRound) { title = '관전 중'; message = '진행 중인 판을 관전하고 있습니다. 다음 판부터 참여할 수 있습니다.'; }
      else if (you.isFolded) { title = '폴드했습니다'; message = '남은 판을 관전하고 있습니다.'; }
      else if (state.peeking) { title = '카드를 확인하세요'; message = '카드를 나눴습니다. 내 카드를 확인하세요. 곧 배팅이 시작됩니다.'; }
      else if (myTurn) {
        title = '내 차례입니다';
        message = (toCall ? money(toCall) + '을 콜하거나 레이즈·폴드를 선택하세요.' : '체크하거나 레이즈를 선택하세요.')
          + (state.you.handName ? ' 지금 내 패: ' + state.you.handName : '');
      } else {
        var turnPlayer = state.turnPlayerId ? playerName(state.turnPlayerId) : '';
        title = turnPlayer ? turnPlayer + '님 차례입니다' : '배팅 중';
        message = '기다리는 중 · 내 차례가 되면 알려 드려요' + (state.you.handName ? ' · 지금 내 패: ' + state.you.handName : '');
      }
    }
    if (state.result) { title = '라운드 종료'; message = resultText(); }
    // [보스 키] 차례인 사람이 화면을 가려 두는 동안에는 그 사람의 제한시간이 멈춘다(web/cover-pause.js).
    if (state.paused && !state.result) message += ' 차례인 사람의 화면이 가려져 있어 제한시간이 멈췄습니다.';
    $('strip-title').textContent = title;
    $('message').textContent = message;

    // 단계가 바뀌면 지난 단계에서 본 버튼 설명은 지운다(눌러 볼 수 없는 버튼의 설명이 남아 있으면 헷갈린다).
    if (lastPhase !== state.phase) { $('action-help').textContent = DEFAULT_HELP; lastPhase = state.phase; }
    syncClock();
    renderClock();
    renderBoard();
    renderSeats();
    renderPlayers(lobby);
    renderControls(you, myTurn, inRound);

    // 내 차례가 막 되었을 때 한 번만 소리를 낸다.
    if (myTurn && !wasMyTurn && prefs.sound) beep();
    wasMyTurn = myTurn;
    applyTitle();

    $('history').innerHTML = state.history.slice().reverse().map(function (item) { return '<div>' + escapeHtml(item.text) + '</div>'; }).join('');
    function openDonation(element, event) {
      event.preventDefault(); event.stopPropagation();
      if (state.phase !== 'lobby' && state.phase !== 'result') { showError('기부는 대기 중에만 할 수 있습니다.'); return; }
      if (element.dataset.id === state.you.id) return;
      donationTarget = element.dataset.id;
      var target = state.players.find(function (player) { return player.id === donationTarget; });
      $('donate-name').textContent = target.nickname + '님에게';
      var rect = element.getBoundingClientRect();
      $('donate').style.left = Math.min(event.clientX || rect.right, innerWidth - 190) + 'px';
      $('donate').style.top = Math.min(event.clientY || rect.bottom, innerHeight - 150) + 'px';
      $('donate').classList.remove('hidden');
    }
    document.querySelectorAll('.player').forEach(function (element) {
      element.oncontextmenu = function (event) { openDonation(element, event); };
      element.onclick = function (event) { openDonation(element, event); };
      element.onkeydown = function (event) { if (event.key === 'Enter' || event.key === ' ') openDonation(element, event); };
    });
    renderProposal();
    renderStartConfirm();
  }

  $('ready').onclick = function () { send('ready', { ready: !myPlayer().ready }); };
  $('leave').onclick = function (event) { event.preventDefault(); if (socket) socket.leave(); };
  $('set-bet').onclick = function () { send('baseBet', { amount: Number($('base-bet').value) }); };
  $('proposal-yes').onclick = function () { send('baseBetVote', { proposalId: state.baseBetProposal.id, agree: true }); };
  $('proposal-no').onclick = function () { send('baseBetVote', { proposalId: state.baseBetProposal.id, agree: false }); };
  $('start').onclick = function () { startConfirmOpen = true; renderStartConfirm(); };
  $('start-cancel').onclick = closeStartConfirm;
  $('start-go').onclick = function () { closeStartConfirm(); send('start'); };
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && startConfirmOpen) closeStartConfirm(); });
  $('call').onclick = function () { send('call'); };
  // 폰에서는 금액 고르는 창을 접어 둔다(조작부가 화면을 덮지 않게). 레이즈를 처음 누르면 열고, 한 번 더 누르면 올린다.
  var narrow = window.matchMedia ? window.matchMedia('(max-width: 760px)') : { matches: false };
  var raiseOpen = false;
  function setRaiseOpen(open) {
    raiseOpen = open;
    $('betting').classList.toggle('raise-open', open);
    $('raise').textContent = open && narrow.matches ? '레이즈 · ' + money(raiseValue) : '레이즈';
  }
  $('raise').onclick = function () {
    if (narrow.matches && !raiseOpen) { setRaiseOpen(true); return; }
    send('raise', { amount: raiseValue });
    setRaiseOpen(false);
  };
  $('donate-send').onclick = function () { send('donate', { targetId: donationTarget, amount: Number($('donate-amount').value) }); $('donate').classList.add('hidden'); };
  document.querySelectorAll('button[data-help]').forEach(function (button) {
    function showHelp() { $('action-help').textContent = button.dataset.help; }
    button.addEventListener('mouseenter', showHelp);
    button.addEventListener('focus', showHelp);
    button.addEventListener('touchstart', showHelp, { passive: true });
  });
  document.addEventListener('click', function (event) { if (!$('donate').contains(event.target)) $('donate').classList.add('hidden'); });
  // 연결·재접속·확인·보스 키 알림은 public/game-socket.js가 한다. 여기서는 홀덤 메시지만 처리한다.
  socket = window.GameSocket.open({
    game: 'holdem',
    tokenKey: TOKEN_KEY,
    nickname: nickname,
    onMessage: function (data) {
      if (data.type === 'error') { showError(data.message); return; }
      if (data.type === 'holdemState') { state = data; render(); }
    }
  });
}());
