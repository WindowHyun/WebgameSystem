'use strict';

/**
 * 화면. 서버가 보내는 "내 몫으로 걸러진 전체 상태"를 그대로 그린다.
 *
 * 증분 이벤트를 쌓아 화면 상태를 맞추지 않는다. 상태가 오면 그 시점의 진실을 통째로
 * 다시 그리므로, 어떤 메시지를 놓쳐도 다음 상태 한 번이면 정확히 복구된다.
 *
 * 화면 구성:
 *   #chat > #chat-messages   지나간 대화. 개수가 바뀔 때만 다시 그린다.
 *         > #live-block      지금 답해야 하는 것(찬반/투표/정답). 상태마다 다시 그린다.
 * 찬반·투표를 화면 아래 별도 패널이 아니라 대화 흐름 안에 들여쓰여 놓는다. 슬랙에서
 * 앱이 보내는 메시지와 같은 모양이라, 지금 무엇에 답하는 중인지가 분명해진다.
 */

// 위장 문구. 용어를 바꾸려면 여기만 고치면 된다.
var LABELS = {
  app: 'Slack',
  channel: '# Oliveyoung',
  liar: '담당자',
};

var TOKEN_KEY = 'liar-game-token';
var NAME_KEY = 'liar-game-nickname';
var MODE_KEY = 'liar-game-spectator';
var spectatorMode = readStored(MODE_KEY) === 'true';
var kicked = false;
var superseded = false; // 같은 토큰으로 다른 연결이 자리를 넘겨받았다 - 이 창은 더 붙지 않는다
var moderationSignature = '';
var sessionToken = null;
try { sessionToken = window.sessionStorage.getItem(TOKEN_KEY); } catch (e) { /* memory fallback */ }

var ws = null;
var state = null;
var myId = null;
var myNickname = '';
var joined = false;
var reconnectTimer = null;
var reconnectDelay = 500;
var tickTimer = null;
var everConnected = false; // [E-1] 첫 접속과 호스트 인계를 구분하기 위해
var serverOffset = 0;      // 서버 시계 - 내 시계. 남은 시간을 정확히 세기 위해.
var bannerWhy = null;       // 지금 배너가 떠 있는 사유. 그 사유가 사라지면 내린다.
var lastChatKey = '';       // 대화를 다시 그릴지 판단하는 지문
// [요청] 창을 내려 둔 사이에 온 것을 알리기 위한 직전 값. 처음 그릴 때는 알리지 않는다.
var lastNotifiedSeq = null;
var wasMyTurn = false;
// [E-3] 연결 감시. 사내망에서 조용한 연결이 끊기거나, 끊긴 줄도 모르고 있는 것을 막는다.
// 예전에는 주기 20초에 침묵 50초라, 판정이 실제로 떨어지는 건 60초 지점이었다.
// 서버가 죽은 연결을 걷어내는 데 최대 75초가 걸리므로 둘이 거의 동시에 움직였고,
// 그래서 이 감시가 있으나 마나였다(재 보니 라이어 55.0초, 감시가 아예 없는
// 포커 54.7초로 차이가 없었다). 주기를 줄여 확실히 먼저 알아채게 한다.
var PING_MS = 10000;       // 살아 있는지 물어보는 주기
var SILENCE_MS = 25000;    // 이만큼 아무 소식이 없으면 죽은 연결로 보고 다시 붙는다
var PROBE_HINT_MS = 600;   // 확인 요청에 이만큼 답이 없으면 "확인 중"을 보여 준다
var PROBE_FAIL_MS = 2500;  // 이만큼 답이 없으면 죽은 것으로 보고 새로 붙는다
var CONNECT_TIMEOUT_MS = 8000; // 이만큼 열리지 않는 연결은 실패로 보고 버린다
var connectingSince = 0;
// 화면이 숨겨졌거나 통신이 끊긴 것을 확인했다는 표시. 돌아왔을 때 한 번만 본다.
var wasAway = false;
var probeHintTimer = null;
var probeFailTimer = null;
var pingTimer = null;
var lastSeenAt = 0;
// 예전 버전(v0.8.0 이하) 서버는 이 확인 요청을 모른다. 그런 서버에 붙으면 20초마다
// "잘못된 요청입니다" 배너가 떠서 고장난 것처럼 보인다. 한 번 거절당하면 그만 보낸다.
var pingSupported = true;
var pongSeen = false;
var pingSentAt = 0;
var liveSignature = '';    // 진행 블록을 필요할 때만 다시 그리기 위한 지문
var roleCardOpen = true;   // 역할 카드를 접었다 펼쳤다 - 새 라운드마다 다시 펼친 채로 시작한다

// 사람마다 다른 아바타 색. 이름이 아니라 id로 고른다 - 닉네임이 같아도(중복 처리 전) 사람은 다르다.
var AVATAR_PALETTE = ['#7F77DD', '#E07B53', '#2BAC76', '#1264A3', '#C93A3A', '#946200', '#00857A', '#8C5AC7'];
function avatarColorFor(key) {
  var s = String(key == null ? '' : key);
  var hash = 0;
  for (var i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

/**
 * 아바타에 넣을 이니셜 두 글자. slice(0,2)는 UTF-16 코드유닛 기준이라 이모지
 * 중간을 잘라 깨진 글자를 남길 수 있다(room.js가 닉네임을 자를 때와 같은 이유).
 * Array.from은 코드 포인트 단위로 쪼개므로 최소한 이모지 하나는 온전히 남는다.
 */
function graphemeInitial(name) {
  return Array.from(String(name == null ? '' : name)).slice(0, 2).join('') || '?';
}

// 연속으로 같은 사람이 친 대화는 아바타·이름을 한 번만 보여준다. 이 안에 있으면 같은 묶음.
var GROUP_WINDOW_MS = 5 * 60 * 1000;

function $(id) { return document.getElementById(id); }

/**
 * 받침에 맞는 조사를 고른다. 한글이 아니면(영문 등) 받침 있는 쪽을 쓴다.
 * 이 게임에서 영문은 위장 단어 Oliveyoung뿐이고, 그건 "Oliveyoung은"이 맞다.
 */
function josa(word, withBatchim, without) {
  var last = String(word == null ? '' : word).trim().slice(-1);
  var code = last.charCodeAt(0);
  if (!(code >= 0xAC00 && code <= 0xD7A3)) return withBatchim;
  return (code - 0xAC00) % 28 !== 0 ? withBatchim : without;
}

function readStored(key) {
  try { var value = window.sessionStorage.getItem(key); if (value !== null) return value; } catch (e) { /* local fallback */ }
  try { return window.localStorage.getItem(key) || null; } catch (e) { return null; }
}
function writeStored(key, value) {
  try { window.sessionStorage.setItem(key, value); } catch (e) { /* local fallback */ }
  try { window.localStorage.setItem(key, value); } catch (e) { /* 사생활 보호 모드 등 */ }
}
function clearStored(key) {
  try { window.sessionStorage.removeItem(key); } catch (e) { /* local fallback */ }
  try { window.localStorage.removeItem(key); } catch (e) { /* 사생활 보호 모드 등 */ }
}
function readToken() { return sessionToken; }
function saveToken(token) {
  sessionToken = token;
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* memory fallback */ }
}

// 위장 문구를 마크업에 끼워 넣는다.
Array.prototype.forEach.call(document.querySelectorAll('[data-label]'), function (el) {
  var key = el.getAttribute('data-label');
  if (LABELS[key]) el.textContent = LABELS[key];
});
document.title = LABELS.app;

// ───────────────────────────── 배너 ─────────────────────────────
var bannerHideTimer = null;
function showBanner(kind, text, autoHideMs, why) {
  var banner = $('banner');
  if (bannerHideTimer) { clearTimeout(bannerHideTimer); bannerHideTimer = null; }

  // 같은 배너를 다시 띄우는 것이면 글자는 손대지 않는다. 매 상태마다 갈아 끼우면
  // 화면이 미세하게 흔들린다.
  var same = bannerWhy === (why || null)
    && banner.textContent === text
    && !banner.classList.contains('hidden');
  if (!same) {
    bannerWhy = why || null;
    banner.className = kind;
    banner.textContent = text;
    banner.classList.remove('hidden');
  }

  // [이슈] 자동 숨김은 같은 배너를 다시 띄울 때도 반드시 다시 건다.
  // 예전에는 위에서 글자가 같으면 바로 빠져나갔는데, 그때 이미 타이머를 꺼 놓은 뒤라
  // 다시 거는 줄에 닿지 못했다. 같은 오류가 5초 안에 두 번 나면 배너가 영영 남았다.
  if (autoHideMs) {
    bannerHideTimer = setTimeout(function () {
      banner.classList.add('hidden');
      bannerHideTimer = null;
      bannerWhy = null;
    }, autoHideMs);
  }
}
function hideBanner() {
  if (bannerHideTimer) { clearTimeout(bannerHideTimer); bannerHideTimer = null; }
  bannerWhy = null;
  $('banner').classList.add('hidden');
}

/** 그 사유로 떠 있는 배너만 내린다. 다른 사유(오류·버전 불일치)로 떠 있으면 두고 본다. */
function hideBannerIf(why) {
  if (bannerWhy !== why) return;
  hideBanner();
}

// ───────────────────────────── 연결 ─────────────────────────────
/**
 * 붙어야 할 게임 서버 주소.
 *   브라우저(웹 버전)  : 이 페이지를 내려준 그 서버
 *   Electron 버전      : LAN에서 뽑힌 호스트. 호스트가 바뀌면 주소도 바뀐다.
 */
function resolveServerUrl() {
  if (window.liar && typeof window.liar.getServer === 'function') return window.liar.getServer();
  var endpoint = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? '?game=liar' : '/api/ws?game=liar';
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + endpoint;
}

function connect() {
  if (kicked || superseded) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  var url = resolveServerUrl();
  if (!url) {
    $('conn-hint').textContent = '같은 네트워크의 참가자를 찾는 중...';
    showBanner('ok', '같은 네트워크에서 함께할 참가자를 찾는 중입니다...');
    scheduleReconnect();
    return;
  }
  // 닫히는 중(CLOSING)인 옛 소켓이 남아 있으면 먼저 떼어 낸다. 그대로 두면 새 연결이 열린 뒤에
  // 옛 소켓의 onclose가 늦게 와서 멀쩡한 연결 위에 "끊어졌습니다"를 띄우고 감시기까지 멈춘다.
  abandonSocket();
  // 옛 소켓에 걸어 둔 확인 타이머도 버린다. 남겨 두면 지금 여는 소켓을 죽은 것으로 보고 끊는다.
  clearProbe();
  var socket = new WebSocket(url);
  ws = socket;
  connectingSince = Date.now();

  // 핸들러는 지금 붙어 있는 소켓의 것만 듣는다(떼어 내기 전에 이미 출발한 이벤트가 있어도 무시).
  socket.onopen = function () {
    if (socket !== ws) return;
    everConnected = true;
    reconnectDelay = 500;
    hideBanner();
    $('conn-hint').textContent = '';
    startWatchdog();
    if (joined && myNickname) sendMessage({ type: 'join', nickname: myNickname, token: readToken(), spectator: spectatorMode });
  };

  socket.onmessage = function (ev) {
    if (socket !== ws) return;
    lastSeenAt = Date.now(); // 무엇이 오든 연결이 살아 있다는 뜻이다
    // 연결을 확인하던 중이었다면 여기서 끝난다 - 답이 왔으니 살아 있는 소켓이다.
    if (probeHintTimer || probeFailTimer) {
      clearProbe();
      $('conn-hint').textContent = '';
    }
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'pong') { pongSeen = true; return; }
    // [보스 키] 누군가 화면을 가렸다 - 내 화면도 가린다(public/cover.js).
    if (msg.type === 'cover') { if (window.bossCover) window.bossCover.show(); return; }
    if (msg.type === 'welcome') {
      myId = msg.playerId;
      saveToken(msg.token);
      // [보스 키] 가려진 채로 다시 연결됐으면 서버에 다시 알린다(서버는 이전 연결의 상태를 버린다).
      if (window.bossCover && window.bossCover.isShown()) sendCoverState(true);
      writeStored(NAME_KEY, myNickname);
      return;
    }
    if (msg.type === 'replaced') {
      stopWatchdog();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      superseded = true; // 이 창은 더 이상 붙지 않는다 - 새 연결이 같은 자리를 이어받았다
      showBanner('warn', '다른 곳에서 같은 참가자로 다시 접속해 이 창의 연결을 닫았습니다.');
      return;
    }
    if (msg.type === 'kicked') {
      var previousName = myNickname;
      stopWatchdog();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      resetRoomScreen();
      kicked = true; // 자동 참가만 멈춘다. 사용자가 접속을 누르면 새 연결로 들어간다.
      $('nickname-input').value = previousName;
      $('spectator-input').checked = spectatorMode;
      $('join-error').textContent = msg.message;
      return;
    }
    if (msg.type === 'error') {
      if (!myId) {
        joined = false;
        $('screen-game').classList.add('hidden');
        $('screen-join').classList.remove('hidden');
        $('join-error').textContent = msg.message;
        return;
      }
      // 방금 보낸 확인 요청이 거절당한 것이라면, 이 서버는 예전 버전이다.
      // 사용자에게는 아무 의미 없는 오류라 띄우지 않고, 확인 요청만 그만 보낸다.
      if (!pongSeen && pingSentAt && Date.now() - pingSentAt < 3000) {
        pingSupported = false;
        stopWatchdog();
        $('conn-hint').textContent = '상대가 예전 버전입니다. 모두 같은 파일로 받아주세요.';
        return;
      }
      showBanner('warn', msg.message, 5000);
      return;
    }
    if (msg.type === 'state') {
      serverOffset = msg.serverTime - Date.now();
      render(msg);
    }
  };

  socket.onclose = function () {
    if (socket !== ws) return;
    stopWatchdog();
    clearProbe(); // 이 소켓에 걸린 확인은 끝났다. 남기면 다음 소켓을 끊는다.
    if (kicked || superseded) return;
    $('conn-hint').textContent = '서버와 연결이 끊어졌습니다.';
    showBanner('warn', '서버와의 연결이 끊어졌습니다. 다시 연결하는 중입니다...');
    scheduleReconnect();
  };
  socket.onerror = function () { /* 곧바로 onclose가 이어진다 */ };
}

