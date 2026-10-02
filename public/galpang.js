/**
 * 갈팡질팡 화면. 규칙·정답·힌트 판단은 전부 서버(web/galpang-room.js)가 한다 - 이 화면은 받은 상태를 그리고
 * 조작을 "명령어 한 줄"(remove 3 5, guess 5, next …)로 바꿔 서버에 전할 뿐이다. 정답은 게임이 끝나기 전에는
 * 이 브라우저에 오지 않는다. 연결 유지·재접속은 public/game-socket.js가 한다(다른 카드 게임과 같다).
 */
(function () {
  'use strict';

  var NAME_KEY = 'game-portal-nickname';
  var TOKEN_KEY = 'galpang-game-token';
  var nickname = sessionStorage.getItem(NAME_KEY);
  if (!nickname) { location.href = '/'; return; }

  var state = null;
  var selected = [];        // 고른 후보 번호
  var seenSeq = null;       // 이미 보여 준 결과 글의 번호. 처음 받은 상태의 글은 이미 지난 일이다.
  var logLines = [];
  var lastRound = 0;
  var socket = null;
  var LOG_MAX = 120;

  function $(id) { return document.getElementById(id); }
  function escapeHtml(value) { var el = document.createElement('div'); el.textContent = value; return el.innerHTML; }

  var errorTimer = null;
  function showError(text) {
    $('error').textContent = text;
    $('error').style.display = 'block';
    clearTimeout(errorTimer);
    errorTimer = setTimeout(function () { $('error').style.display = 'none'; }, 3000);
  }

  /** 내용이 바뀔 때만 다시 그린다(깜빡임·스크롤 위치 유지). */
  var drawn = {};
  function setHtml(id, html) {
    if (drawn[id] === html) return;
    drawn[id] = html;
    $(id).innerHTML = html;
  }

  function send(line) {
    if (!socket) return;
    appendLog('> ' + line);
    socket.send('command', { line: line });
  }

  function appendLog(text) {
    logLines.push(text);
    if (logLines.length > LOG_MAX) logLines = logLines.slice(logLines.length - LOG_MAX);
    var log = $('log');
    log.textContent = logLines.join('\n');
    log.scrollTop = log.scrollHeight;
  }

  // ─────────────────────────── 그리기 ───────────────────────────

  function hintsHtml(s) {
    return s.hints.map(function (hint, index) {
      var latest = index === s.hints.length - 1 && s.status === 'PLAYING';
      function option(letter, text) {
        return '<div class="hint-option' + (hint.selected === letter ? ' picked' : '') + '"><i>' + letter + '</i><span>' + escapeHtml(text) + '</span></div>';
      }
      return '<div class="hint-card' + (latest ? ' latest' : '') + '"><b>ROUND ' + hint.round + '</b>'
        + option('A', hint.optionA) + option('B', hint.optionB)
        + '<small>정답에 더 가까운 쪽: ' + hint.selected + '</small></div>';
    }).join('');
  }

  function gridHtml(s) {
    var live = s.status === 'PLAYING';
    var answerId = s.summary ? s.summary.answer.id : 0; // 끝난 뒤에만 서버가 알려 준다
    return s.candidates.map(function (candidate) {
      var picked = selected.indexOf(candidate.id) >= 0;
      var classes = 'cand' + (picked ? ' selected' : '') + (candidate.removed ? ' removed' : '') + (candidate.wrong ? ' wrong' : '')
        + (candidate.id === answerId ? ' answer' : '');
      return '<button type="button" class="' + classes + '" data-id="' + candidate.id + '" aria-pressed="' + picked + '"'
        + (!live || candidate.removed ? ' disabled' : '') + '><span class="no">' + candidate.id + '</span>' + escapeHtml(candidate.name) + (candidate.removed ? '<span class="sr"> (제거됨)</span>' : '') + '</button>';
    }).join('');
  }

  function resultHtml(s) {
    if (s.status === 'PLAYING') return '';
    if (s.status === 'QUIT') return '<h2>게임을 종료했습니다</h2><p class="detail">포기한 게임의 정답은 공개하지 않습니다. 다시 시작하면 새로운 후보로 게임을 할 수 있습니다.</p>';
    var summary = s.summary;
    if (!summary) return '';
    var title = summary.won ? '정답입니다!' : summary.how === 'wrong' ? '오답입니다' : summary.how === 'removed' ? '정답 후보를 지웠습니다' : '게임 종료';
    var detail = summary.won
      ? summary.round + '라운드 만에 성공했습니다.'
      : summary.how === 'wrong'
        ? '제출한 답: ' + summary.guessed.id + '번 ' + summary.guessed.name + ' - 정답이 아니어서 ' + summary.round + '라운드에서 게임이 끝났습니다.'
        : summary.how === 'removed'
          ? '정답(' + summary.answer.id + '번 ' + summary.answer.name + ')을 지워서 ' + summary.round + '라운드에서 게임이 끝났습니다.'
          : summary.maxRound + '라운드 안에 정답을 맞히지 못했습니다.';
    var items = summary.explanations.map(function (hint) {
      return '<li><b>ROUND ' + hint.round + '</b>A. ' + escapeHtml(hint.optionA) + ' / B. ' + escapeHtml(hint.optionB) + ' → <em>' + hint.selected + '</em>'
        + '<span>' + escapeHtml(hint.reason) + '</span></li>';
    }).join('');
    return '<h2>' + title + '</h2><p class="answer">정답: ' + escapeHtml(summary.answer.name) + '</p><p class="detail">' + detail + '</p><ol>' + items + '</ol>';
  }

  function messageFor(s) {
    if (s.status === 'WON') return '정답을 맞혔습니다!';
    if (s.status === 'LOST') {
      var how = s.summary && s.summary.how;
      return how === 'wrong' ? '틀린 답을 제출해서 게임이 끝났습니다.' : how === 'removed' ? '정답 후보를 지워서 게임이 끝났습니다.' : s.maxRound + '라운드가 끝났습니다.';
    }
    if (s.status === 'QUIT') return '게임을 종료했습니다.';
    return 'ROUND ' + s.round + ' - 힌트를 보고 아닌 후보를 지우거나, 정답을 제출하세요.';
  }

  function render() {
    var s = state;
    var live = s.status === 'PLAYING';
    document.body.setAttribute('data-status', s.status);
    selected = selected.filter(function (id) {
      var candidate = s.candidates[id - 1];
      return live && candidate && !candidate.removed;
    });

    $('phase').textContent = live ? '진행 중' : s.status === 'WON' ? '정답!' : s.status === 'LOST' ? '실패' : '종료';
    $('round').textContent = s.round + ' / ' + s.maxRound;
    $('status-chip').textContent = '후보 ' + s.remaining + '개';
    $('message').textContent = messageFor(s);
    setHtml('hints', hintsHtml(s));
    setHtml('grid', gridHtml(s));
    var result = $('result');
    var html = resultHtml(s);
    setHtml('result', html);
    result.className = 'result' + (html ? '' : ' hidden') + (s.status === 'WON' ? ' won' : s.status === 'LOST' ? ' lost' : '');
    $('rules').classList.toggle('hidden', !live);

    $('live-controls').classList.toggle('hidden', !live);
    $('end-controls').classList.toggle('hidden', live);
    $('remove').disabled = selected.length === 0;
    $('remove').textContent = selected.length ? '후보 제거 (' + selected.length + ')' : '후보 제거';
    $('guess').disabled = selected.length !== 1;
    $('next').textContent = s.round >= s.maxRound ? '마지막 라운드 끝내기' : '다음 라운드';
    $('quit-confirm').classList.toggle('hidden', !s.pendingQuit);
    if (!live) { $('guess-confirm').classList.add('hidden'); $('next-confirm').classList.add('hidden'); }

    // 새 힌트가 나오면 띠(폰)의 맨 끝이 보이게 한다.
    if (s.round !== lastRound) {
      lastRound = s.round;
      var strip = $('hints');
      strip.scrollLeft = strip.scrollWidth;
    }
  }

  /** 명령 결과 글. 짧은 안내("3번 제거", "오답입니다.")는 판 아래에 바로 보이고, 전부 기록에 남는다. */
  function showOutput(output, roundChanged) {
    output.lines.forEach(function (line) { appendLog(line); });
    var plain = output.lines.filter(function (line) { return line.trim(); });
    var decorated = plain.some(function (line) { return /^[[=-]/.test(line); });
    var text = roundChanged ? 'ROUND ' + state.round + ' 힌트가 나왔습니다.' : (!decorated && plain.length <= 3 ? plain.join(' · ') : '');
    $('notice').textContent = text;
  }

  // ─────────────────────────── 조작 ───────────────────────────

  $('grid').addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('button.cand') : null;
    if (!button || button.disabled || !state) return;
    var id = Number(button.getAttribute('data-id'));
    var at = selected.indexOf(id);
    if (at >= 0) selected.splice(at, 1); else selected.push(id);
    render();
  });
  function takeSelection() {
    var numbers = selected.slice().sort(function (a, b) { return a - b; });
    selected = [];
    return numbers;
  }
  $('remove').onclick = function () {
    var numbers = takeSelection();
    if (numbers.length) send('remove ' + numbers.join(' '));
    if (state) render();
  };
  // 정답 제출은 되돌릴 수 없다(틀리면 바로 끝난다). 바로 옆의 "후보 제거"와 헷갈려 누르지 않게 한 번 더 묻는다.
  var guessPick = 0;
  function closeGuessConfirm() { $('guess-confirm').classList.add('hidden'); guessPick = 0; }
  $('guess').onclick = function () {
    if (!state || selected.length !== 1) return;
    guessPick = selected[0];
    $('guess-confirm-name').textContent = guessPick + '번 · ' + state.candidates[guessPick - 1].name;
    $('guess-confirm').classList.remove('hidden');
  };
  $('guess-no').onclick = closeGuessConfirm;
  $('guess-yes').onclick = function () {
    var pick = guessPick;
    closeGuessConfirm();
    if (pick) { selected = []; send('guess ' + pick); }
    if (state) render();
  };
  $('next').onclick = function () {
    if (state && state.round >= state.maxRound) { $('next-confirm').classList.remove('hidden'); return; }
    send('next');
  };
  $('next-no').onclick = function () { $('next-confirm').classList.add('hidden'); };
  $('next-yes').onclick = function () { $('next-confirm').classList.add('hidden'); send('next'); };
  // 포기: 서버가 "종료하시겠습니까?"를 묻는 상태(pendingQuit)가 되면 확인 창이 뜬다. 답은 y/n으로 보낸다.
  $('quit').onclick = function () { send('quit'); };
  $('quit-yes').onclick = function () { send('y'); };
  $('quit-no').onclick = function () { send('n'); };
  $('restart').onclick = function () { selected = []; send('restart'); };
  $('leave').onclick = function (event) { event.preventDefault(); if (socket) socket.leave(); };
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!$('guess-confirm').classList.contains('hidden')) closeGuessConfirm();
    else if (!$('next-confirm').classList.contains('hidden')) $('next-confirm').classList.add('hidden');
    else if (state && state.pendingQuit) send('n');
  });

  // 명령어 입력. form의 submit으로 받는다 - 한글 입력기의 Enter(조합 확정)가 두 번 전송되지 않는다.
  $('command-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var input = $('command');
    var line = input.value;
    input.value = '';
    if (line.trim()) send(line);
  });

  document.querySelectorAll('button[data-help]').forEach(function (button) {
    function showHelp() { $('action-help').textContent = button.getAttribute('data-help'); }
    button.addEventListener('mouseenter', showHelp);
    button.addEventListener('focus', showHelp);
    button.addEventListener('touchstart', showHelp, { passive: true });
  });

  // 연결·재접속·확인·보스 키 알림은 public/game-socket.js가 한다. 여기서는 갈팡질팡 메시지만 처리한다.
  socket = window.GameSocket.open({
    game: 'galpang',
    tokenKey: TOKEN_KEY,
    nickname: nickname,
    onMessage: function (data) {
      if (data.type === 'error') { showError(data.message); return; }
      if (data.type !== 'galpangState') return;
      var previousRound = state ? state.round : data.round;
      state = data;
      var output = data.output;
      var fresh = !!output && seenSeq !== null && output.seq > seenSeq;
      // 글이 없는 상태는 새 게임이거나 서버가 새로 뜬 것이다 - 번호를 처음부터 다시 센다.
      seenSeq = output ? output.seq : 0;
      render();
      if (fresh) showOutput(output, data.round !== previousRound && data.status === 'PLAYING');
      else if (!output) $('notice').textContent = '';
    }
  });
}());
