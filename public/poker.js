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
  var state = null;
  var donationTarget = null;
  var leaving = false;

  function $(id) { return document.getElementById(id); }
  function send(type, extra) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(Object.assign({ type: type }, extra || {})));
  }
  function money(value) { return Number(value || 0).toLocaleString() + '원'; }
  function escapeHtml(value) { var el = document.createElement('div'); el.textContent = value; return el.innerHTML; }
  function showError(text) {
    $('error').textContent = text;
    $('error').style.display = 'block';
    setTimeout(function () { $('error').style.display = 'none'; }, 3000);
  }

  function connect() {
    if (leaving || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    ws = new WebSocket(protocol + '//' + location.host + '/api/ws?game=poker');
    ws.onopen = function () {
      reconnectDelay = 500;
      send('join', { nickname: nickname, token: localStorage.getItem(TOKEN_KEY) });
    };
    ws.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (error) { return; }
      if (data.type === 'welcome') { localStorage.setItem(TOKEN_KEY, data.token); return; }
      if (data.type === 'left') { localStorage.removeItem(TOKEN_KEY); location.href = '/'; return; }
      if (data.type === 'error') { showError(data.message); return; }
      if (data.type === 'pokerState') { state = data; render(); }
    };
    ws.onerror = function () { /* onclose에서 한 번만 복구한다. */ };
    ws.onclose = function () {
      if (leaving) { location.href = '/'; return; }
      showError('서버에 다시 연결하고 있습니다.');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay);
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

    var message = '참가자들이 준비하면 시작할 수 있습니다.';
    if (state.phase === 'betting') {
      var turnPlayer = state.players.find(function (player) { return player.id === state.turnPlayerId; });
      message = turnPlayer ? '현재 ' + turnPlayer.nickname + '님의 배팅 차례입니다.' + (myTurn ? ' 상대 카드와 배팅을 확인하세요.' : '') : '배팅을 진행하고 있습니다.';
    }
    if (state.result) message = state.result.noWinner ? state.result.message : state.result.nickname + '님이 ' + money(state.result.amount) + '을 획득했습니다.';
    $('message').textContent = message;

    $('players').innerHTML = state.players.map(function (player) {
      var status = player.isFolded ? '폴드' : player.isAllIn ? '올인' : player.ready ? '준비' : '대기';
      var initial = Array.from(player.nickname)[0] || '나';
      return '<div class="player ' + (player.id === state.turnPlayerId ? 'turn' : '') + '" data-id="' + player.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(player.nickname) + (player.id === state.you.id ? ' (나)' : '') + '</b><small>' + money(player.chips) + ' · 배팅 ' + money(player.roundBet) + '</small><span class="status">' + status + '</span></div>';
    }).join('');

    $('cards').innerHTML = state.players.filter(function (player) { return player.card; }).map(function (player) {
      var red = !player.card.hidden && (player.card.suit === '♥' || player.card.suit === '♦');
      return '<div class="seat ' + (player.isFolded ? 'folded' : '') + '"><div class="card ' + (player.card.hidden ? 'hidden-card ' : '') + (red ? 'red' : '') + '">' + cardLabel(player.card) + '</div><b>' + escapeHtml(player.nickname) + '</b></div>';
    }).join('');

    $('history').innerHTML = state.history.slice().reverse().map(function (item) { return '<div>' + escapeHtml(item.text) + '</div>'; }).join('');
    document.querySelectorAll('.player').forEach(function (element) {
      element.oncontextmenu = function (event) {
        event.preventDefault();
        if (state.phase !== 'lobby' && state.phase !== 'result') { showError('기부는 대기 중에만 할 수 있습니다.'); return; }
        if (element.dataset.id === state.you.id) return;
        donationTarget = element.dataset.id;
        var target = state.players.find(function (player) { return player.id === donationTarget; });
        $('donate-name').textContent = target.nickname + '님에게';
        $('donate').style.left = Math.min(event.clientX, innerWidth - 190) + 'px';
        $('donate').style.top = Math.min(event.clientY, innerHeight - 150) + 'px';
        $('donate').classList.remove('hidden');
      };
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
      localStorage.removeItem(TOKEN_KEY);
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
  setInterval(function () { send('ping'); }, 20000);
  connect();
}());
