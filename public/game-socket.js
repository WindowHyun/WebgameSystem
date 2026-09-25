/**
 * [리뷰 P2-03] 카드 게임(포커·블랙잭·더 마인드)과 포털이 같이 쓰는 연결 관리.
 *
 * 예전에는 연결·재접속·확인(ping)·좀비 연결 감지·백그라운드 복귀 코드가 파일마다 한 벌씩
 * (poker.js·blackjack.js·mind.js·portal.js) 복사돼 있어서, 폰에서 찾은 연결 문제를 고칠 때마다
 * 네 곳을 따로 맞춰야 했다. 이제 여기 한 곳이다. 각 화면은 자기 게임의 메시지(상태·오류)만 처리한다.
 * (라이어 public/app.js는 LAN(Electron) 빌드의 서버 찾기와 예전 서버 호환 때문에 따로 둔다.
 * 같은 방식이다.)
 *
 * 쓰는 법:
 *   var socket = window.GameSocket.open({
 *     game: 'poker',                  // /api/ws?game= 값
 *     tokenKey: 'poker-game-token',   // 참가 토큰을 둘 곳. 없으면(포털) 참가하지 않고 듣기만 한다
 *     nickname: nickname,             // 참가할 이름(tokenKey가 있을 때)
 *     onMessage: function (data) {}   // 여기서 처리하지 않는 메시지(상태·오류 등)
 *   });
 *   socket.send('call');  socket.send('raise', { amount: 100 });  socket.leave();
 *
 * 여기서 처리하는 메시지: pong, cover(보스 키), welcome(토큰), replaced(다른 창이 자리를 가져감),
 * left(나가기 끝). 보스 키 알림(boss-cover, boss-cover-state)도 여기서 서버에 전한다.
 */
(function () {
  'use strict';

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

  function open(options) {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = protocol + '//' + location.host + '/api/ws?game=' + encodeURIComponent(options.game);
    var joins = !!options.tokenKey;
    var onMessage = options.onMessage || function () {};
    var ws = null;
    var reconnectTimer = null;
    var reconnectDelay = 500;
    var superseded = false;
    var leaving = false;
    var lastSeenAt = 0;
    var connectingSince = 0;
    // 화면이 숨겨졌거나 통신이 끊긴 것을 확인했다는 표시. 돌아왔을 때 한 번만 본다.
    var wasAway = false;
    var probeHintTimer = null;
    var probeFailTimer = null;

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
      try { return sessionStorage.getItem(options.tokenKey); } catch (error) { return null; }
    }
    function saveToken(value) {
      memoryToken = value;
      try {
        if (value) sessionStorage.setItem(options.tokenKey, value);
        else sessionStorage.removeItem(options.tokenKey);
      } catch (error) { /* 사생활 보호 모드 - memoryToken으로 버틴다 */ }
    }

    function send(type, extra) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(Object.assign({ type: type }, extra || {})));
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
     * 재시도 간격을 사람마다 흩뜨린다. Render가 재배포되면 붙어 있던 사람이 전부 같은 순간에
     * 끊기는데, 지터가 없으면 그 인원이 5초마다 한꺼번에 다시 두드려 막 올라온 서버를 다시 넘어뜨린다.
     */
    function scheduleReconnect() {
      setOffline(true);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, Math.round(reconnectDelay * (0.7 + Math.random() * 0.6)));
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    }

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
      if (leaving || superseded || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
      ws = new WebSocket(url);
      connectingSince = Date.now();
      ws.onopen = function () {
        reconnectDelay = 500;
        lastSeenAt = Date.now();
        setOffline(false);
        if (joins) send('join', { nickname: options.nickname, token: readToken() });
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
        onMessage(data);
      };
      ws.onerror = function () { /* onclose에서 한 번만 복구한다. */ };
      ws.onclose = function () {
        if (leaving) { location.href = '/'; return; }
        if (superseded) return;
        scheduleReconnect();
      };
    }

    /** 방 나가기. 서버가 left로 답하면 목록으로 간다. 끊겨 있으면 바로 간다(토큰은 남긴다). */
    function leave() {
      if (leaving) return;
      leaving = true;
      clearTimeout(reconnectTimer);
      if (ws && ws.readyState === WebSocket.OPEN) {
        send('leave');
        setTimeout(function () { location.href = '/'; }, 1200);
      } else {
        location.href = '/';
      }
    }

    // [보스 키] 내가 가리면 다른 사람들 화면도 가리도록 서버에 알린다(public/cover.js).
    document.addEventListener('boss-cover', function () { send('cover'); });
    // [보스 키] 내 화면이 가려졌는지/돌아왔는지 알린다. 가려진 동안 내 차례의 제한시간이 멈춘다.
    // 포털에는 기다리는 제한시간이 없어서 알리지 않는다.
    if (joins) {
      document.addEventListener('boss-cover-state', function (event) { send('coverState', { covered: !!(event.detail && event.detail.covered) }); });
    }

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
      if (dropStuckSocket()) { scheduleReconnect(); return; }
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (lastSeenAt && Date.now() - lastSeenAt > SILENCE_MS) { forceReconnect(); return; }
      send('ping');
    }, PING_MS);

    connect();
    return { send: send, leave: leave };
  }

  window.GameSocket = { open: open };
}());