/**
 * [E-3] 연결이 살아 있는지 스스로 확인한다.
 *
 * 브라우저는 WebSocket의 ping 프레임을 자바스크립트로 볼 수 없어서, 서버가 아무리
 * 확인해도 화면은 자기 연결이 죽었는지 알 방법이 없다. 사내망에서는 조용한 연결이
 * 소리 없이 끊기고 close 이벤트도 한참 뒤에야 오거나 아예 안 온다. 그동안 화면은
 * 멀쩡해 보이는데 아무것도 안 되는 상태가 된다.
 * 그래서 주기적으로 물어보고, 답이 없으면 먼저 끊고 다시 붙는다.
 */
function startWatchdog() {
  stopWatchdog();
  if (!pingSupported) return; // 예전 버전 서버 - 물어봐야 거절만 당한다
  lastSeenAt = Date.now();
  pingTimer = setInterval(function () {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // 조용하다고 곧바로 끊지 않는다. 확인 요청에 답이 오는 서버일 때만 판단할 수 있다.
    if (pongSeen && Date.now() - lastSeenAt > SILENCE_MS) {
      // 예전에는 close()만 부르고 onclose를 기다렸는데, 좀비 소켓은 onclose가
      // 한참 뒤에야 와서 그동안 화면이 먹통이었다. 기다리지 않고 바로 새로 붙는다.
      forceReconnect();
      return;
    }
    pingSentAt = Date.now();
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { /* 곧 onclose가 온다 */ }
  }, PING_MS);
}

function stopWatchdog() {
  if (!pingTimer) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

function clearProbe() {
  if (probeHintTimer) { clearTimeout(probeHintTimer); probeHintTimer = null; }
  if (probeFailTimer) { clearTimeout(probeFailTimer); probeFailTimer = null; }
}

/**
 * 죽은 소켓을 버리고 그 자리에서 새로 붙는다.
 *
 * close()만 부르고 onclose를 기다리면 안 된다 - 좀비 소켓은 서버의 닫기 응답이
 * 영영 오지 않아 브라우저가 한참 뒤에야 onclose를 준다. 그게 돌아왔을 때 50초씩
 * 먹통이던 이유다. 핸들러를 먼저 떼어 내고 바로 새 연결을 연다.
 * 떼어 내는 건 또 다른 이유로도 중요하다: 나중에 살아난 옛 소켓이 서버가 보낸
 * replaced를 뒤늦게 전해 주면, 멀쩡히 붙어 있는 이 창이 영구 중단된다.
 */
function abandonSocket() {
  var dead = ws;
  ws = null;
  if (dead) {
    dead.onopen = null; dead.onmessage = null; dead.onerror = null; dead.onclose = null;
    try { dead.close(); } catch (e) { /* 이미 닫힘 */ }
  }
}

/**
 * 통신이 끊긴 채로 연 소켓은 열리지도 닫히지도 않고 CONNECTING에 멈춘다. 그러면
 * connect()는 "이미 연결 중"이라며 돌아가고 감시기는 OPEN이 아니라고 건너뛰어서,
 * 아무도 그 소켓을 되살리지 않는 막다른 길이 된다. 오래 걸린 연결은 실패로 본다.
 */
function dropStuckSocket() {
  if (!ws || ws.readyState !== WebSocket.CONNECTING) return false;
  if (Date.now() - connectingSince <= CONNECT_TIMEOUT_MS) return false;
  abandonSocket();
  return true;
}

function forceReconnect() {
  clearProbe();
  stopWatchdog();
  abandonSocket();
  $('conn-hint').textContent = '연결이 끊어진 것 같아 다시 붙는 중...';
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDelay = 500;
  connect();
}

/**
 * 화면이 다시 보일 때 부른다. readyState가 OPEN이라는 말을 믿지 않고 실제로 물어본다.
 * 폰이 잠들었다 깨면 소켓은 OPEN인데 아무것도 오가지 않는 상태가 되기 때문이다.
 */
function verifyConnection() {
  if (kicked || superseded) return;
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
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    connect();
    return;
  }
  if (!pingSupported) return; // 예전 버전 서버 - 물어봐야 거절만 당한다
  if (probeFailTimer) return; // 이미 확인 중
  try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { forceReconnect(); return; }
  probeHintTimer = setTimeout(function () {
    probeHintTimer = null;
    $('conn-hint').textContent = '연결을 확인하는 중...';
  }, PROBE_HINT_MS);
  probeFailTimer = setTimeout(forceReconnect, PROBE_FAIL_MS);
}

function scheduleReconnect() {
  if (kicked || superseded) return;
  if (reconnectTimer) return;
  // 간격을 사람마다 흩뜨린다. Vercel 함수가 재활용되거나 Render가 재배포되면 방 전체가
  // 같은 순간에 끊기는데, 지터가 없으면 그 인원이 5초마다 한꺼번에 다시 두드려
  // 막 올라온 서버를 또 넘어뜨린다.
  var wait = Math.round(reconnectDelay * (0.7 + Math.random() * 0.6));
  reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, wait);
  reconnectDelay = Math.min(reconnectDelay * 2, 5000);
}

function sendMessage(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showBanner('warn', '아직 서버와 연결되지 않았습니다. 잠시 후 다시 시도해 주세요.', 3000);
    return false;
  }
  ws.send(JSON.stringify(payload));
  return true;
}

// [보스 키] 내가 가리면 다른 사람들 화면도 가리도록 서버에 알린다(public/cover.js).
// 참가 전이어도 연결은 열려 있으므로 보낼 수 있다. 끊겨 있으면 조용히 넘어간다.
document.addEventListener('boss-cover', function () {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cover' }));
});
// [보스 키] 내 화면이 가려졌는지/돌아왔는지 알린다. 가려진 동안 나를 기다리는 제한시간이 멈춘다.
function sendCoverState(covered) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'coverState', covered: covered === true }));
}
document.addEventListener('boss-cover-state', function (event) { sendCoverState(!!(event.detail && event.detail.covered)); });

// ───────────────────────────── 조작 ─────────────────────────────
function enterGameScreen() {
  $('screen-join').classList.add('hidden');
  $('screen-game').classList.remove('hidden');
}

