(function () {
  'use strict';
  var NAME_KEY = 'game-portal-nickname';
  var TOKEN_KEY = 'blackjack-game-token';
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
  function send(type, extra) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(Object.assign({ type: type }, extra || {}))); }
  function money(value) { return Number(value || 0).toLocaleString() + '원'; }
  function escapeHtml(value) { var el = document.createElement('div'); el.textContent = value; return el.innerHTML; }
  var errorTimer = null;
  function showError(text) {
    $('error').textContent = text; $('error').style.display = 'block';
    clearTimeout(errorTimer); // 앞의 토스트가 뒤에 온 것까지 같이 지우지 않게 한다
    errorTimer = setTimeout(function () { $('error').style.display = 'none'; }, 3000);
  }
  // 끊긴 동안 버튼이 눌리는 채로 남아 "눌러도 아무 일이 없는" 상태를 만들지 않는다.
  function setOffline(offline) {
    if (offline) document.body.setAttribute('data-offline', '');
    else document.body.removeAttribute('data-offline');
  }
  // 재시도 간격을 흩뜨려, 한꺼번에 끊긴 사람들이 동시에 다시 두드리지 않게 한다.
  function nextDelay() { return Math.round(reconnectDelay * (0.7 + Math.random() * 0.6)); }
  function connect() {
    if (leaving || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    ws = new WebSocket(protocol + '//' + location.host + '/api/ws?game=blackjack');
    ws.onopen = function () { reconnectDelay = 500; setOffline(false); send('join', { nickname: nickname, token: localStorage.getItem(TOKEN_KEY) }); };
    ws.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (error) { return; }
      if (data.type === 'welcome') { localStorage.setItem(TOKEN_KEY, data.token); return; }
      if (data.type === 'replaced') { superseded = true; showError('다른 창에서 같은 참가자로 접속했습니다.'); return; }
      if (data.type === 'left') { localStorage.removeItem(TOKEN_KEY); location.href = '/'; return; }
      if (data.type === 'error') { showError(data.message); return; }
      if (data.type === 'blackjackState') { state = data; render(); }
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
  function cardLabel(card) { if (card.hidden) return ''; var labels = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }; return (labels[card.rank] || card.rank) + card.suit; }
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
    $('pot').textContent = money(state.pot); $('base-label').textContent = '기본 ' + money(state.baseBet); $('base-bet').value = state.baseBet;
    $('phase').textContent = { lobby: '대기 중', playing: '카드 선택', betting: '배팅 중', result: '라운드 종료' }[state.phase] || state.phase;
    $('lobby').classList.toggle('hidden', !lobby); $('playing').classList.toggle('hidden', state.phase !== 'playing'); $('betting').classList.toggle('hidden', state.phase !== 'betting');
    $('ready').textContent = you.ready ? '준비 취소' : '준비'; $('start').disabled = !state.canStart; $('set-bet').disabled = !!state.baseBetProposal;
    $('hit').disabled = !myTurn; $('stand').disabled = !myTurn;
    $('betting').querySelectorAll('button').forEach(function (button) { button.disabled = !myTurn; });
    $('allin').disabled = !myTurn || state.allInCap !== null; $('raise').disabled = !myTurn || state.allInCap !== null;
    $('call').textContent = '콜 · ' + money(Math.max(0, state.currentBet - you.roundBet));
    var message = '참가자들이 준비하면 시작할 수 있습니다.';
    if (state.phase === 'playing') { var turn = state.players.find(function (p) { return p.id === state.turnPlayerId; }); message = turn ? '현재 ' + turn.nickname + '님의 카드 선택 차례입니다.' + (myTurn ? ' 히트 또는 스탠드를 선택하세요.' : '') : '카드를 선택하고 있습니다.'; }
    if (state.phase === 'betting') { var bettor = state.players.find(function (p) { return p.id === state.turnPlayerId; }); message = bettor ? '현재 ' + bettor.nickname + '님의 배팅 차례입니다.' + (myTurn ? ' 배팅 액션을 선택하세요.' : '') : '배팅을 진행하고 있습니다.'; }
    if (!lobby && !state.you.inRound) message = '진행 중인 판을 관전하고 있습니다. 다음 판부터 참여할 수 있습니다.';
    if (state.result) message = state.result.noWinner ? state.result.message : state.result.nickname + '님이 ' + money(state.result.amount) + '을 획득했습니다.';
    $('message').textContent = message;
    $('players').innerHTML = state.players.map(function (player) { var waiting = !lobby && !player.inRound; var status = waiting ? '다음 판 대기' : player.isFolded ? '폴드' : player.isAllIn ? '올인' : player.isBusted ? '21 초과' : player.isStanding ? '스탠드' : player.ready ? '준비' : '대기'; var initial = Array.from(player.nickname)[0] || '나'; return '<div class="player ' + (player.id === state.turnPlayerId ? 'turn' : '') + '" role="button" tabindex="0" title="대기 중 선택하면 기부할 수 있습니다" data-id="' + player.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(player.nickname) + (player.id === state.you.id ? ' (나)' : '') + '</b><small>' + money(player.chips) + ' · 배팅 ' + money(player.roundBet) + '</small><span class="status">' + status + '</span></div>'; }).join('');
    $('cards').innerHTML = state.players.filter(function (player) { return player.cards.length; }).map(function (player) {
      var cards = player.cards.map(function (card) { var red = !card.hidden && (card.suit === '♥' || card.suit === '♦'); return '<div class="card ' + (card.hidden ? 'hidden-card ' : '') + (red ? 'red' : '') + '">' + cardLabel(card) + '</div>'; }).join('');
      var tieCards = (player.tieCards || []).map(function (card) { var red = !card.hidden && (card.suit === '♥' || card.suit === '♦'); return '<div class="card tie-card ' + (card.hidden ? 'hidden-card ' : '') + (red ? 'red' : '') + '">' + cardLabel(card) + '</div>'; }).join('');
      var score = player.score === null ? player.cards.length + '장' : player.score + '점';
      return '<div class="seat blackjack-seat ' + (player.isFolded ? 'folded' : '') + '"><div class="hand">' + cards + '</div>' + (tieCards ? '<div class="tie-hand"><small>재대결</small>' + tieCards + '</div>' : '') + '<b>' + escapeHtml(player.nickname) + '</b><span class="score ' + (player.isBusted ? 'bust' : '') + '">' + score + '</span></div>';
    }).join('');
    $('history').innerHTML = state.history.slice().reverse().map(function (item) { return '<div>' + escapeHtml(item.text) + '</div>'; }).join('');
    function openDonation(element, event) { event.preventDefault(); event.stopPropagation(); if (state.phase !== 'lobby' && state.phase !== 'result') { showError('기부는 대기 중에만 할 수 있습니다.'); return; } if (element.dataset.id === state.you.id) return; donationTarget = element.dataset.id; var target = state.players.find(function (p) { return p.id === donationTarget; }); var rect = element.getBoundingClientRect(); $('donate-name').textContent = target.nickname + '님에게'; $('donate').style.left = Math.min(event.clientX || rect.right, innerWidth - 190) + 'px'; $('donate').style.top = Math.min(event.clientY || rect.bottom, innerHeight - 150) + 'px'; $('donate').classList.remove('hidden'); }
    document.querySelectorAll('.player').forEach(function (element) { element.oncontextmenu = function (event) { openDonation(element, event); }; element.onclick = function (event) { openDonation(element, event); }; element.onkeydown = function (event) { if (event.key === 'Enter' || event.key === ' ') openDonation(element, event); }; });
    renderProposal();
  }
  $('ready').onclick = function () { send('ready', { ready: !state.players.find(function (p) { return p.id === state.you.id; }).ready }); };
  $('leave').onclick = function (event) { event.preventDefault(); if (leaving) return; leaving = true; clearTimeout(reconnectTimer); if (ws && ws.readyState === WebSocket.OPEN) { send('leave'); setTimeout(function () { location.href = '/'; }, 1200); } else { localStorage.removeItem(TOKEN_KEY); location.href = '/'; } };
  $('set-bet').onclick = function () { send('baseBet', { amount: Number($('base-bet').value) }); };
  $('proposal-yes').onclick = function () { send('baseBetVote', { proposalId: state.baseBetProposal.id, agree: true }); };
  $('proposal-no').onclick = function () { send('baseBetVote', { proposalId: state.baseBetProposal.id, agree: false }); };
  $('start').onclick = function () { send('start'); }; $('hit').onclick = function () { send('hit'); }; $('stand').onclick = function () { send('stand'); };
  $('call').onclick = function () { send('call'); }; $('raise').onclick = function () { send('raise', { amount: Number($('raise-amount').value) }); }; $('allin').onclick = function () { send('allin'); }; $('fold').onclick = function () { send('fold'); };
  $('donate-send').onclick = function () { send('donate', { targetId: donationTarget, amount: Number($('donate-amount').value) }); $('donate').classList.add('hidden'); };
  document.querySelectorAll('button[data-help]').forEach(function (button) { function showHelp() { $('action-help').textContent = button.dataset.help; } button.addEventListener('mouseenter', showHelp); button.addEventListener('focus', showHelp); button.addEventListener('touchstart', showHelp, { passive: true }); });
  document.addEventListener('click', function (event) { if (!$('donate').contains(event.target)) $('donate').classList.add('hidden'); });
  // 화면을 전환하거나 백그라운드로 내리면 브라우저가 조용히 소켓을 끊는다. 다시
  // 보이는 순간 재시도 대기를 건너뛰고 바로 다시 붙는다.
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { reconnectDelay = 500; connect(); } });
  setInterval(function () { send('ping'); }, 20000); connect();
}());
