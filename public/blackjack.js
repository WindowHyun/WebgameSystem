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

  // 참가 토큰을 탭 단위(sessionStorage)로 둔다. 이유는 public/poker.js의 같은 주석 참고 -
  // localStorage에 두면 같은 기기의 두 탭이 같은 참가자로 붙어 한쪽이 강제로 끊긴다.
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

  function send(type, extra) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(Object.assign({ type: type }, extra || {}))); }
  function money(value) { return Number(value || 0).toLocaleString() + '원'; }
  // 참가자 줄에 쓰는 짧은 금액(public/poker.js의 같은 주석 참고). 폰의 한 칸에
  // "1,000,000원 · 배팅 100원"이 안 들어가 배팅액이 잘려 사라졌다.
  function shortMoney(value) {
    var won = Number(value || 0);
    if (won < 10000) return won.toLocaleString();
    var man = won / 10000;
    return (man >= 100 ? Math.round(man) : Math.round(man * 10) / 10) + '만';
  }
  function chipLine(player) {
    var chips = shortMoney(player.chips);
    return player.roundBet > 0 ? chips + ' · +' + shortMoney(player.roundBet) : chips;
  }
  // 레이즈 하한(= 직전 사람이 올린 폭)을 입력창에 반영한다(public/poker.js의 같은 주석 참고).
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
    $('error').textContent = text; $('error').style.display = 'block';
    clearTimeout(errorTimer); // 앞의 토스트가 뒤에 온 것까지 같이 지우지 않게 한다
    errorTimer = setTimeout(function () { $('error').style.display = 'none'; }, 3000);
  }
  // 스스로 회복할 수 없는 상태를 사라지지 않는 안내로 알린다(public/poker.js와 동일).
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
  // 끊긴 동안 버튼이 눌리는 채로 남아 "눌러도 아무 일이 없는" 상태를 만들지 않는다.
  function setOffline(offline) {
    if (offline) document.body.setAttribute('data-offline', '');
    else document.body.removeAttribute('data-offline');
  }
  // 재시도 간격을 흩뜨려, 한꺼번에 끊긴 사람들이 동시에 다시 두드리지 않게 한다.
  function nextDelay() { return Math.round(reconnectDelay * (0.7 + Math.random() * 0.6)); }

  // 연결이 진짜 살아 있는지 스스로 확인한다. 자세한 이유는 public/poker.js의
  // 같은 자리 주석 참고 - 폰이 잠들면 소켓이 닫히지 않고 얼어붙어, OPEN인데
  // 아무것도 오가지 않는 "좀비" 상태가 된다.
  var PING_MS = 10000;
  var SILENCE_MS = 25000;
  var PROBE_HINT_MS = 600;
  var PROBE_FAIL_MS = 2500;
  var CONNECT_TIMEOUT_MS = 8000;
  var lastSeenAt = 0;
  var connectingSince = 0;
  // 화면이 숨겨졌거나 통신이 끊긴 것을 확인했다는 표시. 돌아왔을 때 한 번만 본다.
  var wasAway = false;
  var probeHintTimer = null;
  var probeFailTimer = null;

  function clearProbe() {
    if (probeHintTimer) { clearTimeout(probeHintTimer); probeHintTimer = null; }
    if (probeFailTimer) { clearTimeout(probeFailTimer); probeFailTimer = null; }
  }

  function abandonSocket() {
    var dead = ws;
    ws = null;
    if (dead) {
      dead.onopen = null; dead.onmessage = null; dead.onerror = null; dead.onclose = null;
      try { dead.close(); } catch (error) { /* 이미 닫힘 */ }
    }
  }

  // 통신이 끊긴 채로 연 소켓은 CONNECTING에 멈춰 아무도 되살리지 않는 막다른 길이
  // 된다(public/poker.js의 같은 함수 주석 참고).
  function dropStuckSocket() {
    if (!ws || ws.readyState !== WebSocket.CONNECTING) return false;
    if (Date.now() - connectingSince <= CONNECT_TIMEOUT_MS) return false;
    abandonSocket();
    return true;
  }

  /** 죽은 소켓을 버리고 그 자리에서 새로 붙는다(public/poker.js의 같은 함수 참고). */
  function forceReconnect() {
    clearProbe();
    abandonSocket();
    setOffline(true);
    clearTimeout(reconnectTimer);
    reconnectDelay = 500;
    connect();
  }

  /** 화면이 다시 보일 때 부른다. OPEN이라는 말을 믿지 않고 실제로 물어본다. */
  function verifyConnection() {
    if (leaving || superseded) return;
    reconnectDelay = 500;
    // 자리를 비운 사이에 시작된 연결 시도는 기다리지 않고 버린다(public/poker.js의
    // 같은 자리 주석 참고). 돌아온 직후 한 번만 한다.
    if (wasAway) {
      wasAway = false;
      if (ws && ws.readyState === WebSocket.CONNECTING) abandonSocket();
    }
    dropStuckSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearTimeout(reconnectTimer);
      connect();
      return;
    }
    if (probeFailTimer) return;
    send('ping');
    probeHintTimer = setTimeout(function () { probeHintTimer = null; setOffline(true); }, PROBE_HINT_MS);
    probeFailTimer = setTimeout(forceReconnect, PROBE_FAIL_MS);
  }
  function connect() {
    if (leaving || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    ws = new WebSocket(protocol + '//' + location.host + '/api/ws?game=blackjack');
    connectingSince = Date.now();
    ws.onopen = function () { reconnectDelay = 500; lastSeenAt = Date.now(); setOffline(false); send('join', { nickname: nickname, token: readToken() }); };
    ws.onmessage = function (event) {
      // 무엇이 오든 연결이 살아 있다는 뜻이다. 확인 중이었다면 여기서 끝난다.
      lastSeenAt = Date.now();
      if (probeHintTimer || probeFailTimer) { clearProbe(); setOffline(false); }
      var data;
      try { data = JSON.parse(event.data); } catch (error) { return; }
      if (data.type === 'pong') return;
      if (data.type === 'welcome') { saveToken(data.token); return; }
      if (data.type === 'replaced') {
        superseded = true;
        setOffline(true);
        showFatal('다른 창에서 같은 참가자로 접속해 이 창의 연결이 닫혔습니다.');
        return;
      }
      if (data.type === 'left') { saveToken(null); location.href = '/'; return; }
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
    // 상한이 고정된 뒤에도 올인은 열어 둔다(public/poker.js의 같은 자리 주석 참고).
    $('allin').disabled = !myTurn || you.chips <= 0; $('raise').disabled = !myTurn || state.allInCap !== null;
    $('call').textContent = '콜 · ' + money(Math.max(0, state.currentBet - you.roundBet));
    syncRaiseFloor(state.minRaise);
    // 시작 버튼이 꺼져 있으면 그 이유를 그대로 말해 준다(public/poker.js와 동일).
    var message = '참가자들이 준비하면 시작할 수 있습니다.';
    if (lobby) {
      message = state.canStart
        ? '준비한 ' + state.readyCount + '명으로 새 판을 시작할 수 있습니다.'
        : '준비한 참가자가 ' + state.minPlayers + '명 이상이면 누구나 시작할 수 있습니다. (현재 '
          + state.readyCount + '명)';
    }
    if (state.phase === 'playing') { var turn = state.players.find(function (p) { return p.id === state.turnPlayerId; }); message = turn ? '현재 ' + turn.nickname + '님의 카드 선택 차례입니다.' + (myTurn ? ' 히트 또는 스탠드를 선택하세요.' : '') : '카드를 선택하고 있습니다.'; }
    if (state.phase === 'betting') { var bettor = state.players.find(function (p) { return p.id === state.turnPlayerId; }); message = bettor ? '현재 ' + bettor.nickname + '님의 배팅 차례입니다.' + (myTurn ? ' 배팅 액션을 선택하세요.' : '') : '배팅을 진행하고 있습니다.'; }
    if (!lobby && !state.you.inRound) message = '진행 중인 판을 관전하고 있습니다. 다음 판부터 참여할 수 있습니다.';
    if (state.result) message = state.result.noWinner ? state.result.message : state.result.nickname + '님이 ' + money(state.result.amount) + '을 획득했습니다.';
    $('message').textContent = message;
    $('players').innerHTML = state.players.map(function (player) { var waiting = !lobby && !player.inRound; var status = waiting ? '다음 판 대기' : player.isFolded ? '폴드' : player.isAllIn ? '올인' : player.isBusted ? '21 초과' : player.isStanding ? '스탠드' : player.ready ? '준비' : '대기'; if (player.connected === false) status = '끊김'; /* 두 단어면 폰에서 금액 줄이 잘린다(public/poker.js 참고) */ var initial = Array.from(player.nickname)[0] || '나'; return '<div class="player ' + (player.id === state.turnPlayerId ? 'turn' : '') + '" role="button" tabindex="0" title="대기 중 선택하면 기부할 수 있습니다" data-id="' + player.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(player.nickname) + (player.id === state.you.id ? ' (나)' : '') + '</b><small>' + chipLine(player) + '</small><span class="status">' + status + '</span></div>'; }).join('');
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
  $('leave').onclick = function (event) { event.preventDefault(); if (leaving) return; leaving = true; clearTimeout(reconnectTimer); if (ws && ws.readyState === WebSocket.OPEN) { send('leave'); setTimeout(function () { location.href = '/'; }, 1200); } else { saveToken(null); location.href = '/'; } };
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
  // 돌아오는 길은 하나가 아니다(public/poker.js의 같은 자리 주석 참고).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') verifyConnection();
    else wasAway = true;
  });
  window.addEventListener('pageshow', verifyConnection);
  window.addEventListener('online', verifyConnection);
  window.addEventListener('focus', verifyConnection);
  window.addEventListener('offline', function () { wasAway = true; });

  // 복귀 신호가 하나도 안 와도 스스로 알아챈다.
  setInterval(function () {
    if (leaving || superseded) return;
    // 열리다 만 소켓을 먼저 치운다(public/poker.js의 같은 자리 주석 참고).
    if (dropStuckSocket()) {
      setOffline(true);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, nextDelay());
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (lastSeenAt && Date.now() - lastSeenAt > SILENCE_MS) { forceReconnect(); return; }
    send('ping');
  }, PING_MS);
  connect();
}());
