/**
 * 야추다이스 화면. 규칙과 판정은 전부 서버(web/yacht-room.js)가 한다 - 이 화면은 받은 상태를 그리고 버튼을
 * 서버에 전할 뿐이다(주사위도 서버가 굴린다). 연결 유지·재접속은 public/game-socket.js가 한다(다른 카드 게임과 같다).
 */
(function () {
  'use strict';

  var NAME_KEY = 'game-portal-nickname';
  var TOKEN_KEY = 'yacht-game-token';
  var nickname = sessionStorage.getItem(NAME_KEY);
  if (!nickname) { location.href = '/'; return; }

  var state = null;
  var picked = null;     // 점수판에서 고른 칸(아직 기록 전)
  var skew = 0;          // 서버 시계 - 내 시계. 남은 시간을 서버 기준으로 세려고 쓴다

  function $(id) { return document.getElementById(id); }
  function escapeHtml(value) { var el = document.createElement('div'); el.textContent = value; return el.innerHTML; }

  var socket = null;
  function send(type, extra) { if (socket) socket.send(type, extra); }

  var errorTimer = null;
  function showError(text) {
    $('error').textContent = text;
    $('error').style.display = 'block';
    clearTimeout(errorTimer);
    errorTimer = setTimeout(function () { $('error').style.display = 'none'; }, 3000);
  }

  /** 내용이 바뀔 때만 다시 그린다(주사위 애니메이션이 남의 조작마다 다시 돌지 않게). */
  var drawn = {};
  function setHtml(id, html) {
    if (drawn[id] === html) return;
    drawn[id] = html;
    $(id).innerHTML = html;
  }

  /**
   * 누르는 즉시 눌림 표시를 하고 반영될 때까지 버튼을 잠근다(서버까지 왕복하는 동안 두 번 눌러 주사위가
   * 두 번 굴러가는 것을 막는다). 잠금은 settled(다음 상태)가 true이거나 오류가 오거나 잠시 지나면 푼다.
   */
  var sending = [];
  var sendingTimer = null;
  function markSending(button, settled) {
    button.classList.add('sending');
    button.disabled = true;
    sending.push({ button: button, settled: settled });
    clearTimeout(sendingTimer);
    sendingTimer = setTimeout(function () { releaseSending(); if (state) render(); }, 1500);
  }
  function releaseSending(next) {
    var waiting = [];
    sending.forEach(function (entry) {
      if (next && !entry.settled(next)) { waiting.push(entry); return; }
      entry.button.classList.remove('sending');
      entry.button.disabled = false;
    });
    sending = waiting;
    if (!sending.length) clearTimeout(sendingTimer);
  }
  /** 누른 순간의 상태와 비교해 pick(상태)가 바뀌었거나 차례·단계가 바뀌었으면 반영된 것이다. */
  function changedFrom(before, pick) {
    var was = pick(before);
    return function (next) { return next.phase !== before.phase || next.turnId !== before.turnId || pick(next) !== was; };
  }

  var PHASE = { lobby: '대기 중', playing: '진행 중', result: '게임 종료' };
  var PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

  function labelOf(key) {
    var found = state.categories.filter(function (c) { return c.key === key; })[0];
    return found ? found.label : key;
  }

  /** 게임 시작 전에 누가 준비를 안 했는지 먼저 보여 준다(다른 카드 게임과 같은 창). */
  var startConfirmOpen = false;
  function renderStartConfirm() {
    var lobby = state.phase !== 'playing';
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

  /** fresh: 방금 새로 굴렸다 - 고정하지 않은 주사위가 구른다. 상태가 다시 그려질 때마다 굴리지 않는다. */
  function diceHtml(fresh) {
    var you = state.you;
    var canHold = state.phase === 'playing' && you.myTurn && state.rolled && state.rollsLeft > 0;
    return state.dice.map(function (value, i) {
      var empty = !value;
      var cls = 'die' + (empty ? ' empty' : '') + (state.held[i] ? ' held' : '') + (canHold ? ' pick' : '');
      if (fresh && !empty && !state.held[i]) cls += ' rolled';
      var pips = '';
      var on = PIPS[value] || [];
      for (var cell = 1; cell <= 9; cell += 1) pips += '<i' + (on.indexOf(cell) >= 0 ? ' class="on"' : '') + '></i>';
      var aria = empty ? '아직 굴리지 않은 주사위' : value + (state.held[i] ? ' (고정)' : '');
      return '<button type="button" class="' + cls + '" data-i="' + i + '" data-v="' + value + '" aria-label="' + aria + '"' + (canHold ? ' aria-pressed="' + (state.held[i] ? 'true' : 'false') + '"' : ' disabled') + '>' + pips + '</button>';
    }).join('');
  }

  function sheetHtml() {
    var you = state.you;
    var board = state.board;
    var options = you.options || {};
    var live = state.phase === 'playing';
    var head = '<thead><tr><th class="cat">칸</th>' + board.map(function (b) {
      var cls = 'name' + (live && b.id === state.turnId ? ' turn' : '') + (b.left ? ' gone' : '');
      return '<th class="' + cls + '" title="' + escapeHtml(b.nickname) + '">' + escapeHtml(b.nickname) + (b.id === you.id ? ' (나)' : '') + '</th>';
    }).join('') + '</tr></thead>';
    var body = '<tbody>' + state.categories.map(function (c) {
      var cells = board.map(function (b) {
        var value = b.sheet[c.key];
        var mine = b.id === you.id;
        if (value !== null && value !== undefined) return '<td class="' + (mine ? 'mine' : '') + (value === 0 ? ' zero' : '') + '">' + Number(value) + '</td>';
        if (mine && options[c.key] !== undefined && you.canScore) {
          return '<td class="mine pick' + (picked === c.key ? ' picked' : '') + '" data-key="' + c.key + '" role="button" tabindex="0" aria-label="' + escapeHtml(c.label) + ' ' + Number(options[c.key]) + '점 기록 칸 고르기">' + Number(options[c.key]) + '</td>';
        }
        return '<td class="empty' + (mine ? ' mine' : '') + '">-</td>';
      }).join('');
      return '<tr><td class="cat" title="' + escapeHtml(c.hint) + '">' + escapeHtml(c.label) + '</td>' + cells + '</tr>';
    }).join('') + '</tbody>';
    var foot = '<tfoot><tr><th class="cat">합계</th>' + board.map(function (b) { return '<td>' + Number(b.total) + '</td>'; }).join('') + '</tr></tfoot>';
    return head + body + foot;
  }

  function resultHtml() {
    var result = state.result;
    if (!result) return '';
    var rows = result.ranking.map(function (r) {
      return '<li class="' + (r.rank === 1 ? 'first' : '') + '"><i>' + (r.rank === 1 ? '🏆' : r.rank + '위') + '</i><span>' + escapeHtml(r.nickname) + '</span><b>' + Number(r.total) + '점</b></li>';
    }).join('');
    return '<b>' + escapeHtml(result.message) + '</b>' + (rows ? '<ol>' + rows + '</ol>' : '');
  }

  function render() {
    document.body.dataset.phase = state.phase;
    var you = state.you;
    var playing = state.phase === 'playing';
    var lobby = !playing;
    $('phase').textContent = PHASE[state.phase] || state.phase;
    $('round').textContent = playing && state.round ? state.round + ' / ' + state.rounds : '-';

    // 고른 칸이 이제는 못 고르는 칸(차례가 넘어감·이미 기록)이면 선택을 푼다.
    if (picked && !(you.canScore && you.options && you.options[picked] !== undefined)) picked = null;

    var board = state.board;
    var showGame = board.length > 0 && (playing || !!state.result);
    $('rules').classList.toggle('hidden', showGame);
    $('game-view').classList.toggle('hidden', !showGame);
    $('lobby').classList.toggle('hidden', !lobby);
    $('turn-controls').classList.toggle('hidden', !(playing && you.inGame));

    $('ready').textContent = you.ready ? '준비 취소' : '준비';
    $('start').disabled = !state.canStart;

    var turnName = '';
    state.board.forEach(function (b) { if (b.id === state.turnId) turnName = b.nickname; });
    var message;
    if (playing) {
      if (!you.inGame) message = '진행 중인 게임을 구경하고 있습니다. 다음 게임부터 참여할 수 있습니다.';
      else if (you.myTurn) {
        message = !state.rolled ? '내 차례입니다. 주사위를 굴려 주세요.'
          : state.rollsLeft > 0 ? '다시 굴릴 거면 남길 주사위를 눌러 고정하세요. 마치려면 점수판에서 칸을 골라 기록하세요. (남은 굴림 ' + state.rollsLeft + '번)'
            : '굴림을 모두 썼습니다. 점수판에서 칸을 골라 기록하세요.';
      } else message = turnName + '님의 차례입니다.';
      if (state.paused) message += ' 차례인 사람의 화면이 가려져 있어 제한시간이 멈췄습니다.';
    } else {
      message = state.canStart
        ? '준비한 ' + state.readyCount + '명으로 새 게임을 시작할 수 있습니다.'
        : state.readyCount > state.maxPlayers
          ? '야추다이스는 ' + state.maxPlayers + '명까지 할 수 있습니다. 준비한 사람을 ' + state.maxPlayers + '명 이하로 맞춰 주세요. (현재 ' + state.readyCount + '명)'
          : '준비한 참가자가 ' + state.minPlayers + '명 이상이면 누구나 시작할 수 있습니다. 혼자서도 할 수 있어요. (현재 ' + state.readyCount + '명)';
      if (state.result) message = state.result.message + ' 지난 판 참가자는 자동으로 준비됩니다. 빠지려면 준비를 취소하고, 구경한 사람은 준비를 눌러 주세요.' + (state.canStart ? '' : ' (준비 ' + state.readyCount + '명)');
    }
    $('message').textContent = message;
    renderTimer();

    setHtml('players', state.players.map(function (p) {
      var status;
      if (p.connected === false) status = '끊김';
      else if (lobby) status = p.ready ? '준비' : '대기';
      else if (!p.inGame) status = '구경';
      else status = p.id === state.turnId ? '차례' : '대기';
      var total = '';
      state.board.forEach(function (b) { if (b.id === p.id) total = b.total + '점'; });
      var initial = Array.from(p.nickname)[0] || '나';
      return '<div class="player' + (playing && p.id === state.turnId ? ' turn' : '') + '" data-id="' + p.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(p.nickname)
        + (p.id === you.id ? ' (나)' : '') + '</b><small>' + total + '</small><span class="status">' + status + '</span></div>';
    }).join(''));

    if (showGame) {
      var resultBox = $('result');
      resultBox.classList.toggle('hidden', !state.result);
      setHtml('result', resultHtml());
      $('dice-area').classList.toggle('hidden', !playing);
      if (playing) {
        // 접속·재접속 때 처음 받은 상태는 이미 지난 굴림이다. 그 뒤에 굴림 횟수나 차례가 바뀌었을 때만 구른다.
        var rollKey = state.turnId + ':' + state.round + ':' + state.rollsLeft;
        var fresh = drawn.rollKey !== undefined && drawn.rollKey !== rollKey && state.rolled;
        drawn.rollKey = rollKey;
        setHtml('dice', diceHtml(fresh));
        $('dice-note').textContent = state.rolled ? '굴림 ' + (state.rolls - state.rollsLeft) + '/' + state.rolls + (state.rollsLeft > 0 ? ' · ' + turnName + '님 차례' : ' · 점수를 기록하세요') : turnName + '님이 아직 굴리지 않았습니다.';
      }
      setHtml('sheet', sheetHtml());
    }

    // 굴리기 / 기록 버튼
    var canRoll = you.canRoll;
    $('roll').disabled = !canRoll;
    $('roll').textContent = !state.rolled ? '주사위 굴리기' : state.rollsLeft > 0 ? '다시 굴리기 (' + state.rollsLeft + '번 남음)' : '굴림을 모두 썼습니다';
    var points = picked && you.options ? you.options[picked] : null;
    $('score').disabled = picked === null || !you.canScore;
    $('score').textContent = picked !== null && points !== null && points !== undefined ? labelOf(picked) + '에 ' + points + '점 기록' : (you.canScore ? '기록할 칸을 고르세요' : '먼저 굴려 주세요');

    setHtml('history', state.history.slice().reverse().map(function (item) { return '<div>' + escapeHtml(item.text) + '</div>'; }).join(''));
    renderStartConfirm();
    // 답을 기다리는 버튼은 위에서 다시 켜졌어도 잠가 둔다.
    sending.forEach(function (entry) { entry.button.disabled = true; });
  }

  /** 남은 시간. 서버 시계 기준으로 세고, 화면을 가려 멈춘 동안은 멈춘 시각을 지금으로 본다. */
  function renderTimer() {
    var chip = $('status-chip');
    if (!state || state.phase !== 'playing' || !state.turnEndsAt) {
      chip.textContent = state && state.phase === 'playing' ? '진행 중' : '1~6명';
      chip.classList.remove('low');
      return;
    }
    var now = state.pausedAt !== null && state.pausedAt !== undefined ? state.pausedAt : Date.now() + skew;
    var seconds = Math.max(0, Math.ceil((state.turnEndsAt - now) / 1000));
    chip.textContent = (state.paused ? '멈춤 · ' : '') + '남은 시간 ' + seconds + '초';
    chip.classList.toggle('low', seconds <= 10 && !state.paused);
  }
  setInterval(function () { if (state) renderTimer(); }, 500);

  $('ready').onclick = function () {
    markSending($('ready'), changedFrom(state, function (s) { return s.you.ready; }));
    send('ready', { ready: !state.you.ready });
  };
  $('leave').onclick = function (event) { event.preventDefault(); if (socket) socket.leave(); };
  $('start').onclick = function () { startConfirmOpen = true; renderStartConfirm(); };
  $('start-cancel').onclick = closeStartConfirm;
  $('start-go').onclick = function () { closeStartConfirm(); send('start'); };
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && startConfirmOpen) closeStartConfirm(); });

  $('roll').onclick = function () {
    markSending($('roll'), changedFrom(state, function (s) { return s.rollsLeft; }));
    send('roll');
  };
  $('score').onclick = function () {
    if (picked === null) return;
    var key = picked;
    markSending($('score'), function (next) { return next.phase !== 'playing' || next.turnId !== state.turnId || (next.you && !next.you.myTurn); });
    send('score', { category: key });
  };

  // 주사위를 누르면 고정/해제. 눌리는 즉시 화면에 반영하고(서버 왕복을 기다리지 않는다) 서버에 알린다.
  $('dice').addEventListener('click', function (event) {
    var die = event.target.closest ? event.target.closest('.die') : null;
    if (!die || !state || !die.classList.contains('pick')) return;
    var next = state.held.slice();
    var i = Number(die.getAttribute('data-i'));
    next[i] = !next[i];
    state.held = next;
    render();
    send('hold', { held: next });
  });
  // 점수판의 칸을 누르면 고른다(기록은 아래 버튼으로 한 번 더 확인한다).
  function pickCell(cell) {
    if (!cell || !state || !cell.classList.contains('pick')) return;
    var key = cell.getAttribute('data-key');
    picked = picked === key ? null : key;
    render();
  }
  $('sheet').addEventListener('click', function (event) { pickCell(event.target.closest ? event.target.closest('td') : null); });
  $('sheet').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var cell = event.target.closest ? event.target.closest('td') : null;
    if (cell && cell.classList.contains('pick')) { event.preventDefault(); pickCell(cell); }
  });

  document.querySelectorAll('button[data-help]').forEach(function (button) {
    function showHelp() { $('action-help').textContent = button.dataset.help; }
    button.addEventListener('mouseenter', showHelp);
    button.addEventListener('focus', showHelp);
    button.addEventListener('touchstart', showHelp, { passive: true });
  });

  // 연결·재접속·확인·보스 키 알림은 public/game-socket.js가 한다. 여기서는 야추다이스 메시지만 처리한다.
  socket = window.GameSocket.open({
    game: 'yacht',
    tokenKey: TOKEN_KEY,
    nickname: nickname,
    onMessage: function (data) {
      if (data.type === 'error') { releaseSending(); showError(data.message); if (state) render(); return; }
      if (data.type === 'yachtState') {
        skew = data.serverTime - Date.now();
        releaseSending(data);
        state = data;
        render();
      }
    }
  });
}());