$('join-btn').onclick = function () {
  var nickname = $('nickname-input').value.trim();
  if (!nickname) return;
  myNickname = nickname;
  spectatorMode = $('spectator-input').checked;
  writeStored(MODE_KEY, String(spectatorMode));
  $('join-error').textContent = '';
  joined = true;
  enterGameScreen();
  if (kicked) {
    // 이전 소켓의 늦은 close/state가 새 연결을 건드리지 않도록 분리한다.
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try { ws.close(); } catch (e) { /* already closed */ }
      ws = null;
    }
    kicked = false;
    connect(); // onopen에서 새 참가 요청을 보낸다.
    return;
  }
  sendMessage({ type: 'join', nickname: nickname, token: readToken(), spectator: spectatorMode });
};

/**
 * 방 나가기. 서버는 이 사람의 자리를 그 자리에서 지운다(끊김과 달리 10초를 기다리지 않는다).
 * 토큰도 지운다. 남겨 두면 다시 들어올 때 방금 버린 자리로 되살아난다.
 * 소켓은 그대로 둔다 - 서버가 playerId만 떼어 내므로 같은 연결로 새로 참가할 수 있다.
 */
function leaveRoom() {
  if (kicked) return;
  sendMessage({ type: 'leave' });
  if (window.liar && window.liar.isElectron) {
    // Electron 버전에는 돌아갈 포털이 없다 - 이 화면에서 바로 접속 화면을 보여준다.
    resetRoomScreen();
    return;
  }
  // 웹 버전은 게임 포털(여러 게임을 고르는 화면)로 돌려보낸다. 곧 다른 페이지로
  // 이동하므로 접속 화면을 잠깐 그렸다 지우는 대신 저장된 토큰만 정리한다.
  saveToken(null);
  clearStored(NAME_KEY);
  setTimeout(function () { location.href = '/'; }, 80);
}

function resetRoomScreen() {
  saveToken(null);
  clearStored(NAME_KEY);
  joined = false;
  myId = null;
  myNickname = '';
  state = null;
  lastChatKey = '';
  lastNotifiedSeq = null;
  wasMyTurn = false;
  liveSignature = '';
  moderationSignature = '';
  $('moderation-panel').innerHTML = '';
  $('moderation-panel').classList.add('hidden');
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  $('chat-messages').innerHTML = '';
  $('live-block').innerHTML = '';
  $('role-card').classList.add('hidden');
  $('jump-bar').classList.add('hidden');
  hideBanner();
  $('screen-game').classList.add('hidden');
  $('screen-join').classList.remove('hidden');
  $('nickname-input').value = '';
  $('nickname-input').focus();
}

$('leave-btn').onclick = leaveRoom;
var profileMenu = document.createElement('div');
profileMenu.id = 'profile-menu';
profileMenu.className = 'hidden';
profileMenu.setAttribute('role', 'menu');
document.body.appendChild(profileMenu);
// 지금 메뉴가 누구를 향해 열려 있는가. 상태가 갱신될 때 닫을지 말지를 이걸로 정한다.
var profileMenuTargetId = null;
function closeProfileMenu() { profileMenuTargetId = null; profileMenu.classList.add('hidden'); profileMenu.innerHTML = ''; }
/** 우클릭(데스크톱)과 롱프레스(모바일)가 함께 쓰는 강퇴 메뉴 열기 */
function openKickMenu(profile, x, y) {
  closeProfileMenu();
  if (!profile || !state || !state.you || !state.you.canKick) return;
  var target = state.players.find(function (p) { return p.id === profile.getAttribute('data-player-id'); });
  if (!target || !target.connected || target.id === myId) return;
  var button = document.createElement('button');
  button.textContent = '강퇴 제안';
  button.setAttribute('role', 'menuitem');
  button.setAttribute('data-kick', target.id);
  button.disabled = !!(state.moderation && state.moderation.proposal);
  button.onclick = function () { sendMessage({ type: 'kick', targetId: target.id }); closeProfileMenu(); };
  profileMenu.appendChild(button);
  profileMenuTargetId = target.id;
  profileMenu.classList.remove('hidden');
  profileMenu.style.left = Math.max(0, Math.min(x, window.innerWidth - profileMenu.offsetWidth)) + 'px';
  profileMenu.style.top = Math.max(0, Math.min(y, window.innerHeight - profileMenu.offsetHeight)) + 'px';
  button.focus();
}
$('participant-list').addEventListener('contextmenu', function (ev) {
  var profile = ev.target.closest('[data-player-id]');
  if (!profile) { closeProfileMenu(); return; }
  ev.preventDefault();
  openKickMenu(profile, ev.clientX, ev.clientY);
});

/** iOS Safari는 일반 요소에서 contextmenu 이벤트를 주지 않으므로 롱프레스를 직접 만든다. */
var longPressTimer = null;
var longPressProfile = null;
var longPressStart = null;
var longPressFired = false;
function cancelLongPress() { clearTimeout(longPressTimer); longPressTimer = null; longPressProfile = null; longPressStart = null; }
$('participant-list').addEventListener('touchstart', function (ev) {
  if (ev.touches.length !== 1) { cancelLongPress(); return; }
  var profile = ev.target.closest('[data-player-id]');
  if (!profile) return;
  longPressFired = false;
  longPressProfile = profile;
  longPressStart = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
  longPressTimer = setTimeout(function () {
    longPressFired = true;
    openKickMenu(longPressProfile, longPressStart.x, longPressStart.y);
    longPressTimer = null;
  }, 500);
}, { passive: true });
$('participant-list').addEventListener('touchmove', function (ev) {
  if (!longPressStart) return;
  var dx = ev.touches[0].clientX - longPressStart.x;
  var dy = ev.touches[0].clientY - longPressStart.y;
  if (Math.hypot(dx, dy) > 10) cancelLongPress();
}, { passive: true });
$('participant-list').addEventListener('touchend', function (ev) {
  // 롱프레스로 메뉴를 이미 열었다면 뒤이어 오는 합성 click이 메뉴를 바로 닫지 못하게 막는다.
  if (longPressFired) { ev.preventDefault(); longPressFired = false; }
  cancelLongPress();
}, { passive: false });
$('participant-list').addEventListener('touchcancel', cancelLongPress);

document.addEventListener('click', function (ev) { if (!profileMenu.contains(ev.target)) closeProfileMenu(); });
document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeProfileMenu(); });
window.addEventListener('resize', closeProfileMenu);
// 메뉴는 참가자 줄에 붙어 뜨므로 그 줄이 움직일 때만 닫는다. 대화창이 새 글에 맞춰
// 저절로 내려가는 것까지 받아 닫으면, 누가 한 마디 하기만 해도 메뉴가 사라진다.
document.addEventListener('scroll', function (ev) {
  if (!profileMenuTargetId) return;
  var list = $('participant-list');
  var scrolled = ev.target;
  if (scrolled === document || scrolled === list || (scrolled.contains && scrolled.contains(list))) closeProfileMenu();
}, true);
$('moderation-panel').addEventListener('click', function (ev) {
  var button = ev.target.closest('button[data-kick-vote]');
  if (button && state && state.moderation && state.moderation.proposal) {
    sendMessage({ type: 'kickVote', proposalId: state.moderation.proposal.id, agree: button.getAttribute('data-kick-vote') === 'yes' });
  }
});
$('mode-toggle-btn').onclick = function () {
  if (!state || !state.you) return;
  sendMessage({ type: 'mode', spectator: !state.you.spectator });
};
$('start-btn').onclick = function () { sendMessage({ type: 'start' }); };
$('vote-btn').onclick = function () { sendMessage({ type: 'callVote' }); };
$('send-btn').onclick = function () {
  var text = $('chat-input').value.trim();
  if (!text) return;
  if (sendMessage({ type: 'chat', text: text })) { $('chat-input').value = ''; autoGrowComposer(); }
};

/**
 * 한글·일본어 입력기(IME)는 글자를 조합하는 중에도 Enter를 쓴다. "안녕하세요"를 치고
 * Enter로 조합을 확정하면 keydown이 먼저 오는데, 그걸 전송으로 받으면 조합 중이던
 * 글자가 잘린 채 나가고 곧이어 진짜 Enter가 한 번 더 전송한다. 조합 중에는 무시한다.
 * (isComposing을 안 주는 낡은 브라우저를 위해 keyCode 229도 함께 본다)
 */
function composing(ev) { return ev.isComposing || ev.keyCode === 229; }

$('nickname-input').addEventListener('keydown', function (ev) {
  if (composing(ev)) return;
  if (ev.key === 'Enter') $('join-btn').click();
});

// [요청] 입력창이 여러 줄로 늘어난다. Shift+Enter는 줄바꿈, Enter만 누르면 전송한다.
var COMPOSER_MAX_HEIGHT = 160;
function autoGrowComposer() {
  var el = $('chat-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT) + 'px';
}
$('chat-input').addEventListener('keydown', function (ev) {
  if (composing(ev)) return;
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('send-btn').click(); }
});
$('chat-input').addEventListener('input', autoGrowComposer);

// [요청] 도구줄의 굵게·취소선·코드 버튼 - 이미 지원하는 서식만 실제로 눌러서 넣는다.
// 고른 글자가 있으면 그 글자를 감싸고, 없으면 커서 자리에 기호 쌍만 넣고 그 사이에 커서를 둔다.
function wrapChatInputSelection(marker) {
  var el = $('chat-input');
  var start = el.selectionStart;
  var end = el.selectionEnd;
  var value = el.value;
  var selected = value.slice(start, end);
  el.value = value.slice(0, start) + marker + selected + marker + value.slice(end);
  el.focus();
  el.setSelectionRange(start + marker.length, start + marker.length + selected.length);
  autoGrowComposer();
}
Array.prototype.forEach.call(document.querySelectorAll('#composer-toolbar .fmt-btn[data-wrap]'), function (btn) {
  btn.onclick = function () { wrapChatInputSelection(btn.getAttribute('data-wrap')); };
});
// [요청] @ 버튼 - 커서 자리에 "@"만 넣어 준다. 실제로 누구를 부른 것인지는 서버가
// 텍스트에서 다시 찾아내므로(@닉네임), 여기서는 그 글자를 타이핑해 주는 역할만 한다.
$('mention-btn').onclick = function () {
  var el = $('chat-input');
  var start = el.selectionStart;
  var end = el.selectionEnd;
  el.value = el.value.slice(0, start) + '@' + el.value.slice(end);
  el.focus();
  el.setSelectionRange(start + 1, start + 1);
  autoGrowComposer();
};

