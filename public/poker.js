(function () {
  'use strict';

  var NAME_KEY = 'game-portal-nickname';
  var TOKEN_KEY = 'poker-game-token';
  var nickname = sessionStorage.getItem(NAME_KEY);
  if (!nickname) { location.href = '/'; return; }

  var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = null;
  var reconnectTimer = null;
  var reconnectDelay = 500;
  var superseded = false;
  var state = null;
  var donationTarget = null;
  var leaving = false;

  function $(id) { return document.getElementById(id); }

  /**
   * 참가 토큰은 "이 창이 누구인가"를 말하는 값이다. localStorage에 두면 같은 기기의
   * 모든 탭이 같은 값을 공유해서, 탭을 두 개 열거나 포털을 거쳐 다시 들어오기만 해도
   * 두 창이 같은 참가자로 붙는다. 그러면 서버가 먼저 붙어 있던 창을 replaced로 끊고,
   * 그 창은 영영 재접속을 포기한다(사용자에겐 "오류가 뜨고 목록에서 사라짐"으로 보인다).
   * 닉네임과 마찬가지로 탭 단위인 sessionStorage에 둔다(라이어 게임 public/app.js와 동일).
   */
  var memoryToken = null;
  function readToken() {
    if (memoryToken) return memoryToken;
    try { return sessionStorage.getItem(TOKEN_KEY); } catch (error) { return null; }
  }
  function saveToken(value) {
    memoryToken = value;
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (error) { /* 사생활 보호 모드 - memoryToken으로 버틴다 */ }
  }

  function send(type, extra) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(Object.assign({ type: type }, extra || {})));
  }
  function money(value) { return Number(value || 0).toLocaleString() + '원'; }

  /**
   * 레이즈 하한(= 직전 사람이 올린 폭)을 입력창에 그대로 반영한다.
   *
   * 서버가 거절하긴 하지만, 그것만으로는 얼마부터 되는지 알 수가 없어서 눌러 보고
   * 빨간 토스트를 보는 수밖에 없었다. 하한이 올라가면 기본값도 같이 끌어올린다.
   * 사용자가 하한보다 큰 값을 직접 적어 뒀다면 그건 건드리지 않는다.
   */
  var lastRaiseFloor = null;
  function syncRaiseFloor(floor) {
    var input = $('raise-amount');
    var min = Number(floor) > 0 ? Number(floor) : 100;
    input.min = String(min);
    input.step = '100';
    input.setAttribute('aria-label', '레이즈 금액 (최소 ' + money(min) + ')');
    if (lastRaiseFloor !== min || Number(input.value) < min) input.value = String(min);
    lastRaiseFloor = min;
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
   * 스스로 회복할 수 없는 상태(같은 참가자로 다른 창이 붙어 이 창이 밀려난 경우).
   * 예전에는 3초짜리 토스트만 띄우고 끝이라, 사용자는 왜 아무것도 안 되는지 모른 채
   * 죽은 화면을 보고 있어야 했다. 사라지지 않는 안내와 되돌아갈 버튼을 같이 준다.
   */
  var fatalShown = false;
  function showFatal(text) {
    if (fatalShown) return;
    fatalShown = true;
    var box = document.createElement('div');
    box.id = 'fatal';
    box.setAttribute('role', 'alert');
    var line = document.createElement('p');
    line.textContent = text;
    var again = document.createElement('button');
    again.type = 'button';
    again.textContent = '이 창에서 다시 접속';
    again.onclick = function () { location.reload(); };
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'secondary';
    back.textContent = '목록으로';
    back.onclick = function () { location.href = '/'; };
    box.appendChild(line);
    box.appendChild(again);
    box.appendChild(back);
    document.body.appendChild(box);
  }
  /**
   * 끊긴 동안 화면이 살아 있는 척하지 않게 한다. 예전에는 3초짜리 토스트가 사라지고 나면
   * 버튼이 전부 눌리는 상태로 남아서, 콜이나 폴드를 눌러도 아무 일도 일어나지 않았다.
   */
  function setOffline(offline) {
    if (offline) document.body.setAttribute('data-offline', '');
    else document.body.removeAttribute('data-offline');
  }
  /**
   * 재시도 간격을 사람마다 흩뜨린다. Vercel 함수가 재활용되거나 Render가 재배포되면
   * 붙어 있던 사람이 전부 같은 순간에 끊기는데, 지터가 없으면 그 인원이 5초마다
   * 한꺼번에 다시 두드려 막 올라온 서버를 다시 넘어뜨린다.
   */
  function nextDelay() { return Math.round(reconnectDelay * (0.7 + Math.random() * 0.6)); }

  function connect() {
    if (leaving || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    ws = new WebSocket(protocol + '//' + location.host + '/api/ws?game=poker');
    ws.onopen = function () {
      reconnectDelay = 500;
      setOffline(false);
      send('join', { nickname: nickname, token: readToken() });
    };
    ws.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (error) { return; }
      if (data.type === 'welcome') { saveToken(data.token); return; }
      if (data.type === 'replaced') {
        superseded = true;
        setOffline(true);
        showFatal('다른 창에서 같은 참가자로 접속해 이 창의 연결이 닫혔습니다.');
        return;
      }
      if (data.type === 'left') { saveToken(null); location.href = '/'; return; }
      if (data.type === 'error') { showError(data.message); return; }
      if (data.type === 'pokerState') { state = data; render(); }
    };
    ws.onerror = function () { /* onclose에서 한 번만 복구한다. */ };
    ws.onclose = function () {
      if (leaving) { location.href = '/'; return; }
      if (superseded) return;
      setOffline(true);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, nextDelay());
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
  }

  function cardLabel(card) {
    if (card.hidden) return '';
    var labels = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
    return (labels[card.rank] || card.rank) + card.suit;
  }

  function renderProposal() {
    var proposal = state.baseBetProposal;
    $('proposal').classList.toggle('hidden', !proposal || proposal.yourVote);
    if (!proposal) return;
    $('proposal-title').textContent = proposal.proposerName + '님이 ' + money(proposal.amount) + '을 제안했습니다.';
    $('proposal-count').textContent = '찬성 ' + proposal.agreed + '명 · 투표 ' + proposal.voted + '/' + proposal.total + '명';
  }

  function render() {
    document.body.dataset.phase = state.phase;
    var you = state.players.find(function (player) { return player.id === state.you.id; });
    var lobby = state.phase === 'lobby' || state.phase === 'result';
    var myTurn = state.turnPlayerId === state.you.id;
    $('pot').textContent = money(state.pot);
    $('base-label').textContent = '기본 ' + money(state.baseBet);
    $('base-bet').value = state.baseBet;
    $('phase').textContent = { lobby: '대기 중', betting: '배팅 중', showdown: '쇼다운', result: '라운드 종료' }[state.phase] || state.phase;
    $('lobby').classList.toggle('hidden', !lobby);
    $('betting').classList.toggle('hidden', state.phase !== 'betting');
    $('ready').textContent = you.ready ? '준비 취소' : '준비';
    $('start').disabled = !state.canStart;
    $('set-bet').disabled = !!state.baseBetProposal;
    $('betting').querySelectorAll('button').forEach(function (button) { button.disabled = !myTurn; });
    $('allin').disabled = !myTurn || state.allInCap !== null;
    $('raise').disabled = !myTurn || state.allInCap !== null;
    $('call').textContent = '콜 · ' + money(Math.max(0, state.currentBet - you.roundBet));
    syncRaiseFloor(state.minRaise);

    // 시작 버튼이 꺼져 있으면 그 이유를 그대로 말해 준다. 예전에는 "방장만 시작"이라는
    // 숨은 규칙 때문에 회색 버튼만 보이고 이유를 알 수 없었다(이제 아무나 시작할 수 있다).
    var message = '참가자들이 준비하면 시작할 수 있습니다.';
    if (lobby) {
      message = state.canStart
        ? '준비한 ' + state.readyCount + '명으로 새 판을 시작할 수 있습니다.'
        : '준비한 참가자가 ' + state.minPlayers + '명 이상이면 누구나 시작할 수 있습니다. (현재 '
          + state.readyCount + '명)';
    }
    if (state.phase === 'betting') {
      var turnPlayer = state.players.find(function (player) { return player.id === state.turnPlayerId; });
      message = turnPlayer ? '현재 ' + turnPlayer.nickname + '님의 배팅 차례입니다.' + (myTurn ? ' 상대 카드와 배팅을 확인하세요.' : '') : '배팅을 진행하고 있습니다.';
      if (!state.you.inRound) message = '진행 중인 판을 관전하고 있습니다. 다음 판부터 참여할 수 있습니다.';
      else if (you.isFolded) message = '폴드했습니다. 남은 판을 관전하고 있습니다.';
    }
    if (state.result) message = state.result.noWinner ? state.result.message : state.result.nickname + '님이 ' + money(state.result.amount) + '을 획득했습니다.';
    $('message').textContent = message;

    $('players').innerHTML = state.players.map(function (player) {
      var waiting = state.phase === 'betting' && !player.inRound;
      var status = waiting ? '다음 판 대기' : player.isFolded ? '폴드' : player.isAllIn ? '올인' : player.ready ? '준비' : '대기';
      var initial = Array.from(player.nickname)[0] || '나';
      return '<div class="player ' + (player.id === state.turnPlayerId ? 'turn' : '') + '" role="button" tabindex="0" title="대기 중 선택하면 기부할 수 있습니다" data-id="' + player.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(player.nickname) + (player.id === state.you.id ? ' (나)' : '') + '</b><small>' + money(player.chips) + ' · 배팅 ' + money(player.roundBet) + '</small><span class="status">' + status + '</span></div>';
    }).join('');

    var canSeeTable = state.phase !== 'betting' || (state.you.inRound && !you.isFolded);
    $('cards').innerHTML = (canSeeTable ? state.players : []).filter(function (player) { return player.card; }).map(function (player) {
      var red = !player.card.hidden && (player.card.suit === '♥' || player.card.suit === '♦');
      return '<div class="seat ' + (player.isFolded ? 'folded' : '') + '"><div class="card ' + (player.card.hidden ? 'hidden-card ' : '') + (red ? 'red' : '') + '">' + cardLabel(player.card) + '</div><b>' + escapeHtml(player.nickname) + '</b></div>';
    }).join('');

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
  }

  $('ready').onclick = function () { send('ready', { ready: !state.players.find(function (p) { return p.id === state.you.id; }).ready }); };
  $('leave').onclick = function (event) {
    event.preventDefault();
    if (leaving) return;
    leaving = true;
    clearTimeout(reconnectTimer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      send('leave');
      setTimeout(function () { location.href = '/'; }, 1200);
    } else {
      saveToken(null);
      location.href = '/';
    }
  };
  $('set-bet').onclick = function () { send('baseBet', { amount: Number($('base-bet').value) }); };
  $('proposal-yes').onclick = function () { send('baseBetVote', { proposalId: state.baseBetProposal.id, agree: true }); };
  $('proposal-no').onclick = function () { send('baseBetVote', { proposalId: state.baseBetProposal.id, agree: false }); };
  $('start').onclick = function () { send('start'); };
  $('call').onclick = function () { send('call'); };
  $('raise').onclick = function () { send('raise', { amount: Number($('raise-amount').value) }); };
  $('allin').onclick = function () { send('allin'); };
  $('fold').onclick = function () { send('fold'); };
  $('donate-send').onclick = function () { send('donate', { targetId: donationTarget, amount: Number($('donate-amount').value) }); $('donate').classList.add('hidden'); };
  document.querySelectorAll('button[data-help]').forEach(function (button) {
    function showHelp() { $('action-help').textContent = button.dataset.help; }
    button.addEventListener('mouseenter', showHelp);
    button.addEventListener('focus', showHelp);
    button.addEventListener('touchstart', showHelp, { passive: true });
  });
  document.addEventListener('click', function (event) { if (!$('donate').contains(event.target)) $('donate').classList.add('hidden'); });
  // 화면을 전환하거나 백그라운드로 내리면 브라우저가 조용히 소켓을 끊는다. 다시
  // 보이는 순간 재시도 대기를 건너뛰고 바로 다시 붙는다.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    reconnectDelay = 500;
    connect();
  });
  setInterval(function () { send('ping'); }, 20000);
  connect();
}());
