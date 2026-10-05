/**
 * 갈팡질팡 화면. 규칙·정답·힌트 판단은 전부 서버(web/galpang-room.js)가 한다 - 이 화면은 받은 상태를 그리고
 * 조작을 "명령어 한 줄"(remove 3 5, guess 5, next …)로 바꿔 서버에 전할 뿐이다. 여럿이 하면 서버가 그 명령을
 * 접속자 과반수의 동의를 받는 제안으로 바꾸고, 이 화면은 제안에 찬반을 보낸다. 정답은 게임이 끝나기 전에는
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
  var seenSeq = null;       // 이미 보여 준 공통 결과 글의 번호. 처음 받은 상태의 글은 이미 지난 일이다.
  var seenReply = null;     // 나에게만 온 답(도움말·목록·입력 오류)의 번호
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
    if (!s.hints.length) return '<p class="hints-empty">게임이 시작되면 라운드마다 힌트가 나옵니다.</p>';
    return s.hints.map(function (hint, index) {
      var latest = index === s.hints.length - 1 && s.phase === 'playing';
      function option(letter, text) {
        return '<div class="hint-option' + (hint.selected === letter ? ' picked' : '') + '"><i>' + letter + '</i><span>' + escapeHtml(text) + '</span></div>';
      }
      return '<div class="hint-card' + (latest ? ' latest' : '') + '"><b>ROUND ' + hint.round + '</b>'
        + option('A', hint.optionA) + option('B', hint.optionB)
        + '<small>정답에 더 가까운 쪽: ' + hint.selected + '</small></div>';
    }).join('');
  }

  function gridHtml(s) {
    var playing = s.phase === 'playing' && s.you.inGame;
    var answerId = s.summary ? s.summary.answer.id : 0; // 끝난 뒤에만 서버가 알려 준다
    var proposed = s.proposal ? s.proposal.numbers : [];
    return s.candidates.map(function (candidate) {
      var picked = selected.indexOf(candidate.id) >= 0;
      var classes = 'cand' + (picked ? ' selected' : '') + (candidate.removed ? ' removed' : '') + (candidate.wrong ? ' wrong' : '')
        + (candidate.id === answerId ? ' answer' : '') + (proposed.indexOf(candidate.id) >= 0 ? ' proposed' : '');
      return '<button type="button" class="' + classes + '" data-id="' + candidate.id + '" aria-pressed="' + picked + '"'
        + (!playing || candidate.removed ? ' disabled' : '') + '><span class="no">' + candidate.id + '</span>' + escapeHtml(candidate.name) + (candidate.removed ? '<span class="sr"> (제거됨)</span>' : '') + '</button>';
    }).join('');
  }

  function resultHtml(s) {
    if (s.phase !== 'result') return '';
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

  function endMessage(s) {
    if (s.status === 'WON') return '정답을 맞혔습니다!';
    if (s.status === 'LOST') {
      var how = s.summary && s.summary.how;
      return how === 'wrong' ? '틀린 답을 제출해서 게임이 끝났습니다.' : how === 'removed' ? '정답 후보를 지워서 게임이 끝났습니다.' : s.maxRound + '라운드가 끝났습니다.';
    }
    return '게임을 종료했습니다.';
  }

  /** 투표 중인 사람(제안했거나 이미 투표한 사람)에게 누구를 기다리는지 보여 준다. */
  function voteMessage(vote) {
    var waiting = vote.waitingFor && vote.waitingFor.length ? ' · ' + vote.waitingFor.join(', ') + '님을 기다리는 중' : '';
    var who = vote.byId === state.you.id ? '내가 제안했습니다' : vote.byName + '님이 제안했습니다';
    return who + ' - ' + vote.text + ' · 동의 ' + vote.agreed + '/' + vote.total + '명 (과반수 ' + vote.needed + '명)' + waiting;
  }

  function messageFor(s) {
    // 진행하던 참가자가 모두 자리를 비웠다: 남은 사람이 새로 시작할 수 있다.
    if (s.phase === 'playing' && s.abandoned) {
      return '진행하던 참가자가 모두 자리를 비웠습니다. ' + (s.alone ? '게임 시작을 누르면 새로 시작합니다.' : '준비한 사람끼리 새로 시작할 수 있습니다.');
    }
    if (s.phase === 'lobby') {
      if (s.alone) return '게임 시작을 누르면 혼자 시작합니다. 다른 사람이 들어오면 준비한 사람끼리 시작합니다.';
      return s.canStart
        ? '준비한 ' + s.readyCount + '명으로 새 게임을 시작할 수 있습니다.'
        : s.readyCount > s.maxPlayers
          ? '갈팡질팡은 ' + s.maxPlayers + '명까지 할 수 있습니다. 준비한 사람을 ' + s.maxPlayers + '명 이하로 맞춰 주세요. (현재 ' + s.readyCount + '명)'
          : '준비한 참가자가 ' + s.minPlayers + '명 이상이면 누구나 시작할 수 있습니다. (현재 ' + s.readyCount + '명)';
    }
    if (s.phase === 'result') {
      return endMessage(s) + (s.alone ? ' 다시 하려면 게임 시작을 눌러 주세요.' : ' 다시 하려면 준비를 눌러 주세요.');
    }
    if (!s.you.inGame) return '진행 중인 게임을 구경하고 있습니다. 다음 게임부터 참여할 수 있습니다.' + (s.proposal ? ' · ' + voteMessage(s.proposal) : '');
    if (s.proposal) return voteMessage(s.proposal);
    return 'ROUND ' + s.round + ' - 힌트를 보고 아닌 후보를 지우거나, 정답을 제출하세요.'
      + (s.voters > 1 ? ' (판을 바꾸는 조작은 접속자 ' + s.voters + '명 중 ' + s.needed + '명 동의가 필요합니다)' : '');
  }

  function playersHtml(s) {
    return s.players.map(function (p) {
      var status;
      if (p.connected === false) status = '끊김';
      else if (s.phase === 'playing') {
        status = !p.inGame ? '구경' : !s.proposal ? '참가' : p.vote === 'yes' ? '찬성' : p.vote === 'no' ? '반대' : '투표 대기';
      } else status = p.ready ? '준비' : '대기';
      var small = s.proposal && s.proposal.byId === p.id ? '제안자' : '';
      var initial = Array.from(p.nickname)[0] || '나';
      return '<div class="player" data-id="' + p.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(p.nickname)
        + (p.id === s.you.id ? ' (나)' : '') + '</b><small>' + small + '</small><span class="status">' + status + '</span></div>';
    }).join('');
  }

  var KIND = { remove: '후보 제거', guess: '정답 제출', next: '다음 라운드', quit: '포기' };
  var WARNING = {
    remove: '정답을 지우면 바로 게임이 끝나고 정답이 공개됩니다.',
    guess: '정답 제출은 한 번뿐입니다. 틀리면 바로 게임이 끝나고 정답이 공개됩니다.',
    next: '다음 힌트를 봅니다. 마지막 라운드에서 넘어가면 게임이 끝납니다.',
    quit: '포기하면 정답은 공개되지 않고 게임이 끝납니다.'
  };
  function renderVote() {
    var vote = state.proposal;
    var show = !!vote && vote.canVote && !vote.yourVote;
    $('vote-modal').classList.toggle('hidden', !show);
    if (!vote) return;
    $('vote-kind').textContent = KIND[vote.kind] || '제안';
    $('vote-title').textContent = vote.byName + '님이 제안했습니다.';
    $('vote-text').textContent = vote.text;
    $('vote-warning').textContent = WARNING[vote.kind] || '';
    $('vote-count').textContent = '동의 ' + vote.agreed + '/' + vote.total + '명 · 과반수(' + vote.needed + '명)가 동의하면 실행됩니다.';
  }

  /** 게임 시작 전에 누가 준비를 안 했는지 먼저 보여 준다(public/mind.js와 같은 창). 혼자면 묻지 않는다. */
  var startConfirmOpen = false;
  function renderStartConfirm() {
    if (startConfirmOpen && (state.phase === 'playing' || !state.canStart)) startConfirmOpen = false;
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

  var PHASE = { lobby: '대기 중', playing: '진행 중' };

  function render() {
    var s = state;
    var playing = s.phase === 'playing' && !s.abandoned; // 참가자가 모두 떠난 판은 대기실처럼 준비·시작을 보인다
    var inGame = playing && s.you.inGame;
    var me = s.players.filter(function (p) { return p.id === s.you.id; })[0] || { ready: false };
    document.body.setAttribute('data-status', s.status);
    document.body.setAttribute('data-phase', s.phase);
    selected = selected.filter(function (id) {
      var candidate = s.candidates[id - 1];
      return inGame && candidate && !candidate.removed;
    });

    $('phase').textContent = playing ? '진행 중' : s.phase === 'lobby' || s.abandoned ? PHASE.lobby : s.status === 'WON' ? '정답!' : s.status === 'LOST' ? '실패' : '종료';
    $('round').textContent = s.phase === 'lobby' ? '-' : s.round + ' / ' + s.maxRound;
    $('status-chip').textContent = s.phase === 'lobby' ? (s.alone ? '혼자' : '준비 ' + s.readyCount + '명') : '후보 ' + s.remaining + '개';
    $('message').textContent = messageFor(s);
    setHtml('players', playersHtml(s));
    setHtml('hints', hintsHtml(s));
    setHtml('grid', gridHtml(s));
    var result = $('result');
    var html = resultHtml(s);
    setHtml('result', html);
    result.className = 'result' + (html ? '' : ' hidden') + (s.status === 'WON' ? ' won' : s.status === 'LOST' ? ' lost' : '');
    $('rules').classList.toggle('hidden', s.phase !== 'lobby');

    $('lobby').classList.toggle('hidden', playing);
    $('live-controls').classList.toggle('hidden', !inGame);
    $('ready').textContent = me.ready ? '준비 취소' : '준비';
    $('ready').classList.toggle('hidden', s.alone); // 혼자면 준비 없이 바로 시작한다
    $('start').textContent = s.phase === 'result' ? '다시 시작' : '게임 시작';
    $('start').disabled = !s.canStart;
    var voting = !!s.proposal;
    $('remove').disabled = selected.length === 0 || voting;
    $('remove').textContent = selected.length ? '후보 제거 (' + selected.length + ')' : '후보 제거';
    $('guess').disabled = selected.length !== 1 || voting;
    $('next').disabled = voting;
    $('next').textContent = s.round >= s.maxRound ? '마지막 라운드 끝내기' : '다음 라운드';
    $('quit').disabled = voting;
    $('quit-confirm').classList.toggle('hidden', !s.pendingQuit);
    if (!inGame) { $('guess-confirm').classList.add('hidden'); $('next-confirm').classList.add('hidden'); }
    renderVote();
    renderStartConfirm();

    // 새 힌트가 나오면 띠(폰)의 맨 끝이 보이게 한다.
    if (s.round !== lastRound) {
      lastRound = s.round;
      var strip = $('hints');
      strip.scrollLeft = strip.scrollWidth;
    }
  }

  /** 명령 결과 글. 짧은 안내("3번 제거", "오답입니다.")는 판 아래에 바로 보이고, 전부 기록에 남는다. */
  function showOutput(output, roundChanged) {
    if (output.title) appendLog(output.title);
    output.lines.forEach(function (line) { appendLog(line); });
    var plain = output.lines.filter(function (line) { return line.trim(); });
    var decorated = plain.some(function (line) { return /^[[=-]/.test(line); });
    var text = roundChanged ? 'ROUND ' + state.round + ' 힌트가 나왔습니다.' : (!decorated && plain.length <= 3 ? plain.join(' · ') : '');
    $('notice').textContent = (output.title && text ? output.title + ' · ' : '') + text;
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
  // 여럿이 하면 이 확인 뒤에 다른 참가자들의 동의를 받는다.
  var guessPick = 0;
  function closeGuessConfirm() { $('guess-confirm').classList.add('hidden'); guessPick = 0; }
  $('guess').onclick = function () {
    if (!state || selected.length !== 1) return;
    guessPick = selected[0];
    $('guess-confirm-name').textContent = guessPick + '번 · ' + state.candidates[guessPick - 1].name;
    $('guess-confirm-vote').textContent = state.voters > 1 ? '제안하면 접속자 과반수(' + state.needed + '명)의 동의를 받아 제출합니다.' : '';
    $('guess-yes').textContent = state.voters > 1 ? '제안하기' : '제출';
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
  $('leave').onclick = function (event) { event.preventDefault(); if (socket) socket.leave(); };

  // 준비·시작은 다른 카드 게임과 같다.
  $('ready').onclick = function () {
    if (!state) return;
    var me = state.players.filter(function (p) { return p.id === state.you.id; })[0];
    socket.send('ready', { ready: !(me && me.ready) });
  };
  $('start').onclick = function () {
    if (!state || !state.canStart) return;
    if (state.alone) { socket.send('start'); return; }
    startConfirmOpen = true;
    renderStartConfirm();
  };
  $('start-cancel').onclick = closeStartConfirm;
  $('start-go').onclick = function () { closeStartConfirm(); socket.send('start'); };

  // 제안에 대한 찬반. 내 표가 들어가거나 투표가 끝나면 창이 닫힌다(서버가 다음 상태를 보낸다).
  function vote(agree) {
    var id = state && state.proposal && state.proposal.id;
    if (id) socket.send('vote', { proposalId: id, agree: agree });
  }
  $('vote-yes').onclick = function () { vote(true); };
  $('vote-no').onclick = function () { vote(false); };

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!$('guess-confirm').classList.contains('hidden')) closeGuessConfirm();
    else if (!$('next-confirm').classList.contains('hidden')) $('next-confirm').classList.add('hidden');
    else if (startConfirmOpen) closeStartConfirm();
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
      // 글이 없는 상태는 새 대기실이거나 서버가 새로 뜬 것이다 - 번호를 처음부터 다시 센다.
      seenSeq = output ? output.seq : 0;
      var reply = data.reply;
      var freshReply = !!reply && seenReply !== null && reply.seq > seenReply;
      seenReply = reply ? reply.seq : 0;
      render();
      if (fresh) showOutput(output, data.round !== previousRound && data.status === 'PLAYING');
      if (freshReply) showOutput(reply, false);
      else if (!fresh && !output) $('notice').textContent = '';
    }
  });
}());