// 진행 블록(찬반/투표/정답)은 매번 새로 그리므로 위임으로 받는다.
$('live-block').addEventListener('click', function (ev) {
  var chip = ev.target.closest('button[data-agree]');
  if (chip) { sendMessage({ type: 'proposalVote', agree: chip.dataset.agree === 'yes' }); return; }

  var opt = ev.target.closest('button[data-id]');
  if (opt) { sendMessage({ type: 'vote', targetId: opt.dataset.id }); return; }

  if (ev.target.closest('#guess-btn')) submitGuess();
});
$('live-block').addEventListener('keydown', function (ev) {
  if (composing(ev)) return;
  if (ev.key === 'Enter' && ev.target.id === 'guess-input') submitGuess();
});
function submitGuess() {
  var input = $('guess-input');
  if (!input) return;
  var word = input.value.trim();
  if (!word) return;
  sendMessage({ type: 'guess', word: word });
}

// [2번] 위로 올라가 있으면 진행 중이라고 알리고, 누르면 맨 아래로 내려간다.
$('jump-bar').onclick = function () { scrollChatToBottom(); };
$('chat').addEventListener('scroll', updateJumpBar);

function isChatAtBottom() {
  var box = $('chat');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 40;
}
function scrollChatToBottom() {
  var box = $('chat');
  box.scrollTop = box.scrollHeight;
  updateJumpBar();
}

var JUMP_TEXT = {
  turn: '설명이 진행 중입니다',
  free: '자유 대화가 진행 중입니다',
  proposal: 'O/X로 정하는 중입니다',
  voting: '투표가 진행 중입니다',
  guess: '정답을 기다리는 중입니다',
};
function updateJumpBar() {
  var bar = $('jump-bar');
  var phase = state ? state.phase : null;
  var live = JUMP_TEXT[phase];
  if (!live || isChatAtBottom()) { bar.classList.add('hidden'); return; }
  $('jump-text').textContent = live;
  bar.classList.remove('hidden');
}

// ───────────────────────────── 그리기 ─────────────────────────────
function secondsLeft(endsAt) {
  if (!endsAt) return 0;
  return Math.max(0, Math.round((endsAt - (Date.now() + serverOffset)) / 1000));
}

// 단계 제한시간의 남은 시간. [보스 키] 누가 화면을 가려 제한시간이 멈춰 있으면(pausedAt)
// 멈춘 시각을 지금으로 보고 센다 - 그래서 화면의 숫자도 멈춰 있다(web/cover-pause.js).
function phaseTimeLeft(s, endsAt) {
  var frozen = !!s.pausedAt;
  var reference = frozen ? s.pausedAt : Date.now() + serverOffset;
  var seconds = endsAt ? Math.max(0, Math.round((endsAt - reference) / 1000)) : 0;
  return '남은 시간 ' + seconds + '초' + (frozen ? ' (화면 가림으로 멈춤)' : '');
}

function clockOf(at) {
  var d = new Date(at);
  var h = d.getHours();
  var ampm = h < 12 ? '오전' : '오후';
  var hh = h % 12 || 12;
  return ampm + ' ' + hh + ':' + String(d.getMinutes()).padStart(2, '0');
}

/**
 * 슬랙의 메시지 한 덩어리(아바타 + 이름 + 시각 + 본문). 본문은 호출한 쪽이 채운다.
 *
 * [요청] 같은 사람이 연달아 말하면(opts.grouped) 아바타·이름·시각 줄을 다시 그리지 않는다.
 * 그 자리는 그냥 비워 둔다.
 */
function messageShell(opts) {
  var wrap = document.createElement('div');
  wrap.className = 'msg' + (opts.grouped ? ' grouped' : '');

  var slot = document.createElement('div');
  slot.className = 'avatar-slot';
  if (!opts.grouped) {
    var avatar = document.createElement('div');
    avatar.className = opts.system ? 'avatar sys' : 'avatar';
    avatar.textContent = opts.system ? '⚙️' : graphemeInitial(opts.name);
    if (!opts.system) avatar.style.background = avatarColorFor(opts.avatarKey || opts.name);
    slot.appendChild(avatar);
  }
  wrap.appendChild(slot);

  var body = document.createElement('div');
  body.className = 'body';

  if (!opts.grouped) {
    var who = document.createElement('div');
    who.className = 'who';
    who.appendChild(document.createTextNode(opts.system ? 'Slack bot' : (opts.name || '(이름 없음)')));
    if (opts.system) {
      var tag = document.createElement('span');
      tag.className = 'app-tag';
      tag.textContent = '앱';
      who.appendChild(tag);
    }
    if (opts.at) {
      var time = document.createElement('span');
      time.className = 'time';
      time.textContent = clockOf(opts.at);
      who.appendChild(time);
    }
    body.appendChild(who);
  }
  wrap.appendChild(body);

  wrap.body = body;
  return wrap;
}

/** 이 말이 나를 부른 것인가. */
function mentionsMe(m) {
  if (!m.mentions || !myId) return false;
  for (var i = 0; i < m.mentions.length; i += 1) {
    if (m.mentions[i].id === myId) return true;
  }
  return false;
}

// [요청] **굵게**, `인라인 코드`, ~~취소선~~을 실제 서식으로 그린다. 순서는 먼저 매치되는 쪽이 이긴다.
var FORMATS = [
  { delim: '**', tag: 'b' },
  { delim: '~~', tag: 's' },
  { delim: '`', tag: 'code' },
];

// [요청] 글자 색. `:이름[글자]`는 미리 정해 둔 색 중에서, `:#RGB[글자]`/`:#RRGGBB[글자]`는
// 원하는 색을 직접 16진수로 준다. element.style.color에 넘기므로, 이름은 아래 표에 있는
// 값만 실제로 적용되고 16진수는 정규식으로 형식을 검증한 것만 통과한다 - 둘 다 임의의
// CSS/스크립트가 새어 들어갈 여지가 없다.
var COLOR_NAMES = {
  red: '#C93A3A', orange: '#E07B53', yellow: '#946200', green: '#27500A',
  blue: '#1264A3', purple: '#8C5AC7', pink: '#C93A7A', gray: '#616061',
};
var COLOR_NAME_LIST = Object.keys(COLOR_NAMES).sort(function (a, b) { return b.length - a.length; });
var HEX_COLOR_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?/;

/** i 위치가 ":이름[" 또는 ":#RGB["로 시작하면 색과 안쪽 글자 범위를, 아니면 null을 준다. */
function matchColorSpan(text, i) {
  if (text[i] !== ':') return null;
  var rest = text.slice(i + 1);
  var color = null;
  var markerLen = 0;
  for (var n = 0; n < COLOR_NAME_LIST.length; n += 1) {
    var name = COLOR_NAME_LIST[n];
    if (rest.slice(0, name.length) === name) { color = COLOR_NAMES[name]; markerLen = name.length; break; }
  }
  if (!color) {
    var hexMatch = HEX_COLOR_RE.exec(rest);
    if (hexMatch) { color = hexMatch[0]; markerLen = hexMatch[0].length; }
  }
  if (!color || rest[markerLen] !== '[') return null;
  var openAt = i + 2 + markerLen; // ':' + 색 표시 다음이 '[', 그 다음이 내용 시작
  var closeAt = text.indexOf(']', openAt);
  if (closeAt === -1 || closeAt === openAt) return null; // 닫는 대괄호가 없거나 안이 비어 있으면 그냥 글자
  return { color: color, contentStart: openAt, contentEnd: closeAt, end: closeAt + 1 };
}

/**
 * [요청] 대화 속 "@닉네임"과 굵게·코드·취소선 서식을 함께 눈에 띄게 그린다.
 *
 * 누구를 부른 것인지는 서버가 정해서 내려준다(mentions). 화면은 그 이름이 나온 자리와
 * 서식 기호로 감싸인 자리만 찾아 바꾼다. 문자열을 직접 붙이지 않고 노드로만 쌓는 이유는,
 * 닉네임이나 대화 내용에 무엇이 들어 있든 그대로 글자로만 보이게 하기 위해서다
 * (innerHTML을 쓰지 않으므로 "<b>"처럼 생긴 글자를 쳐도 실제 태그로 새지 않는다).
 */
function chatText(m) {
  var box = document.createElement('div');
  box.className = 'text';
  var names = (m.mentions || []).map(function (x) { return x.nickname; })
    .filter(Boolean)
    .sort(function (a, b) { return b.length - a.length; }); // 겹치면 긴 쪽부터 (서버와 같은 규칙)
  appendFormatted(box, m.text == null ? '' : m.text, names);
  return box;
}

/** @멘션과 서식 기호를 함께 인식해 노드로 쌓는다. 코드 안은 다시 해석하지 않는다. */
function appendFormatted(box, text, names) {
  var buf = '';
  function flush() { if (buf) { box.appendChild(document.createTextNode(buf)); buf = ''; } }

  for (var i = 0; i < text.length;) {
    var hit = null;
    if (text[i] === '@') {
      for (var n = 0; n < names.length; n += 1) {
        if (text.slice(i + 1, i + 1 + names[n].length) === names[n]) { hit = names[n]; break; }
      }
    }
    if (hit) {
      flush();
      var chip = document.createElement('span');
      chip.className = 'mention';
      chip.textContent = '@' + hit;
      box.appendChild(chip);
      i += 1 + hit.length;
      continue;
    }

    var colorSpan = matchColorSpan(text, i);
    if (colorSpan) {
      flush();
      var span = document.createElement('span');
      span.style.color = colorSpan.color;
      appendFormatted(span, text.slice(colorSpan.contentStart, colorSpan.contentEnd), names); // 색 안의 굵게·멘션은 계속 인식한다
      box.appendChild(span);
      i = colorSpan.end;
      continue;
    }

    var fmt = null;
    var closeAt = -1;
    for (var f = 0; f < FORMATS.length; f += 1) {
      var d = FORMATS[f].delim;
      if (text.slice(i, i + d.length) !== d) continue;
      var close = text.indexOf(d, i + d.length);
      if (close === -1 || close === i + d.length) continue; // 닫는 기호가 없거나 안이 비어 있으면 그냥 글자
      fmt = FORMATS[f];
      closeAt = close;
      break;
    }
    if (fmt) {
      flush();
      var inner = text.slice(i + fmt.delim.length, closeAt);
      var el = document.createElement(fmt.tag);
      if (fmt.tag === 'code') el.textContent = inner;
      else appendFormatted(el, inner, names); // 굵게·취소선 안의 @멘션은 계속 인식한다
      box.appendChild(el);
      i = closeAt + fmt.delim.length;
      continue;
    }

    buf += text[i];
    i += 1;
  }
  flush();
}

