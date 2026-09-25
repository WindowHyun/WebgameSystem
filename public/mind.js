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
      message = state.starVote ? '수리검 투표 중입니다.' : '말없이, 작은 수부터. "지금이다" 싶을 때 내세요.';
    }
    $('message').textContent = message;

    $('players').innerHTML = state.players.map(function (p) {
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
    }).join('');

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
      $('pile-top').className = 'card mind-card' + (top ? '' : ' empty');
      $('pile-top').textContent = top ? String(top.value) : '-';
      $('pile-list').innerHTML = state.pile.slice(0, -1).map(function (card) { return '<span>' + Number(card.value) + '</span>'; }).join('');
      var reasons = { mistake: '실수', star: '수리검', left: '빠짐' };
      $('discards').classList.toggle('hidden', !state.discarded.length);
      $('discards').textContent = state.discarded.length
        ? '버린 카드: ' + state.discarded.map(function (d) { return d.value + '(' + d.owner + ' · ' + (reasons[d.reason] || d.reason) + ')'; }).join(', ')
        : '';
      // 게임이 끝났는데 내 손에 남은 카드가 없으면 "다 냈습니다"를 보여 줄 이유가 없다.
      document.querySelector('.hand-area').classList.toggle('hidden', !!state.result && !you.hand.length);
      $('hand-label').textContent = you.inGame ? '내 카드 ' + you.hand.length + '장' + (you.hand.length ? ' · 테두리가 다음에 낼 카드' : '') : '구경 중';
      $('hand').innerHTML = you.inGame
        ? (you.hand.length ? you.hand.map(function (value) { return '<div class="card mind-card">' + Number(value) + '</div>'; }).join('') : '<span class="none">다 냈습니다</span>')
        : '';
      var leftovers = state.result ? state.players.filter(function (p) { return p.hand && p.hand.length; }) : [];
      $('reveal').classList.toggle('hidden', !leftovers.length);
      $('reveal').textContent = leftovers.length
        ? '남아 있던 카드 - ' + leftovers.map(function (p) { return p.nickname + ': ' + p.hand.join(', '); }).join(' / ')
        : '';
    }

    $('history').innerHTML = state.history.slice().reverse().map(function (item) { return '<div>' + escapeHtml(item.text) + '</div>'; }).join('');
    renderStarVote();
    renderStartConfirm();
  }

  $('ready').onclick = function () {
    var me = state.players.find(function (p) { return p.id === state.you.id; });
    send('ready', { ready: !(me && me.ready) });
  };
  $('leave').onclick = function (event) { event.preventDefault(); if (socket) socket.leave(); };
  $('start').onclick = function () { startConfirmOpen = true; renderStartConfirm(); };
  $('start-cancel').onclick = closeStartConfirm;
  $('start-go').onclick = function () { closeStartConfirm(); send('start'); };
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && startConfirmOpen) closeStartConfirm(); });
  $('focus').onclick = function () { send('focus', { focused: !state.you.focused }); };
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
  $('pause').onclick = function () { send('pause'); };
  $('star').onclick = function () { send('star'); };
  $('star-focus').onclick = function () { send('star'); };
  $('star-yes').onclick = function () { if (state.starVote) send('starVote', { voteId: state.starVote.id, agree: true }); };
  $('star-no').onclick = function () { if (state.starVote) send('starVote', { voteId: state.starVote.id, agree: false }); };
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
      if (data.type === 'error') { pendingPlay = false; showError(data.message); if (state) render(); return; }
      if (data.type === 'mindState') { settlePending(data); state = data; render(); }
    }
  });
}());
