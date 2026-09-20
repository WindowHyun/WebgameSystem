(function () {
  'use strict';
  var KEY = 'game-portal-nickname';
  var nameScreen = document.getElementById('name-screen');
  var gamesScreen = document.getElementById('games-screen');
  var input = document.getElementById('nickname');
  var ws = null;
  var reconnectDelay = 500;
  var PING_MS = 10000;
  var SILENCE_MS = 25000;
  var CONNECT_TIMEOUT_MS = 8000;
  var lastSeenAt = 0;
  var connectingSince = 0;
  // 화면이 숨겨졌거나 통신이 끊긴 것을 확인했다는 표시. 돌아왔을 때 한 번만 본다.
  var wasAway = false;

  function showGames(name) {
    sessionStorage.setItem(KEY, name);
    document.getElementById('player-name').textContent = name;
    document.getElementById('profile-initial').textContent = Array.from(name)[0] || '나';
    nameScreen.classList.add('hidden');
    gamesScreen.classList.remove('hidden');
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/api/ws?game=portal');
    connectingSince = Date.now();
    ws.onopen = function () { reconnectDelay = 500; lastSeenAt = Date.now(); };
    ws.onmessage = function (event) {
      lastSeenAt = Date.now(); // 무엇이 오든 연결이 살아 있다는 뜻이다
      var data;
      try { data = JSON.parse(event.data); } catch (error) { return; }
      if (data.type !== 'games') return;
      Object.keys(data.games).forEach(function (id) {
        var game = data.games[id];
        var card = document.querySelector('.game-card.' + id);
        document.getElementById(id + '-status').textContent = game.status;
        document.getElementById(id + '-count').textContent = game.playerCount + '명';
        card.classList.toggle('running', game.status === '진행중');
        card.classList.toggle('waiting', game.status === '진행 대기중');
      });
    };
    ws.onerror = function () { /* onclose에서 재연결한다. */ };
    ws.onclose = function () {
      // 지터를 섞어, 한꺼번에 끊긴 사람들이 같은 순간에 다시 두드리지 않게 한다.
      setTimeout(connect, Math.round(reconnectDelay * (0.7 + Math.random() * 0.6)));
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
  }

  document.getElementById('name-form').onsubmit = function (event) {
    event.preventDefault();
    var name = input.value.trim();
    if (name) showGames(name);
  };
  document.getElementById('rename').onclick = function () {
    gamesScreen.classList.add('hidden');
    nameScreen.classList.remove('hidden');
    input.focus();
  };
  document.querySelectorAll('.game-card').forEach(function (card) {
    card.onclick = function () { location.href = card.dataset.url; };
  });

  var saved = sessionStorage.getItem(KEY);
  if (saved) { input.value = saved; showGames(saved); }

  /**
   * 죽은 소켓을 버리고 새로 붙는다. 폰이 잠들면 소켓이 닫히는 게 아니라 얼어서,
   * 돌아왔을 때 readyState는 OPEN인데 아무것도 오가지 않는다. 그 상태로는
   * connect()가 "이미 붙어 있다"며 그냥 돌아가 버려 인원수가 영영 안 바뀐다.
   * (게임 화면 쪽 사정은 public/poker.js의 forceReconnect 주석 참고)
   */
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
  function forceReconnect() {
    abandonSocket();
    reconnectDelay = 500;
    connect();
  }
  function verifyConnection() {
    reconnectDelay = 500;
    // 자리를 비운 사이에 시작된 연결 시도는 기다리지 않고 버린다(public/poker.js의
    // 같은 자리 주석 참고). 돌아온 직후 한 번만 한다.
    if (wasAway) {
      wasAway = false;
      if (ws && ws.readyState === WebSocket.CONNECTING) abandonSocket();
    }
    dropStuckSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) { connect(); return; }
    // 포털은 보여 주는 게 인원수뿐이라 따로 확인 절차를 두지 않는다. 오래 조용했으면
    // 그냥 새로 붙는 편이 싸고 확실하다.
    if (Date.now() - lastSeenAt > SILENCE_MS) forceReconnect();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') verifyConnection();
    else wasAway = true;
  });
  window.addEventListener('pageshow', verifyConnection);
  window.addEventListener('online', verifyConnection);
  window.addEventListener('focus', verifyConnection);
  window.addEventListener('offline', function () { wasAway = true; });

  setInterval(function () {
    if (dropStuckSocket()) { connect(); return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (lastSeenAt && Date.now() - lastSeenAt > SILENCE_MS) { forceReconnect(); return; }
    ws.send(JSON.stringify({ type: 'ping' }));
  }, PING_MS);
  connect();
}());