/** 사람 이름과 위장 단어를 강조한 한 줄. 서버가 준 code로 화면이 문구를 만든다. */
function systemLine(m) {
  var p = document.createElement('div');
  p.className = 'text';

  function who(name) {
    var s = document.createElement('span');
    s.className = 'who-hl';
    s.textContent = name;
    return s;
  }
  function liar() {
    var s = document.createElement('span');
    s.className = 'liar-hl';
    s.textContent = LABELS.liar;
    return s;
  }

  if (m.code === 'accused' && m.who) {
    // 요청: "Slack bot : ○○○이 (담당자)로 지목되었습니다"
    p.appendChild(who(m.who));
    p.appendChild(document.createTextNode('님이 '));
    p.appendChild(liar());
    p.appendChild(document.createTextNode(josa(LABELS.liar, '으로', '로') + ' 지목되었습니다.'));
  } else if (m.code === 'proposalCalled' && m.who) {
    p.appendChild(who(m.who));
    p.appendChild(document.createTextNode('님이 투표를 제안했습니다.'));
  } else if (m.code === 'result') {
    return buildResultCard(m);
  } else if (m.code === 'speakRoundStart') {
    p.textContent = m.speakRound + '차 설명을 시작합니다.';
  } else if (m.code === 'turnSkipped' && m.who) {
    p.appendChild(who(m.who));
    p.appendChild(document.createTextNode('님이 설명 시간을 넘겼습니다.'));
  } else if (m.code === 'nextRoundAsked') {
    p.textContent = m.speakRound + '차 설명이 끝났습니다. ' + m.nextRound + '차 설명을 할까요?';
  } else if (m.code === 'roundsSkipped') {
    p.textContent = '설명을 여기서 마칩니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ')';
  } else if (m.code === 'freeAsked') {
    p.textContent = (m.speakRounds > 1 ? m.speakRounds + '차 설명까지 끝났습니다.' : '설명이 모두 끝났습니다.')
      + ' 자유 대화를 할까요?';
  } else if (m.code === 'freeSkipped') {
    p.textContent = '자유 대화를 건너뜁니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ')';
  } else if (m.code === 'freeStart') {
    p.textContent = '이제 자유롭게 이야기하세요. (1분)';
  } else if (m.code === 'votingStarted') {
    // 찬반을 거쳐 온 경우와, 자유 대화 시간이 다 돼서 그냥 넘어온 경우를 구분한다.
    p.textContent = (m.from === 'freeSkipped' || m.from === 'roundsSkipped')
      ? '투표를 진행합니다.'
      : m.byProposal === false
        ? '자유 대화 시간이 끝났습니다. 투표를 진행합니다.'
        : '투표를 진행합니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ')';
  } else if (m.code === 'proposalRejected') {
    p.textContent = '투표 제안이 부결되었습니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ') 대화를 이어가세요.';
  } else {
    p.textContent = m.text || '';
  }
  return p;
}

/**
 * [요청] 결과를 팝업 카드 대신 대화 속 시스템 메시지로 남긴다.
 *
 * 예전에는 화면 아래 별도 카드(#result-panel)로 떴다. 다른 안내(System)와 다르게 생겨서
 * 눈에 잘 안 띄고, 다음 판을 시작하면 사라져 되짚어 볼 수도 없었다. 이제는 다른 시스템
 * 메시지와 같은 자리에, 다만 더 자세한 카드 모양으로 대화 기록에 그대로 남는다.
 */
function buildResultCard(m) {
  var card = document.createElement('div');
  card.className = 'text result-card '
    + (m.winner === 'liar' ? 'win-liar' : m.winner === 'citizens' ? 'win-citizens' : 'win-none');

  var headline = document.createElement('div');
  headline.className = 'headline';
  headline.textContent = m.winner === 'liar' ? LABELS.liar + ' 승리!'
    : m.winner === 'citizens' ? '시민 팀 승리!' : '라운드 취소';
  card.appendChild(headline);

  var reasons = {
    tie: '투표가 동점이었습니다.',
    noVotes: '제한 시간 안에 아무도 투표하지 않았습니다.',
    wrongAccusation: LABELS.liar + josa(LABELS.liar, '은 ', '는 ')
      + (m.accused ? m.accused.nickname : '지목된 사람') + '님이 아닙니다.',
    guessTimeout: LABELS.liar + josa(LABELS.liar, '이 ', '가 ') + '제한 시간 안에 제시어를 맞히지 못했습니다.',
    // 불리해졌다고 창을 닫아 버리면 진 것으로 본다.
    liarLeft: m.liarName + '님이 ' + LABELS.liar + josa(LABELS.liar, '이었는데 ', '였는데 ')
      + '도중에 나갔습니다.',
    hostLeft: '게임을 진행하던 사람의 접속이 끊겨 라운드가 취소되었습니다.',
    guess: m.winner === 'liar'
      ? LABELS.liar + josa(LABELS.liar, '이 ', '가 ') + '제시어를 맞혔습니다!'
      : LABELS.liar + josa(LABELS.liar, '이 ', '가 ') + '제시어를 맞히지 못했습니다.',
  };
  var why = document.createElement('div');
  why.className = 'why';
  why.textContent = reasons[m.reason] || '';
  card.appendChild(why);

  var facts = document.createElement('div');
  facts.className = 'facts';
  facts.appendChild(fact(LABELS.liar, m.liarName + '님'));
  facts.appendChild(fact('제시어', m.word));
  if (m.guess) facts.appendChild(fact('제출한 답', m.guess));
  card.appendChild(facts);

  return card;
}

function renderChat(s) {
  // 길이로만 판단하면 안 된다. 대화가 상한(100줄)에 닿은 뒤로는 한 줄 밀어내고 한 줄
  // 넣느라 길이가 계속 100이라, 그 시점부터 새 글이 화면에 안 붙는다.
  // 서버가 붙여 주는 글 번호를 같이 본다.
  var key = s.chat.length + ':' + (s.chat.length ? s.chat[s.chat.length - 1].seq : 0);
  if (key === lastChatKey) return;
  var wasAtBottom = isChatAtBottom();

  // [이슈] 지문(lastChatKey)은 다 그린 뒤에 남긴다.
  // 먼저 남기면, 그리다가 한 줄에서 문제가 생겼을 때 이미 비워 둔 대화창이 빈 채로 남고
  // 지문은 최신이라 다음부터 "그릴 것이 없다"고 판단해 버린다 - 대화가 영영 안 보인다.
  // 나중에 남기면 다음 상태에서 다시 그려 보므로 스스로 회복한다.
  var box = $('chat-messages');
  box.innerHTML = '';

  if (s.chat.length === 0) {
    var empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = s.phase === 'lobby'
      ? '아직 대화가 없습니다. 참가자가 모이면 게임을 시작하세요.'
      : '아직 대화가 없습니다.';
    box.appendChild(empty);
  }

  // [요청] 같은 사람이 짧은 간격을 두고 연달아 말하면 아바타·이름을 한 번만 보여준다.
  var prevChatId = null;
  var prevChatAt = 0;
  // 제안 세 가지(다음 설명 / 자유 대화 / 투표)는 아래 진행 블록이 같은 문장을 버튼과
  // 함께 다시 그린다. 그래서 진행 블록이 실제로 떠 있는 동안에만 건너뛴다.
  //   - 진행 블록은 이번 판 참가자에게만 나온다. 관전자는 대화 쪽으로 봐야 한다.
  //   - 제안이 끝나면 블록이 사라지므로, 무엇을 물었는지는 기록으로 남아야 한다.
  // 예전에는 투표 제안만, 그것도 조건 없이 지워서 나머지 둘은 두 번 찍히고
  // 투표 제안은 관전자에게도 기록에도 영영 보이지 않았다.
  var liveAsk = s.phase === 'proposal' && s.round && s.round.proposal && s.you && s.you.inRound;
  var ASK_CODES = ['nextRoundAsked', 'freeAsked', 'proposalCalled'];
  s.chat.forEach(function (m) {
    if (liveAsk && ASK_CODES.indexOf(m.code) >= 0) return;
    var isSystem = m.kind === 'system';
    var grouped = !isSystem && prevChatId === m.id && (m.at - prevChatAt) < GROUP_WINDOW_MS;
    var shell = messageShell({ system: isSystem, name: m.name, at: m.at, grouped: grouped, avatarKey: m.id });
    if (isSystem) {
      shell.body.appendChild(systemLine(m));
      prevChatId = null; // 시스템 안내가 끼면 묶음이 끊긴다
    } else {
      shell.body.appendChild(chatText(m));
      // 나를 부른 말은 한눈에 보여야 한다. 안 그러면 대화가 빠를 때 그냥 지나간다.
      if (mentionsMe(m)) shell.classList.add('mentions-me');
      prevChatId = m.id;
      prevChatAt = m.at;
    }
    box.appendChild(shell);
  });
  lastChatKey = key;   // 여기까지 왔으면 실제로 다 그려진 것이다
  if (wasAtBottom) scrollChatToBottom();
}

/** 지금 답해야 하는 것을 대화 끝에 이어 붙인다. 내용이 바뀔 때만 다시 그린다. */
function renderLive(s) {
  var sig = liveSignatureOf(s);
  var block = $('live-block');
  if (sig === liveSignature) { refreshLiveTimers(s); return; }
  liveSignature = sig;

  var wasAtBottom = isChatAtBottom();
  block.innerHTML = '';

  if (s.phase === 'turn' && s.round && s.round.speaker) {
    block.appendChild(buildTurn(s));
  } else if (s.phase === 'free' && s.round) {
    block.appendChild(buildFree(s));
  } else if (s.phase === 'proposal' && s.round && s.round.proposal && s.you && s.you.inRound) {
    block.appendChild(buildProposal(s));
  } else if (s.phase === 'voting' && s.round && s.you && s.you.inRound) {
    block.appendChild(buildVote(s));
  } else if (s.phase === 'guess' && s.you && s.you.canGuess) {
    block.appendChild(buildGuess(s));
  }

  if (wasAtBottom || sig !== '') scrollChatToBottom();
  updateJumpBar();
}

