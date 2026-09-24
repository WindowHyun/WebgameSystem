/**
 * 더 마인드 화면. 규칙과 판정은 전부 서버(web/mind-room.js)가 한다 - 이 화면은 받은 상태를
 * 그리고 버튼을 서버에 전할 뿐이다. 연결 유지·재접속은 public/poker.js와 같은 방식이다.
 */
(function () {
  'use strict';

  var NAME_KEY = 'game-portal-nickname';
  var TOKEN_KEY = 'mind-game-token';
  var nickname = sessionStorage.getItem(NAME_KEY);
  if (!nickname) { location.href = '/'; return; }

  var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = null;
  var reconnectTimer = null;
  var reconnectDelay = 500;
  var superseded = false;
  var state = null;
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
   * 버튼이 전부 눌리는 상태로 남아서, 카드 내기를 눌러도 아무 일도 일어나지 않았다.
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
    ws = new WebSocket(protocol + '//' + location.host + '/api/ws?game=mind');
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
      if (data.type === 'welcome') {
        saveToken(data.token);
        // [보스 키] 가려진 채로 다시 연결됐으면 서버에 다시 알린다(서버는 이전 연결의 상태를 버린다).
        if (window.bossCover && window.bossCover.isShown()) send('coverState', { covered: true });
        return;
      }
      if (data.type === 'replaced') {
        superseded = true;
        setOffline(true);
        showFatal('다른 창에서 같은 참가자로 접속해 이 창의 연결이 닫혔습니다.');
        return;
      }
      // [이슈] 나가도 토큰은 지우지 않는다. 서버는 나간 사람의 칩을 이 토큰에 묶어 보관하는데,
      // 예전에는 여기서 지워 버려서 다시 들어오면 칩이 100만 원으로 되살아났다(지고 있으면
      // 나갔다 오면 그만인 게임이 됐다). 탭을 닫으면 sessionStorage와 함께 사라진다.
      if (data.type === 'left') { location.href = '/'; return; }
      if (data.type === 'error') { pendingPlay = false; showError(data.message); if (state) render(); return; }
      if (data.type === 'mindState') { settlePending(data); state = data; render(); }
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

  // [보스 키] 내가 가리면 다른 사람들 화면도 가리도록 서버에 알린다(public/cover.js).
  document.addEventListener('boss-cover', function () { send('cover'); });
  // [보스 키] 내 화면이 가려졌는지 알린다. 레벨 도중이면 모두 멈추고 다시 집중한다.
  document.addEventListener('boss-cover-state', function (event) { send('coverState', { covered: !!(event.detail && event.detail.covered) }); });
  $('ready').onclick = function () {
    var me = state.players.find(function (p) { return p.id === state.you.id; });
    send('ready', { ready: !(me && me.ready) });
  };
  $('leave').onclick = function (event) {
    event.preventDefault();
    if (leaving) return;
    leaving = true;
    clearTimeout(reconnectTimer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      send('leave');
      setTimeout(function () { location.href = '/'; }, 1200);
    } else {
      location.href = '/';
    }
  };
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
