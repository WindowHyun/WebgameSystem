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
   * 참가자 줄에 쓰는 짧은 금액. 폰에서는 한 칸이 100px 남짓이라
   * "1,000,000원 · 배팅 100원"이 "1,000,000원 · 배..."로 잘렸다 - 정작 봐야 할
   * 배팅액이 사라졌다. 만 단위로 줄이고, 배팅이 없으면 그 구절 자체를 뺀다.
   */
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

  // ── 연결이 진짜 살아 있는지 스스로 확인한다 ──────────────────────────
  //
  // 폰을 잠그거나 다른 앱을 보다 돌아오면 OS는 소켓을 닫아 주지 않고 그냥 얼린다.
  // 그래서 돌아왔을 때 ws.readyState는 OPEN인데 실제로는 아무것도 오가지 않는
  // "좀비" 상태가 된다. 예전에는 이걸 알아채는 게 없어서, 서버가 하트비트로 죽여
  // 줄 때까지 화면만 멀쩡하고 아무것도 안 되는 상태로 기다려야 했다.
  // (재 봤더니 30초 자리비움에 9.6초, 95초에 54.7초가 걸렸다)
  var PING_MS = 10000;      // 살아 있는지 물어보는 주기
  var SILENCE_MS = 25000;   // 이만큼 아무 소식이 없으면 죽은 연결로 본다
  var PROBE_HINT_MS = 600;  // 확인 요청에 이만큼 답이 없으면 "다시 연결하는 중"을 보여 준다
  var PROBE_FAIL_MS = 2500; // 이만큼 답이 없으면 죽은 것으로 보고 새로 붙는다
  var CONNECT_TIMEOUT_MS = 8000; // 이만큼 열리지 않는 연결은 버린다
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

  /**
   * 통신이 끊긴 채로 연 소켓은 열리지도 닫히지도 않고 CONNECTING에 멈춘다.
   * 그러면 connect()는 "이미 연결 중"이라며 돌아가고 감시기는 OPEN이 아니라고
   * 건너뛰어서, 아무도 그 소켓을 되살리지 않는 막다른 길이 된다. 오래 걸린 연결은
   * 실패로 보고 버린다.
   */
  function dropStuckSocket() {
    if (!ws || ws.readyState !== WebSocket.CONNECTING) return false;
    if (Date.now() - connectingSince <= CONNECT_TIMEOUT_MS) return false;
    abandonSocket();
    return true;
  }

  /**
   * 죽은 소켓을 버리고 그 자리에서 새로 붙는다.
   *
   * close()만 부르고 onclose를 기다리면 안 된다 - 좀비 소켓은 서버의 닫기 응답이
   * 영영 오지 않아 브라우저가 한참 뒤에야 onclose를 준다. 그게 예전에 55초씩
   * 걸리던 이유다. 핸들러를 먼저 떼어 내고 바로 새 연결을 연다.
   * 떼어 내는 건 또 다른 이유로도 중요하다: 나중에 살아난 옛 소켓이 서버가 보낸
   * replaced를 뒤늦게 전해 주면, 멀쩡히 붙어 있는 이 창이 영구 중단된다.
   */
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
    reconnectDelay = 500; // 돌아왔으니 기다림은 처음부터
    // 자리를 비운 사이에 시작된 연결 시도는 통신이 끊긴 채로 연 것이라 살아날 가망이 없다.
    // 그런데 connect()는 "이미 연결 중"이라며 그냥 돌아가서, 돌아온 뒤에도 아무 일이
    // 일어나지 않고 8초(CONNECT_TIMEOUT_MS)를 기다려야 했다. 30초쯤 자리를 비우면
    // 감시기가 죽었다고 판정하는 순간과 돌아오는 순간이 겹쳐 딱 이 상황이 된다.
    // 돌아온 직후 한 번만, 그 소켓을 기다리지 않고 버린다.
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
    if (probeFailTimer) return; // 이미 확인 중
    send('ping');
    probeHintTimer = setTimeout(function () { probeHintTimer = null; setOffline(true); }, PROBE_HINT_MS);
    probeFailTimer = setTimeout(forceReconnect, PROBE_FAIL_MS);
  }

  function connect() {
    if (leaving || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
    ws = new WebSocket(protocol + '//' + location.host + '/api/ws?game=poker');
    connectingSince = Date.now();
    ws.onopen = function () {
      reconnectDelay = 500;
      lastSeenAt = Date.now();
      setOffline(false);
      send('join', { nickname: nickname, token: readToken() });
    };
    ws.onmessage = function (event) {
      // 무엇이 오든 연결이 살아 있다는 뜻이다. 확인 중이었다면 여기서 끝난다.
      lastSeenAt = Date.now();
      if (probeHintTimer || probeFailTimer) { clearProbe(); setOffline(false); }
      var data;
      try { data = JSON.parse(event.data); } catch (error) { return; }
      if (data.type === 'pong') return;
      // [보스 키] 누군가 화면을 가렸다 - 내 화면도 가린다(public/cover.js).
      if (data.type === 'cover') { if (window.bossCover) window.bossCover.show(); return; }
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

  /**
   * [요청] 게임 시작을 누르면 바로 시작하지 않고, 누가 준비를 안 했는지 먼저 보여 준다.
   * 예전에는 누르는 즉시 준비한 사람끼리 판이 시작되어, 준비를 깜빡한 사람이 모른 채
   * 빠졌다. 창이 열려 있는 동안 준비 상태가 바뀌면 목록도 따라 바뀌고, 그사이 다른
   * 사람이 먼저 시작했거나 시작할 수 없게 되면 창을 닫는다.
   */
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
    // 상한이 고정된 뒤에도 올인은 열어 둔다. 콜은 칩이 모자라면 서버가 거절하고
    // 레이즈는 아래에서 막히므로, 올인까지 잠그면 칩이 적은 사람에게 남는 선택지가
    // 폴드뿐이 된다 - 자기 칩을 다 걸고 겨뤄 볼 기회조차 없었다. 서버는 진작부터
    // 이 올인을 받아 주고 있었고, 막고 있던 건 이 한 줄이었다.
    $('allin').disabled = !myTurn || you.chips <= 0;
    $('raise').disabled = !myTurn || state.allInCap !== null;
    // 앤티를 내고 나면 더 낼 것이 없는 경우가 많다. 그때 "콜 · 0원"은 체크다.
    var toCall = Math.max(0, state.currentBet - you.roundBet);
    $('call').textContent = toCall ? '콜 · ' + money(toCall) : '체크';
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
      // 판이 끝나 대기 중일 때는 지난 판의 폴드·올인이 아니라 다음 판 준비 여부를 보여 준다.
      var status = lobby ? (player.ready ? '준비' : '대기')
        : waiting ? '다음 판 대기' : player.isFolded ? '폴드' : player.isAllIn ? '올인' : player.ready ? '준비' : '대기';
      // 끊긴 채로 판에 남은 사람(올인하고 기다리는 사람). 차례가 오지 않으니 기다릴 필요는 없다.
      // "올인 · 끊김"처럼 두 단어를 쓰면 폰에서 옆의 금액 줄("0 · +100만")이 잘린다.
      // 올인했다는 건 그 금액 줄이 이미 말해 주므로 한 단어로 둔다.
      if (player.connected === false) status = '끊김';
      var initial = Array.from(player.nickname)[0] || '나';
      return '<div class="player ' + (player.id === state.turnPlayerId ? 'turn' : '') + '" role="button" tabindex="0" title="대기 중 선택하면 기부할 수 있습니다" data-id="' + player.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(player.nickname) + (player.id === state.you.id ? ' (나)' : '') + '</b><small>' + chipLine(player) + '</small><span class="status">' + status + '</span></div>';
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
    renderStartConfirm();
  }

  // [보스 키] 내가 가리면 다른 사람들 화면도 가리도록 서버에 알린다(public/cover.js).
  document.addEventListener('boss-cover', function () { send('cover'); });
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
  $('start').onclick = function () { startConfirmOpen = true; renderStartConfirm(); };
  $('start-cancel').onclick = closeStartConfirm;
  $('start-go').onclick = function () { closeStartConfirm(); send('start'); };
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && startConfirmOpen) closeStartConfirm(); });
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
  // 돌아오는 길은 하나가 아니다. iOS는 앱 전환기에서 돌아올 때 화면 복원이면
  // pageshow만 쏘고 visibilitychange는 안 쏘는 경로가 있고, 끊겼던 통신이 돌아온 건
  // online으로만 알 수 있다. 하나라도 놓치면 좀비 연결이 그대로 남는다.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') verifyConnection();
    else wasAway = true;
  });
  window.addEventListener('pageshow', verifyConnection);
  window.addEventListener('online', verifyConnection);
  window.addEventListener('focus', verifyConnection);
  window.addEventListener('offline', function () { wasAway = true; });

  // 복귀 신호가 하나도 안 와도 스스로 알아챈다. 예전에는 답이 오는지 보지도 않고
  // 20초마다 ping만 던지고 있어서, 좀비가 되면 서버가 죽여 줄 때까지 몰랐다.
  setInterval(function () {
    if (leaving || superseded) return;
    // 열리다 만 소켓을 먼저 치운다. 이게 없으면 통신이 끊긴 동안 연 연결이
    // CONNECTING에 멈춘 채 영영 남아, 통신이 돌아와도 아무 일도 일어나지 않는다.
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