/** 다시 그릴지 판단하는 지문. 남은 시간은 뺀다(1초마다 숫자만 갈아 끼운다). */
function liveSignatureOf(s) {
  // 설명/자유 단계는 관전자에게도 보여 준다. 지금 무엇을 하는 중인지는 모두가 알아야 한다.
  // 사람이 빠져도 다시 그려야 하므로 남은 인원을 지문에 넣는다.
  var here = s.round ? s.round.roster.filter(function (r) { return !r.left; }).length : 0;
  if (s.phase === 'turn' && s.round && s.round.speaker) {
    return 't|' + s.round.speakRound + '|' + s.round.speaker.id + '|'
      + s.round.spokenCount + '|' + s.round.speakTotal + '|' + here;
  }
  if (s.phase === 'free' && s.round) return 'f|' + s.round.spokenCount + '|' + here;
  if (!s.you || !s.you.inRound) return '';
  if (s.phase === 'proposal' && s.round && s.round.proposal) {
    var p = s.round.proposal;
    return 'p|' + p.kind + '|' + p.agree + '|' + p.disagree + '|' + p.total + '|' + s.you.proposalAnswer;
  }
  if (s.phase === 'voting' && s.round) {
    return 'v|' + s.round.voted + '|' + s.round.total + '|' + s.you.hasVoted + '|' + here;
  }
  if (s.phase === 'guess' && s.you.canGuess) return 'g';
  return '';
}

/**
 * 설명 단계. 랜덤으로 대화권을 넘기며 한 명씩 설명한다. 1인 1회.
 * 지금 누구 차례인지가 화면에서 제일 커야 한다 - 내 차례를 놓치면 그냥 넘어가 버린다.
 */
function buildTurn(s) {
  var sp = s.round.speaker;
  var mine = !!(s.you && s.you.myTurn);
  var shell = messageShell({ system: true, at: s.round.speakEndsAt - 60000 });

  var text = document.createElement('div');
  text.className = 'text';
  var mic = document.createElement('span');
  mic.className = 'turn-mic';
  mic.textContent = '🎙️';
  text.appendChild(mic);
  if (s.round.speakRounds > 1) {
    var badge = document.createElement('span');
    badge.className = 'round-badge';
    badge.textContent = s.round.speakRound + '차';
    text.appendChild(badge);
  }
  if (mine) {
    var me = document.createElement('span');
    me.className = 'who-hl';
    me.textContent = '내 차례';
    text.appendChild(me);
    text.appendChild(document.createTextNode('입니다. 제시어를 한 번만 설명하세요.'));
  } else {
    var w = document.createElement('span');
    w.className = 'who-hl';
    w.textContent = sp.nickname;
    text.appendChild(w);
    text.appendChild(document.createTextNode('님이 설명하는 중입니다.'));
  }
  shell.body.appendChild(text);
  shell.body.appendChild(speakerTrack(s));

  var meta = document.createElement('p');
  meta.className = 'meta-line';
  meta.id = 'live-meta';
  meta.textContent = metaTurn(s);
  shell.body.appendChild(meta);

  if (mine) shell.classList.add('my-turn');
  return shell;
}

/** 누가 설명을 마쳤는지 한 줄로. 이름 앞에 ✅(마침) / 🎙️(지금) / ⏳(대기). */
function speakerTrack(s) {
  var track = document.createElement('div');
  track.className = 'track';
  var byId = {};
  s.players.forEach(function (p) { byId[p.id] = p; });

  s.round.roster.forEach(function (r) {
    var p = byId[r.id] || {};
    var pill = document.createElement('span');
    pill.className = 'pill' + (r.left ? ' gone' : p.speaking ? ' now' : p.spoke ? ' done' : '');
    var em = document.createElement('span');
    em.className = 'em';
    em.textContent = r.left ? '🚪' : p.speaking ? '🎙️' : p.spoke ? '✅' : '⏳';
    pill.appendChild(em);
    pill.appendChild(document.createTextNode(r.nickname));
    track.appendChild(pill);
  });
  return track;
}

function metaTurn(s) {
  var rounds = s.round.speakRounds > 1
    ? ' · 설명은 ' + s.round.speakRounds + '차까지 돕니다'
    : '';
  return phaseTimeLeft(s, s.round.speakEndsAt) + ' · '
    + s.round.speakTotal + '명 중 ' + s.round.spokenCount + '명 설명함'
    + ' · 한 바퀴에 1인 1회' + rounds;
}

/** 전원이 설명을 마친 뒤의 자유 대화 1분. 여기서만 투표를 제안할 수 있다. */
function buildFree(s) {
  var shell = messageShell({ system: true, at: s.round.freeEndsAt - 60000 });

  var text = document.createElement('div');
  text.className = 'text';
  var em = document.createElement('span');
  em.className = 'turn-mic';
  em.textContent = '💬';
  text.appendChild(em);
  text.appendChild(document.createTextNode('자유 대화 중입니다. 누가 '));
  var l = document.createElement('span');
  l.className = 'liar-hl';
  l.textContent = LABELS.liar;
  text.appendChild(l);
  text.appendChild(document.createTextNode('일지 이야기해 보세요.'));
  shell.body.appendChild(text);

  var meta = document.createElement('p');
  meta.className = 'meta-line';
  meta.id = 'live-meta';
  meta.textContent = metaFree(s);
  shell.body.appendChild(meta);
  return shell;
}

function metaFree(s) {
  return phaseTimeLeft(s, s.round.freeEndsAt) + ' · '
    + '🎧 를 누르면 투표를 제안할 수 있습니다 · 시간이 다 되면 바로 투표로 넘어갑니다';
}

function buildProposal(s) {
  var p = s.round.proposal;
  var shell = messageShell({ system: true, at: p.endsAt - 20000 });

  var text = document.createElement('div');
  text.className = 'text';
  if (p.kind === 'nextRound') {
    // 한 바퀴가 끝나고 "다음 바퀴를 돌까요?"를 묻는 경우.
    text.appendChild(document.createTextNode(
      s.round.speakRound + '차 설명이 끝났습니다. ' + (s.round.speakRound + 1) + '차 설명을 할까요?'));
  } else if (p.kind === 'free') {
    // 설명을 다 돌고 나서 "자유 대화를 할까요?"를 묻는 경우. 제안한 사람이 없다.
    text.appendChild(document.createTextNode('설명이 모두 끝났습니다. 자유 대화를 할까요?'));
  } else {
    var w = document.createElement('span');
    w.className = 'who-hl';
    w.textContent = p.byName;
    text.appendChild(w);
    text.appendChild(document.createTextNode('님이 투표를 제안했습니다. 진행할까요?'));
  }
  shell.body.appendChild(text);

  var chips = document.createElement('div');
  chips.className = 'chips';
  chips.appendChild(chip('yes', '✅', p.agree, s.you.proposalAnswer === true));
  chips.appendChild(chip('no', '❌', p.disagree, s.you.proposalAnswer === false));
  shell.body.appendChild(chips);

  var meta = document.createElement('p');
  meta.className = 'meta-line';
  meta.id = 'live-meta';
  meta.textContent = metaProposal(s);
  shell.body.appendChild(meta);
  return shell;
}

function chip(value, emoji, count, picked) {
  var b = document.createElement('button');
  b.className = picked ? 'chip picked' : 'chip';
  b.dataset.agree = value;
  var em = document.createElement('span');
  em.className = 'em';
  em.textContent = emoji;
  var n = document.createElement('span');
  n.className = 'n';
  n.textContent = count;
  b.appendChild(em);
  b.appendChild(n);
  return b;
}

function metaProposal(s) {
  var p = s.round.proposal;
  return phaseTimeLeft(s, p.endsAt) + ' · ' + p.total + '명 중 ' + (p.agree + p.disagree) + '명 응답'
    + (p.kind === 'nextRound'
      ? ' · 찬성이 절반 이상이면 다음 설명, 아니면 바로 투표로 넘어갑니다'
      : p.kind === 'free'
        ? ' · 찬성이 절반 이상이면 자유 대화, 아니면 바로 투표로 넘어갑니다'
        : ' · 찬성이 절반 이상이면 투표로 넘어갑니다');
}

function buildVote(s) {
  var shell = messageShell({ system: true, at: s.round.votingEndsAt - 30000 });

  var text = document.createElement('div');
  text.className = 'text';
  text.appendChild(document.createTextNode('누가 '));
  var l = document.createElement('span');
  l.className = 'liar-hl';
  l.textContent = LABELS.liar;
  text.appendChild(l);
  text.appendChild(document.createTextNode('일까요? 한 명을 고르세요.'));
  shell.body.appendChild(text);

  if (s.you.hasVoted) {
    var done = document.createElement('div');
    done.className = 'meta-line';
    done.textContent = '투표했습니다. 다른 사람을 기다리는 중...';
    shell.body.appendChild(done);
  } else {
    var opts = document.createElement('div');
    opts.className = 'opts';
    // 이미 방을 나간 사람은 고를 수 없다. 서버도 같은 규칙으로 막는다.
    s.round.roster.filter(function (p) { return p.id !== myId && !p.left; }).forEach(function (p) {
      var b = document.createElement('button');
      b.className = p.connected ? 'opt' : 'opt offline';
      b.dataset.id = p.id;
      var mini = document.createElement('span');
      mini.className = 'mini';
      mini.textContent = graphemeInitial(p.nickname);
      mini.style.background = avatarColorFor(p.id);
      b.appendChild(mini);
      b.appendChild(document.createTextNode(p.nickname));
      // 접속이 끊긴 사람도 계속 후보로 남지만(10초 유예 안 돌아올 수 있다), 지금
      // 답할 수 없는 상태라는 것은 알려 준다.
      if (!p.connected) {
        var tag = document.createElement('span');
        tag.className = 'cnt';
        tag.textContent = '오프라인';
        b.appendChild(tag);
      }
      opts.appendChild(b);
    });
    shell.body.appendChild(opts);
  }

  var meta = document.createElement('p');
  meta.className = 'meta-line';
  meta.id = 'live-meta';
  meta.textContent = metaVote(s);
  shell.body.appendChild(meta);
  return shell;
}

function metaVote(s) {
  return phaseTimeLeft(s, s.round.votingEndsAt) + ' · '
    + s.round.total + '명 중 ' + s.round.voted + '명 투표함';
}

function buildGuess(s) {
  var shell = messageShell({ system: true, at: s.round.guessEndsAt - 30000 });

  var text = document.createElement('div');
  text.className = 'text';
  var l = document.createElement('span');
  l.className = 'liar-hl';
  l.textContent = LABELS.liar;
  text.appendChild(l);
  text.appendChild(document.createTextNode('으로 지목되었습니다. 제시어를 맞히면 역전승합니다.'));
  shell.body.appendChild(text);

  var row = document.createElement('div');
  row.className = 'guess-row';
  var input = document.createElement('input');
  input.id = 'guess-input';
  input.placeholder = '제시어 입력';
  input.maxLength = 60;
  input.autocomplete = 'off';
  var btn = document.createElement('button');
  btn.id = 'guess-btn';
  btn.textContent = '제출';
  row.appendChild(input);
  row.appendChild(btn);
  shell.body.appendChild(row);

  var meta = document.createElement('p');
  meta.className = 'meta-line';
  meta.id = 'live-meta';
  meta.textContent = metaGuess(s);
  shell.body.appendChild(meta);
  return shell;
}

function metaGuess(s) { return phaseTimeLeft(s, s.round.guessEndsAt); }

/** 남은 시간만 1초마다 갈아 끼운다. 블록 전체를 다시 그리면 입력 중인 글자가 날아간다. */
function refreshLiveTimers(s) {
  var kickMeta = $('kick-meta');
  if (kickMeta && s.moderation && s.moderation.proposal) kickMeta.textContent = moderationMeta(s.moderation.proposal);
  var meta = $('live-meta');
  if (!meta || !s.round) return;
  if (s.phase === 'turn') meta.textContent = metaTurn(s);
  else if (s.phase === 'free') meta.textContent = metaFree(s);
  else if (s.phase === 'proposal' && s.round.proposal) meta.textContent = metaProposal(s);
  else if (s.phase === 'voting') meta.textContent = metaVote(s);
  else if (s.phase === 'guess') meta.textContent = metaGuess(s);
}

function renderParticipants(s) {
  // 예전에는 여기서 무조건 닫았다. 상태는 누가 한 마디만 해도 다시 오므로, 방금 연
  // 강퇴 메뉴가 그 자리에서 사라져 실제 게임 중에는 누를 수가 없었다.
  // 지목한 사람이 목록에서 사라졌을 때만 닫는다(메뉴 자체는 body에 있어 목록을 다시
  // 그려도 살아남는다).
  if (profileMenuTargetId && !s.players.some(function (p) { return p.id === profileMenuTargetId && p.connected; })) {
    closeProfileMenu();
  }
  var list = $('participant-list');
  list.innerHTML = '';
  var online = s.players.filter(function (p) { return p.connected; }).length;
  $('member-count').querySelector('b').textContent = online;

  s.players.forEach(function (p) {
    var li = document.createElement('li');
    li.setAttribute('data-player-id', p.id);
    if (!p.connected) li.className = 'offline';
    else if (p.spectator || (s.phase !== 'lobby' && s.phase !== 'result' && !p.inRound)) li.className = 'spectator';

    // [요청] 이름 앞에 사람마다 다른 색의 아바타 + 우하단에 접속 상태 배지.
    // 실제로 구분할 수 있는 상태는 연결됨/끊김 두 가지뿐이다(자리비움 같은 중간 상태는 없다).
    var avatarWrap = document.createElement('span');
    avatarWrap.className = 'p-avatar-wrap';
    var avatar = document.createElement('span');
    avatar.className = 'p-avatar';
    avatar.style.background = avatarColorFor(p.id);
    avatar.textContent = graphemeInitial(p.nickname);
    var badge = document.createElement('span');
    badge.className = 'p-badge ' + (p.connected ? 'online' : 'offline');
    avatarWrap.appendChild(avatar);
    avatarWrap.appendChild(badge);
    li.appendChild(avatarWrap);

    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.nickname + (p.id === myId ? ' (나)' : '');
    li.appendChild(name);

    var tagText = null;
    var tagClass = 'tag';
    if (!p.connected) tagText = '끊김';
    else if (p.spectator) tagText = '관전';
    else if (s.phase === 'turn' && p.inRound) {
      if (p.speaking) { tagText = '설명 중'; tagClass += ' speaking'; }
      else if (p.spoke) { tagText = '완료'; tagClass += ' voted'; }
      else tagText = '대기';
    } else if (s.phase === 'free' && p.inRound && p.spoke) { tagText = '완료'; tagClass += ' voted'; }
    else if (s.phase === 'proposal' && p.inRound) { tagText = p.answered ? '답함' : '대기'; if (p.answered) tagClass += ' voted'; }
    else if (s.phase === 'voting' && p.inRound) { tagText = p.voted ? '투표함' : '대기'; if (p.voted) tagClass += ' voted'; }
    else if (s.phase !== 'lobby' && s.phase !== 'result' && !p.inRound) tagText = '관전';

    if (tagText) {
      var tag = document.createElement('span');
      tag.className = tagClass;
      tag.textContent = tagText;
      li.appendChild(tag);
    }
    list.appendChild(li);
  });
}

/** 전적은 사이드바 맨 아래에 버전 표기처럼 둔다. */
function renderModeration(s) {
  var panel = $('moderation-panel');
  var data = s.moderation;
  var signature = JSON.stringify(data || null);
  if (signature === moderationSignature) return;
  moderationSignature = signature;
  panel.innerHTML = '';
  panel.classList.toggle('hidden', !data || (!data.proposal && (!data.result || data.result.passed)));
  if (!data) return;
  var vote = data.proposal;
  var shell = messageShell({ system: true, at: vote ? vote.endsAt - 30000 : null });
  var text = document.createElement('div');
  text.className = 'text';
  if (!vote) {
    if (data.result && !data.result.passed) {
      text.textContent = data.result.message;
      shell.body.appendChild(text);
      panel.appendChild(shell);
    }
    return;
  }
  text.textContent = vote.targetName + '님을 강퇴할까요?';
  shell.body.appendChild(text);
  var chips = document.createElement('div');
  chips.className = 'chips';
  ['yes', 'no'].forEach(function (answer) {
    var yes = answer === 'yes';
    var button = chip(answer, yes ? '✅' : '❌', yes ? vote.agree : vote.disagree, vote.answer === yes);
    button.removeAttribute('data-agree');
    button.setAttribute('data-kick-vote', answer);
    button.setAttribute('aria-label', yes ? '강퇴 찬성' : '강퇴 반대');
    button.setAttribute('aria-pressed', String(vote.answer === yes));
    button.disabled = !vote.canVote;
    chips.appendChild(button);
  });
  shell.body.appendChild(chips);
  var meta = document.createElement('p');
  meta.id = 'kick-meta';
  meta.className = 'meta-line';
  meta.textContent = moderationMeta(vote);
  shell.body.appendChild(meta);
  panel.appendChild(shell);
}

function moderationMeta(vote) {
  return '남은 시간 ' + secondsLeft(vote.endsAt) + '초 · 찬성 ' + vote.required
    + '명 필요 (대상 제외 ' + vote.total + '명)';
}

function renderTally(s) {
  var el = $('tally-label');
  if (!s.record || s.record.rounds === 0) { el.textContent = ''; return; }
  el.textContent = s.record.rounds + '판 · ' + LABELS.liar + ' ' + s.record.liarWins + ' / 시민 ' + s.record.citizenWins;
}

/** 라운드 사이(대기·정산 후)에는 나갔다 들어오지 않아도 관전⇄참가를 바꿀 수 있다. */
function renderModeToggle(s) {
  var btn = $('mode-toggle-btn');
  if (!s.you || !s.you.canChangeMode) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  btn.textContent = s.you.spectator ? '참가자로 전환' : '관전으로 전환';
  btn.title = s.you.spectator ? '다음 판부터 참가자로 전환합니다' : '다음 판부터 관전으로 전환합니다';
}

/**
 * [요청] 본인에게만 보이는 역할 카드. 클릭하면 접었다 펼 수 있다.
 *
 * 접혀도 "누구인지" 한 줄(head)은 그대로 보인다 - 지금 내가 무슨 카드를 보고 있는지는
 * 알아야 하기 때문이다. 접으면 카테고리·제시어 같은 자세한 내용(detail)만 사라진다.
 */
function renderRoleCard(s) {
  var card = $('role-card');
  if (s.phase === 'lobby' || s.phase === 'result' || !s.you || !s.you.inRound) {
    card.classList.add('hidden');
    card.onclick = null;
    return;
  }
  if (card.classList.contains('hidden')) roleCardOpen = true; // 새로 나타날 때는 펼친 채로 시작한다
  card.classList.remove('hidden');
  // [요청] 맨 위(접힌 상태)에는 카테고리만 보인다 - 역할에 따라 다른 글자가 아니라서,
  // 옆에서 흘끗 봐서는 라이어인지조차 알 수 없다. 클릭해서 펼쳐야 라이어 여부와
  // 제시어(또는 모른다는 사실)가 나온다.
  if (s.you.isLiar) {
    buildRoleCard(card, 'liar', '카테고리: ' + s.you.category,
      LABELS.liar + '입니다 · 제시어는 모릅니다');
  } else if (s.you.word) {
    buildRoleCard(card, 'citizen', '카테고리: ' + s.you.category,
      LABELS.liar + josa(LABELS.liar, '이 아닙니다', '가 아닙니다') + ' · 제시어: ' + s.you.word);
  } else {
    card.className = 'pending';
    card.onclick = null;
    card.textContent = '역할을 받는 중입니다...';
  }
}

function buildRoleCard(card, kind, headText, detailText) {
  card.className = kind;
  card.innerHTML = '';
  card.onclick = function () { roleCardOpen = !roleCardOpen; renderRoleCard(state); };

  var head = document.createElement('div');
  head.className = 'role-head';
  var chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = roleCardOpen ? '▾' : '▸';
  head.appendChild(chev);
  var line = document.createElement('span');
  line.className = 'role-line';
  line.textContent = headText;
  head.appendChild(line);
  card.appendChild(head);

  if (roleCardOpen) {
    card.appendChild(document.createTextNode('\n')); // head/detail의 글자가 붙어 읽히지 않게
    var detail = document.createElement('div');
    detail.className = 'role-line role-detail';
    detail.textContent = detailText;
    card.appendChild(detail);
  }
}

function fact(label, value) {
  var box = document.createElement('div');
  box.className = 'fact';
  var k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  var v = document.createElement('b');
  v.textContent = value;
  box.appendChild(k);
  box.appendChild(v);
  return box;
}

/**
 * 입력창을 지금 쓸 수 있는지, 못 쓴다면 왜 못 쓰는지. 서버 say()와 같은 규칙이다.
 * 화면에서만 막으면 개발자 도구로 우회되므로 서버가 최종 판정을 하고, 여기서는
 * "왜 회색인지"를 알려 주는 역할만 한다. 그냥 회색이면 고장으로 보인다.
 */
function applyComposer(s) {
  var input = $('chat-input');
  var locked = true;
  var hint = '댓글 남기기...';

  if (s.phase === 'lobby' || s.phase === 'result') {
    locked = false;
  } else if (!s.you || !s.you.inRound) {
    hint = '이번 라운드는 관전 중입니다';
  } else if (s.phase === 'turn') {
    if (s.you.myTurn) {
      locked = false;
      hint = '내 차례입니다. 제시어를 한 번만 설명하세요';
    } else {
      hint = (s.round && s.round.speaker ? s.round.speaker.nickname + '님이 설명하는 중입니다' : '설명이 진행 중입니다');
    }
  } else if (s.phase === 'free') {
    locked = false;
    hint = '자유롭게 이야기하세요...';
  } else if (s.phase === 'proposal' && s.round && s.round.proposal && s.round.proposal.kind === 'nextRound') {
    hint = '다음 설명을 할지 정하는 중입니다';
  } else if (s.phase === 'proposal' && s.round && s.round.proposal && s.round.proposal.kind === 'free') {
    hint = '자유 대화를 할지 정하는 중입니다';
  } else {
    // 투표 버튼을 누른 순간(찬반)부터 결과가 날 때까지 대화를 막는다.
    hint = '투표가 끝날 때까지 대화할 수 없습니다';
  }

  input.disabled = locked;
  $('send-btn').disabled = locked;
  input.placeholder = hint;
  document.getElementById('composer').classList.toggle('my-turn', !locked && s.phase === 'turn');
}

/**
 * [요청] 창을 내려 둔 사이에 대화가 오거나 내 차례가 되면 트레이/작업 표시줄로 알린다.
 *
 * Electron에서만 동작한다(브라우저에는 트레이가 없다). 창이 눈앞에 있는지는 메인 쪽에서
 * 판단하므로 여기서는 "알릴 만한 일"만 가린다.
 *   - 남이 친 대화가 새로 왔을 때 (내가 친 것은 제외)
 *   - 내 차례가 아니었다가 내 차례가 됐을 때
 */
function notifyIfWorthIt(s) {
  if (!window.liar || typeof window.liar.notifyAttention !== 'function') return;

  var last = s.chat.length ? s.chat[s.chat.length - 1] : null;
  var seq = last ? last.seq : 0;
  var myTurn = !!(s.you && s.you.myTurn);

  // 처음 그리는 순간에는 이미 쌓여 있던 것뿐이라 알리지 않는다.
  if (lastNotifiedSeq === null) {
    lastNotifiedSeq = seq;
    wasMyTurn = myTurn;
    return;
  }

  var newChat = seq > lastNotifiedSeq && last && last.kind === 'chat' && last.id !== myId;
  var turnCameToMe = myTurn && !wasMyTurn;
  lastNotifiedSeq = seq;
  wasMyTurn = myTurn;

  if (newChat || turnCameToMe) {
    try { window.liar.notifyAttention(); } catch (e) { /* 알림은 없어도 게임은 돈다 */ }
  }
}

function render(s) {
  if (kicked) return;
  if (s.you) {
    spectatorMode = !!s.you.spectator;
    writeStored(MODE_KEY, String(spectatorMode));
  }
  state = s;
  if (s.you) myId = s.you.id;

  // 입력창부터 정한다. 아래에서 그리다가 문제가 생겨도 대화까지 막히면 안 된다.
  // (예전에 "방이 리셋될 때까지 채팅이 안 된다"는 신고가 이런 모양이었다.)
  applyComposer(s);

  // 역할 카드가 뜨거나 배너가 붙으면 그만큼 대화 영역 높이가 바뀐다. 그리기 직전에
  // 맨 아래를 보고 있었다면, 다 그린 뒤에도 맨 아래를 보고 있도록 한 번 더 내린다.
  var wasAtBottom = isChatAtBottom();

  try {
    renderParticipants(s);
    renderTally(s);
    renderModeToggle(s);
    renderRoleCard(s);
    renderChat(s);
    renderLive(s);
    renderModeration(s);
  } catch (err) {
    // 조용히 삼키지 않는다. 화면은 계속 쓸 수 있게 두되, 원인은 남긴다.
    console.error('화면을 그리는 중 문제가 생겼습니다:', err);
  }

  notifyIfWorthIt(s);

  var lobbyish = s.phase === 'lobby' || s.phase === 'result';
  // [요청] 돋보기 아이콘만 있는 버튼이라 글자는 title(말풍선 안내)로만 남긴다.
  // [모바일] 마우스가 없는 기기는 말풍선이 뜨지 않아서 그때만 글자(.btn-label)를 보인다(style.css).
  var startText = s.phase === 'result' ? '다음 라운드' : '게임 시작';
  $('start-btn').disabled = !s.canStart;
  $('start-btn').title = startText;
  $('start-btn').setAttribute('aria-label', startText);
  var startLabel = $('start-btn').querySelector('.btn-label');
  if (startLabel) startLabel.textContent = startText;
  $('start-btn').classList.toggle('hidden', !lobbyish);
  // 투표 제안은 자유 대화 때만. 설명이 끝나기 전에는 누를 수 없다.
  $('vote-btn').disabled = !(s.phase === 'free' && s.you && s.you.inRound);
  $('vote-btn').title = s.phase === 'turn' ? '설명이 끝나면 투표를 제안할 수 있습니다' : '투표 제안';

  // [이슈] 관전자로 들어왔다가 다음 판에서 참가자가 되어도 이 배너가 그대로 남아 있었다.
  // 띄우기만 하고 내리는 쪽이 없었다. 본인 차례인데도 "관전합니다"가 떠 있었다.
  if (s.phase !== 'lobby' && s.phase !== 'result' && s.you && !s.you.inRound) {
    showBanner('ok', s.you.spectator ? '관전 중입니다. 게임 참가로 전환하면 다음 라운드부터 참여합니다.' : '이미 시작된 판이라 이번 라운드는 관전합니다. 다음 라운드부터 참여합니다.', 0, 'spectating');
  } else {
    hideBannerIf('spectating');
  }

  if (wasAtBottom) scrollChatToBottom();

  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if ((s.phase !== 'lobby' && s.phase !== 'result') || (s.moderation && s.moderation.proposal)) {
    tickTimer = setInterval(function () { if (state) refreshLiveTimers(state); }, 1000);
  }
  updateJumpBar();
}

// [요청] Electron에서는 OS 창틀 대신 슬랙처럼 화면 안에 그린 타이틀바를 쓴다.
// 웹(브라우저) 버전에는 windowControl 자체가 없으므로 자연히 숨겨진 채로 남는다.
if (window.liar && window.liar.isElectron && window.liar.windowControl) {
  $('titlebar').classList.remove('hidden');
  $('titlebar-min').onclick = function () { window.liar.windowControl.minimize(); };
  $('titlebar-max').onclick = function () { window.liar.windowControl.maximize(); };
  $('titlebar-close').onclick = function () { window.liar.windowControl.close(); };
  window.liar.windowControl.onMaximizedChange(function (isMaximized) {
    $('titlebar-max').classList.toggle('is-maximized', !!isMaximized);
  });
}

// Electron이 올려 주는 알림(버전 불일치 등)을 배너로 띄운다.
if (window.liar && typeof window.liar.onNotice === 'function') {
  window.liar.onNotice(function (notice) {
    if (notice && notice.text) showBanner('warn', notice.text);
  });
}

// Electron 버전에서 호스트가 바뀌면 붙을 주소가 달라진다.
if (window.liar && typeof window.liar.onServerChange === 'function') {
  window.liar.onServerChange(function (url) {
    // [E-1] 호스트가 바뀌면 라운드 상태는 옛 호스트의 메모리와 함께 사라진다.
    if (url && everConnected) {
      showBanner('warn', '게임을 진행하던 사람의 접속이 끊겨 다른 PC가 이어받았습니다. 라운드는 처음부터 다시 시작합니다.', 8000);
    }
    if (ws) {
      ws.onclose = null; // 자동 재연결 경로가 겹치지 않게
      try { ws.close(); } catch (e) { /* 이미 닫힘 */ }
      ws = null;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectDelay = 300;
    connect();
  });
}

// [모바일] 화면을 전환하거나 백그라운드로 내리면 브라우저가 조용히 소켓을 끊는다.
// 타이머 기반 감시(watchdog)는 백그라운드 탭에서 함께 느려지거나 멈추므로, 화면이
// 다시 보이는 순간을 직접 잡아 재시도 대기를 건너뛰고 바로 다시 붙는다.
// 돌아오는 길은 하나가 아니다. iOS는 앱 전환기에서 돌아올 때 화면 복원이면
// pageshow만 쏘고 visibilitychange는 안 쏘는 경로가 있고, 끊겼던 통신이 돌아온 건
// online으로만 알 수 있다. 하나라도 놓치면 좀비 연결이 그대로 남는다.
// 예전에는 여기서 readyState가 OPEN이면 그냥 돌아갔는데, 좀비 소켓이 바로 그
// OPEN 상태라서 아무 일도 하지 않고 넘어가는 게 문제였다.
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') verifyConnection();
  else wasAway = true;
});
window.addEventListener('pageshow', verifyConnection);
window.addEventListener('online', verifyConnection);
window.addEventListener('focus', verifyConnection);
window.addEventListener('offline', function () { wasAway = true; });

// 열리다 만 소켓을 치우는 일은 소켓 상태와 상관없이 늘 돌아야 한다. 위의 감시기는
// 연결이 열린 뒤에야 시작하는데(startWatchdog은 onopen에서 부른다), 정작 막히는 건
// 열리지 못한 소켓이다. 통신이 끊긴 동안 연 연결이 CONNECTING에 멈춘 채 남으면
// 통신이 돌아와도 아무 일도 일어나지 않는다.
setInterval(function () {
  if (kicked || superseded) return;
  if (dropStuckSocket()) scheduleReconnect();
}, 2000);

// 새로고침해도 접속 화면으로 되돌아가지 않게, 닉네임과 토큰을 저장해 두고 다시 참가한다.
$('spectator-input').checked = spectatorMode;
var portalName = sessionStorage.getItem('game-portal-nickname');
var savedName = portalName || readStored(NAME_KEY);
if (savedName) $('nickname-input').value = savedName;
if (savedName && (readToken() || portalName)) {
  myNickname = savedName;
  joined = true;
  enterGameScreen();
}

connect();
