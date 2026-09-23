'use strict';

/**
 * 게임 서버를 "켰다 껐다 할 수 있는 물건"으로 만들어 준다.
 *
 * 웹 버전에서는 한 번 켜면 끝이라 굳이 필요 없었지만, Electron 버전에서는 LAN에서
 * 뽑힌 호스트만 이걸 켜고, 호스트가 바뀌면 껐다가 다른 PC가 켠다. 그래서 시작·중지가
 * 되는 형태로 분리했다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const { createRoom } = require('./room');
const { createPokerRoom } = require('./poker-room');
const { createBlackjackRoom } = require('./blackjack-room');
const { isAllowedOrigin } = require('./origin');
const { validateClientMessage } = require('./protocol');
const { log, warn, error } = require('../logger');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// [S-2] 한 사람이 보낼 수 있는 요청 수 제한. 악의가 아니라 화면 쪽 버그로도
// 무한 루프가 돌 수 있다. 넉넉하게 잡되 폭주는 끊는다.
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 60;

// [S-4] 같은 IP가 소켓을 계속 열어 정원(방 8명·관전 16명, 카드게임 5명)을 독점하거나
// 하트비트 순회 비용을 불필요하게 늘리는 것을 막는다. 사내망 공유 IP나 같은 사람이
// 탭을 여러 개 여는 정상적인 경우까지 막지 않도록 넉넉하게 잡는다.
const MAX_CONNECTIONS_PER_IP = 30;

// [E-3] 연결 유지 확인. 두 가지를 한꺼번에 해결한다.
//   1) 사내망 방화벽/프록시는 조용한 TCP 연결을 1분 안팎에 끊어 버린다. 이 게임은
//      남의 설명을 듣는 60초 동안 아무 데이터도 오가지 않아서 딱 그 시간에 끊겼다.
//   2) 반쯤 죽은 연결(전원이 나갔거나 케이블이 빠진)은 close 이벤트가 몇 분씩 안 온다.
//      그동안 그 사람 자리를 계속 기다리게 된다.
const PING_MS = 25000;
const PONG_GRACE = 2; // 이 횟수만큼 응답이 없으면 죽은 연결로 본다
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

// Render에서는 같은 프로세스가 정적 화면과 게임 소켓을 함께 제공한다. 정적 파일을
// 요청할 때마다 디스크에서 읽지 않고 시작 시 한 번만 읽어 둔다. 텍스트 파일의 gzip
// 결과도 재사용하므로 모바일 회선의 초기 다운로드와 서버 CPU 사용량을 함께 줄인다.
const STATIC_FILES = new Map();
for (const name of fs.readdirSync(PUBLIC_DIR)) {
  const file = path.join(PUBLIC_DIR, name);
  if (!fs.statSync(file).isFile()) continue;
  const body = fs.readFileSync(file);
  const type = MIME[path.extname(name)] || 'application/octet-stream';
  const compressible = /^(text\/|application\/(javascript|json))/.test(type);
  STATIC_FILES.set(name, {
    body,
    gzip: compressible ? zlib.gzipSync(body, { level: zlib.constants.Z_BEST_SPEED }) : null,
    type,
    etag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`,
  });
}

function createGameServer(options) {
  const opts = options || {};
  const port = opts.port;
  const bindHost = opts.host || '0.0.0.0';
  const pingMs = opts.pingMs || PING_MS; // 테스트에서 짧게 잡으려고 주입받는다
  const maxConnectionsPerIp = opts.maxConnectionsPerIp || MAX_CONNECTIONS_PER_IP; // 테스트에서 낮춰 잡으려고 주입받는다

  const clients = new Set(); // { ws, playerId }
  const pokerClients = new Set();
  const blackjackClients = new Set();
  const portalClients = new Set();
  const ipConnectionCounts = new Map(); // ip -> 현재 열려 있는 소켓 수
  let server = null;
  let wss = null;
  let room = null;
  let pokerRoom = null;
  let blackjackRoom = null;
  let pingTimer = null;
  let initialized = false;

  function sendTo(ws, payload) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      warn(`[전송 실패] ${err.message}`);
    }
  }

  /** 상태가 바뀌면 접속자 각각에게 "그 사람 몫으로 걸러낸" 전체 상태를 다시 보낸다. */
  function broadcastState() {
    if (!room) return;
    for (const client of clients) {
      if (!client.playerId) continue;
      sendTo(client.ws, room.stateFor(client.playerId));
    }
    broadcastPortal();
  }

  function broadcastPoker() {
    if (!pokerRoom) return;
    for (const client of pokerClients) if (client.playerId) sendTo(client.ws, pokerRoom.stateFor(client.playerId));
    broadcastPortal();
  }

  function broadcastBlackjack() {
    if (!blackjackRoom) return;
    for (const client of blackjackClients) if (client.playerId) sendTo(client.ws, blackjackRoom.stateFor(client.playerId));
    broadcastPortal();
  }

  function broadcastPortal() {
    if (!room || !pokerRoom || !blackjackRoom) return;
    const liar = room._debug();
    const poker = pokerRoom.status();
    const blackjack = blackjackRoom.status();
    const label = (info) => info.phase !== 'lobby' && info.phase !== 'result' ? '진행중' : (info.playerCount ? '진행 대기중' : '대기중');
    const payload = { type: 'games', games: {
      liar: { label: '라이어 게임', playerCount: [...clients].filter((c) => c.playerId).length, status: label({ phase: liar.phase, playerCount: [...clients].filter((c) => c.playerId).length }) },
      poker: { label: '인디언 포커', playerCount: poker.playerCount, status: label(poker) },
      blackjack: { label: '블랙잭 21', playerCount: blackjack.playerCount, status: label(blackjack) },
    } };
    for (const client of portalClients) sendTo(client.ws, payload);
  }

  function handleHttp(req, res) {
    const requested = (req.url || '/').split('?')[0];
    if (requested === '/healthz') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, securityHeaders(req)));
      res.end('{"ok":true}');
      return;
    }
    const name = requested === '/' ? 'index.html' : path.basename(requested);
    const asset = STATIC_FILES.get(name);
    if (!asset) {
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, securityHeaders(req)));
      res.end('없는 파일입니다.');
      return;
    }

    // HTML은 항상 재검증하고, 이름이 고정된 JS/CSS도 짧게만 캐시한다. 폰트와 이미지는
    // 내용 변경이 드물어 오래 캐시한다. ETag가 같으면 본문을 다시 보내지 않는다.
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304, Object.assign({ ETag: asset.etag, 'Cache-Control': cacheControl(name) }, securityHeaders(req)));
      res.end();
      return;
    }
    const useGzip = asset.gzip && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const headers = Object.assign({
      'Content-Type': asset.type,
      'Content-Length': useGzip ? asset.gzip.length : asset.body.length,
      'Cache-Control': cacheControl(name),
      ETag: asset.etag,
    }, securityHeaders(req));
    if (useGzip) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : (useGzip ? asset.gzip : asset.body));
  }

  /**
   * [S-7] 모든 응답에 붙는 보안 헤더.
   *
   * CSP를 이렇게 빡빡하게 걸 수 있는 건 이 앱의 화면에 인라인 <script>도, style="..."도,
   * onclick="..."도 하나도 없기 때문이다(전부 외부 .js에서 addEventListener/.onclick으로
   * 붙인다). 나중에 인라인을 하나라도 추가하면 그 자리에서 크게 깨지므로 바로 눈치챈다.
   *
   * frame-ancestors 'none' - 이 게임은 업무 화면으로 위장하는 게 목적인데, 남의 페이지가
   * iframe으로 이걸 품으면 클릭재킹으로 남의 차례를 대신 눌러 줄 수 있다.
   * connect-src 'self' - 같은 출처의 wss:도 여기에 포함된다(WebSocket 주소가 이 서버뿐).
   */
  function securityHeaders(req) {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    };
    // HSTS는 평문 HTTP에서는 브라우저가 무시하고, LAN/Electron 실행은 http라 걸면 안 된다.
    // Render는 x-forwarded-proto로 원래 프로토콜을 알려 준다.
    if (req.headers['x-forwarded-proto'] === 'https') {
      headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    }
    return headers;
  }

  function cacheControl(name) {
    if (name.endsWith('.html')) return 'no-cache';
    if (/\.(woff2|png|webp)$/.test(name)) return 'public, max-age=31536000, immutable';
    return 'public, max-age=300, must-revalidate';
  }

  /**
   * [E-3] 25초마다 살아 있는지 묻는다. 조용한 연결이 방화벽에 끊기는 것을 막고,
   * 이미 죽은 연결은 여기서 걸러 낸다(close를 기다리면 몇 분씩 걸린다).
   */
  function startHeartbeat() {
    pingTimer = setInterval(() => {
      for (const client of [...clients, ...pokerClients, ...blackjackClients, ...portalClients]) {
        if (client.missedPongs >= PONG_GRACE) {
          warn(`[연결 끊김] ${client.playerId || '미참가'} 응답이 없어 정리합니다`);
          try { client.ws.terminate(); } catch { /* 이미 닫힘 */ }
          continue;
        }
        client.missedPongs += 1;
        try { client.ws.ping(); } catch { /* 이미 닫힘 */ }
      }
    }, pingMs);
    // 이 타이머 때문에 프로세스가 안 죽는 일이 없게 한다.
    if (typeof pingTimer.unref === 'function') pingTimer.unref();
  }

  function handleConnection(ws, req) {
    // 작은 턴 메시지를 즉시 전송해 Nagle 지연을 피한다.
    if (ws._socket && typeof ws._socket.setNoDelay === 'function') ws._socket.setNoDelay(true);

    const ip = remoteIp(req);
    const openFromIp = ipConnectionCounts.get(ip) || 0;
    if (openFromIp >= maxConnectionsPerIp) {
      warn(`[연결 거절] ${ip} 동시 연결 ${openFromIp}개로 정원(${maxConnectionsPerIp}) 초과`);
      // 아래의 정상 경로와 달리 여기는 'error' 리스너를 달 기회가 없다. 듣는 사람이 없는
      // 'error'는 ws가 그대로 던져 uncaughtException까지 올라가므로, 끊는 소켓에도 반드시
      // 하나 달아 둔다(끊는 중에 상대가 먼저 죽으면 ECONNRESET이 흔히 올라온다).
      ws.on('error', () => {});
      ws.close(1013, '연결이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    ipConnectionCounts.set(ip, openFromIp + 1);
    ws.on('close', () => {
      const left = (ipConnectionCounts.get(ip) || 1) - 1;
      if (left <= 0) ipConnectionCounts.delete(ip); else ipConnectionCounts.set(ip, left);
    });

    const game = new URL(req.url || '/', 'http://localhost').searchParams.get('game') || 'liar';
    if (game === 'portal') {
      const client = { ws, ip, playerId: null, windowStart: 0, count: 0, missedPongs: 0 };
      portalClients.add(client);
      ws.on('error', () => {});
      ws.on('pong', () => { client.missedPongs = 0; });
      ws.on('close', () => portalClients.delete(client));
      // 포털 소켓은 join이 없어 다른 경로의 속도 제한을 안 탄다 - ping만 받는 용도라
      // 별도로 없어도 된다고 생각했는데, 그래서 여기만 빠르게 프레임을 퍼부어도 막을 게
      // 없었다. 다른 경로와 같은 기준(5초에 60개)을 그대로 적용한다.
      ws.on('message', (raw) => {
        const now = Date.now();
        if (now - client.windowStart > RATE_WINDOW_MS) { client.windowStart = now; client.count = 0; }
        client.count += 1;
        if (client.count > RATE_MAX) return;
        try { if (JSON.parse(raw).type === 'ping') sendTo(ws, { type: 'pong' }); } catch {}
      });
      broadcastPortal();
      return;
    }
    if (game === 'poker') { handlePokerConnection(ws, ip); return; }
    if (game === 'blackjack') { handleBlackjackConnection(ws, ip); return; }
    const client = { ws, ip, playerId: null, windowStart: 0, count: 0, missedPongs: 0 };
    clients.add(client);

    // 듣는 사람이 없으면 소켓 오류 하나로 프로세스 전체가 죽는다.
    ws.on('error', (err) => { warn(`[연결 오류] ${ip} ${err.message}`); });
    ws.on('pong', () => { client.missedPongs = 0; });
    ws.on('close', () => {
      clients.delete(client);
      // stop() 중이면 room은 이미 없다. 호스트가 물러나면서 서버를 내릴 때 이 경로가
      // 반드시 지나가므로, 여기서 null을 참조하면 인계 때마다 프로세스가 죽는다.
      if (room && client.playerId) room.disconnect(client.playerId);
    });

    ws.on('message', (raw) => {
      // [E-3] 여기서 예외가 나면 ws가 그대로 위로 던져 프로세스가 죽는다. 그러면 요청을
      // 보낸 한 사람이 아니라 접속자 전원이 동시에 튕긴다. 한 번의 잘못된 요청이
      // 판 전체를 날리지 않도록 여기서 잡는다.
      try {
        handleMessage(client, ws, raw);
      } catch (err) {
        error(`[요청 처리 실패] ${client.ip} ${client.playerId || '미참가'} ${err && err.stack ? err.stack : err}`);
        sendTo(ws, { type: 'error', message: '요청을 처리하지 못했습니다. 다시 시도해 주세요.' });
      }
    });
  }

  function handleMessage(client, ws, raw) {
    // 서버를 내리는 중이면 방이 이미 없다(호스트를 넘길 때 이 경로를 지난다).
    if (!room || client.kicked) return;

    // [S-2] 창 하나가 서버를 독차지하지 못하게 한다.
    const now = Date.now();
    if (now - client.windowStart > RATE_WINDOW_MS) {
      client.windowStart = now;
      client.count = 0;
    }
    client.count += 1;
    if (client.count > RATE_MAX) {
      if (client.count === RATE_MAX + 1) {
        warn(`[속도 제한] ${client.ip} ${client.playerId || '미참가'} 연결이 너무 많이 보냅니다 - 잠시 무시합니다`);
        sendTo(ws, { type: 'error', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const invalid = validateClientMessage(msg);
    if (invalid) {
      warn(`[요청 무시] ${invalid}`);
      sendTo(ws, { type: 'error', message: '잘못된 요청입니다.' });
      return;
    }

    // [E-3] 화면 쪽 확인. 브라우저는 WebSocket ping 프레임을 자바스크립트로 볼 수
    // 없어서, 화면이 스스로 살아 있는지 확인하려면 이렇게 주고받아야 한다.
    if (msg.type === 'ping') { sendTo(ws, { type: 'pong' }); return; }

    if (msg.type === 'join') {
      // 한 연결이 참가를 두 번 보내면 앞서 잡았던 자리가 주인 없이 남는다. 연결이
      // 끊길 때 정리되는 건 마지막 자리 하나뿐이라, 앞 자리는 "접속 중"인 채로
      // 영영 목록에 남아 인원수와 시작 조건까지 어긋나게 만든다.
      if (client.playerId) {
        sendTo(ws, { type: 'error', message: '이미 참가한 연결입니다.' });
        return;
      }
      const joined = room.join({ nickname: msg.nickname, token: msg.token, spectator: msg.spectator });
      // 정원이 찬 경우. 자리를 잡지 못했으므로 playerId를 붙이지 않는다.
      if (joined.error) {
        warn(`[참가 거절] ${client.ip} ${joined.error}`);
        sendTo(ws, { type: 'error', message: joined.error });
        return;
      }
      // 같은 토큰을 들고 있던 이전 연결(모바일 백그라운드로 조용히 죽었거나, 정말로
      // 다른 창)이 있다면 여기서 끊어 낸다. room.join()은 이제 연결 상태와 관계없이
      // 토큰이 같으면 같은 자리를 내주므로, 자리를 안 뺏기려는 판단은 소켓 쪽에서 한다.
      replaceConnection(clients, client, joined.playerId);
      client.playerId = joined.playerId;
      // 토큰은 브라우저가 저장해 두었다가 새로고침·재접속 때 같은 자리로 돌아오는 데 쓴다.
      sendTo(ws, { type: 'welcome', playerId: joined.playerId, token: joined.token });
      sendTo(ws, room.stateFor(joined.playerId));
      log(`[참가] ${joined.restored ? '재접속' : '신규'} ${joined.playerId} ${client.ip}`);
      return;
    }

    if (!client.playerId) {
      sendTo(ws, { type: 'error', message: '먼저 닉네임을 입력하고 접속해 주세요.' });
      return;
    }

    // 나가기는 "돌아오지 않는다"는 선언이라 자리를 남기지 않는다. 소켓이 끊겨서
    // 사라지는 것(disconnect)과 달리 10초 유예도 주지 않는다.
    if (msg.type === 'leave') {
      const goneId = client.playerId;
      client.playerId = null;
      room.leave(goneId);
      log(`[퇴장] ${goneId}`);
      return;
    }

    let reason = null;
    if (msg.type === 'mode') reason = room.setMode(client.playerId, msg.spectator);
    else if (msg.type === 'kick') reason = room.requestKick(client.playerId, msg.targetId);
    else if (msg.type === 'kickVote') reason = room.voteKick(client.playerId, msg.proposalId, msg.agree);
    else if (msg.type === 'start') reason = room.start(client.playerId);
    else if (msg.type === 'chat') reason = room.say(client.playerId, msg.text);
    else if (msg.type === 'callVote') reason = room.callVote(client.playerId);
    else if (msg.type === 'proposalVote') reason = room.respondProposal(client.playerId, msg.agree);
    else if (msg.type === 'vote') reason = room.vote(client.playerId, msg.targetId);
    else if (msg.type === 'guess') reason = room.guess(client.playerId, msg.word);

    // 거절 사유는 요청한 사람에게만 알린다. 눌러도 아무 일이 없으면 원인을 알 수 없다.
    if (reason) sendTo(ws, { type: 'error', message: reason });
  }

  /**
   * [S-1] Origin 검사. 브라우저가 보내는 Origin만 본다.
   *   - 브라우저 버전: 이 서버가 내려준 페이지 → 이 서버의 주소
   *   - Electron 버전: 로컬 화면 서버 → http://127.0.0.1:<포트>
   *   - Node 클라이언트(테스트 등)는 Origin을 안 보내므로 통과시킨다
   */
  function allowOrigin(info) {
    const allowed = isAllowedOrigin(info, opts.allowedOrigins || []);
    if (!allowed) warn('[접속 거절] 허용되지 않은 출처');
    return allowed;
  }

  /**
   * [S-4] Render 같은 리버스 프록시 뒤에서는 req.socket.remoteAddress가 프록시 자신의
   * 주소라, 실제 클라이언트를 구분하려면 프록시가 붙여 준 헤더를 봐야 한다.
   *
   * 순서가 중요하다. Render(*.onrender.com)는 Cloudflare 뒤에 있고, Cloudflare는 진짜
   * 클라이언트 IP를 CF-Connecting-IP에 넣는다. 반면 X-Forwarded-For는 "클라이언트가
   * 먼저 채워 보내면 그 값이 맨 앞에 남는" 헤더라, 맨 앞만 읽으면 브라우저가 부르는
   * 대로 믿게 된다. 그래서 CF-Connecting-IP를 먼저 본다.
   *
   * 다만 어느 쪽도 인증된 값은 아니다(오리진에 직접 붙으면 둘 다 위조할 수 있다).
   * 이 값은 인가 판단이 아니라 동시 연결 수를 세고 로그에 남기는 용도일 뿐이므로,
   * 위조되더라도 그 카운터 하나가 무력화될 뿐 다른 보안 경계를 넘지 못한다.
   */
  function remoteIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    return sanitizeIp(req.headers['cf-connecting-ip']
      || (forwarded ? forwarded.split(',')[0] : null)
      || (req.socket && req.socket.remoteAddress));
  }

  /**
   * [S-4] 위 헤더들은 전부 클라이언트가 적어 보낼 수 있는 문자열이다. 그대로 쓰면 두 가지가
   * 샌다. (1) 로그 - `[참가] ... ${ip}` 줄에 임의의 글자가 그대로 들어가 로그를 위조할 수
   * 있다. (2) ipConnectionCounts의 키 - 아무 길이의 문자열이 키가 된다. IP 모양이 아닌
   * 값은 전부 'unknown' 한 칸으로 몰아넣는다.
   */
  function sanitizeIp(value) {
    const text = String(value == null ? '' : value).trim();
    // IPv4/IPv6 최대 길이(::ffff:255.255.255.255 포함)는 45자다.
    if (!text || text.length > 45 || !/^[0-9a-fA-F.:]+$/.test(text)) return 'unknown';
    return text;
  }

  /**
   * [관리 로그] 게임 방이 알려 주는 행동을 "[포커] 김하늘 > 콜 100원" 한 줄로 남긴다.
   *
   * 닉네임은 참가자가 마음대로 적는 글자라 줄바꿈이 들어갈 수 있다. 그대로 쓰면
   * "김하늘\n[포커] 박서준 > 올인 1,000,000원" 같은 닉네임 하나로 없던 줄을 로그에
   * 끼워 넣을 수 있다(IP 쪽의 sanitizeIp와 같은 문제). 제어 문자는 공백으로 바꾼다.
   */
  function actionLogger(game) {
    const clean = (value) => Array.from(String(value == null ? '' : value), (ch) => {
      const code = ch.codePointAt(0);
      return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? ' ' : ch;
    }).join('');
    return (who, what) => log(`[${game}] ${clean(who)} > ${clean(what)}`);
  }

  function initialize() {
      if (initialized) return;
      initialized = true;
      // 규칙 타이머(설명 시간 초과, 투표 마감 등)에서 예외가 나도 프로세스가 죽지
      // 않게 감싼다. 죽으면 접속자 전원이 동시에 튕긴다.
      const guardedTimer = (fn, ms) => setTimeout(() => {
        try { fn(); } catch (err) {
          error(`[진행 처리 실패] ${err && err.stack ? err.stack : err}`);
        }
      }, ms);
      room = createRoom({ onChange: broadcastState, setTimer: guardedTimer, onAction: actionLogger('라이어'),
        onKick: (id) => {
          for (const client of clients) {
            if (client.playerId !== id) continue;
            client.playerId = null;
            client.kicked = true;
            sendTo(client.ws, { type: 'kicked', message: '다수결로 방에서 퇴장되었습니다. 접속 버튼을 누르면 바로 다시 입장할 수 있습니다.' });
            client.ws.close(4003, 'kicked');
          }
        },
      });
      pokerRoom = createPokerRoom({ onChange: broadcastPoker, onAction: actionLogger('포커') });
      blackjackRoom = createBlackjackRoom({ onChange: broadcastBlackjack, onAction: actionLogger('블랙잭') });
      startHeartbeat();
      server = http.createServer(handleHttp);
      // [S-1] 이 서버는 자기가 내려준 화면(같은 출처)이나 Electron 창(로컬 출처)만
      // 상대한다. 참가자가 열어 둔 아무 웹페이지가 붙어 오는 것(CSWSH)을 막는다.
      // [M3] 기본값이 100MB다. 이 게임이 주고받는 가장 큰 메시지는 300자 채팅이라
      // 그만한 프레임을 받아 줄 이유가 없다. 화면 쪽 버그 하나로 서버 메모리가
      // 통째로 물리는 일을 막는다.
      // 상태 메시지가 작고 빈도가 낮아 per-message 압축 협상 비용이 이득보다 크다.
      wss = new WebSocketServer({ server, verifyClient: allowOrigin, maxPayload: 16 * 1024, perMessageDeflate: false });
      wss.on('connection', handleConnection);

      // 'error'는 듣는 사람이 없으면 그대로 던져져 프로세스를 죽인다. start()도 자기 몫의
      // 리스너를 달지만, Vercel은 start() 대신 getHttpServer()로 들어오므로 그 경로에는
      // 아무도 없었다. 기본 안전망은 여기(두 경로가 반드시 지나는 곳)에 둔다.
      server.on('error', (err) => warn(`[HTTP 서버 오류] ${err.message}`));
      wss.on('error', (err) => warn(`[WebSocket 서버 오류] ${err.message}`));
  }

  function handlePokerConnection(ws, ip) {
    const client = { ws, ip, playerId: null, windowStart: 0, count: 0, missedPongs: 0 };
    pokerClients.add(client);
    ws.on('error', (err) => warn(`[포커 연결 오류] ${ip} ${err.message}`));
    ws.on('pong', () => { client.missedPongs = 0; });
    ws.on('close', () => { pokerClients.delete(client); if (pokerRoom && client.playerId) pokerRoom.disconnect(client.playerId); });
    ws.on('message', (raw) => {
      try {
        const now = Date.now();
        if (now - client.windowStart > RATE_WINDOW_MS) { client.windowStart = now; client.count = 0; }
        client.count += 1;
        if (client.count > RATE_MAX) return;
        const msg = JSON.parse(raw);
        if (msg.type === 'ping') { sendTo(ws, { type: 'pong' }); return; }
        if (msg.type === 'join') {
          if (client.playerId) return;
          const joined = pokerRoom.join({ nickname: msg.nickname, token: msg.token });
          if (joined.error) { warn(`[포커 참가 거절] ${ip} ${joined.error}`); return sendTo(ws, { type: 'error', message: joined.error }); }
          replaceConnection(pokerClients, client, joined.playerId);
          client.playerId = joined.playerId;
          sendTo(ws, { type: 'welcome', playerId: joined.playerId, token: joined.token });
          sendTo(ws, pokerRoom.stateFor(joined.playerId));
          return;
        }
        if (!client.playerId) return sendTo(ws, { type: 'error', message: '먼저 입장해 주세요.' });
        let reason = null;
        if (msg.type === 'leave') { pokerRoom.leave(client.playerId); client.playerId = null; sendTo(ws, { type: 'left' }); return; }
        if (msg.type === 'ready') reason = pokerRoom.setReady(client.playerId, msg.ready);
        else if (msg.type === 'baseBet') reason = pokerRoom.setBaseBet(client.playerId, msg.amount);
        else if (msg.type === 'baseBetVote') reason = pokerRoom.voteBaseBet(client.playerId, msg.proposalId, msg.agree);
        else if (msg.type === 'start') reason = pokerRoom.begin(client.playerId);
        else if (msg.type === 'call') reason = pokerRoom.call(client.playerId);
        else if (msg.type === 'raise') reason = pokerRoom.raise(client.playerId, msg.amount);
        else if (msg.type === 'allin') reason = pokerRoom.allin(client.playerId);
        else if (msg.type === 'fold') reason = pokerRoom.fold(client.playerId);
        else if (msg.type === 'donate') reason = pokerRoom.donate(client.playerId, msg.targetId, msg.amount);
        else reason = '지원하지 않는 요청입니다.';
        if (reason) sendTo(ws, { type: 'error', message: reason });
      } catch (err) {
        error(`[포커 요청 실패] ${ip} ${client.playerId || '미참가'} ${err && err.stack ? err.stack : err}`);
        sendTo(ws, { type: 'error', message: '요청을 처리하지 못했습니다.' });
      }
    });
  }

  function handleBlackjackConnection(ws, ip) {
    const client = { ws, ip, playerId: null, windowStart: 0, count: 0, missedPongs: 0 };
    blackjackClients.add(client);
    ws.on('error', (err) => warn(`[블랙잭 연결 오류] ${ip} ${err.message}`));
    ws.on('pong', () => { client.missedPongs = 0; });
    ws.on('close', () => { blackjackClients.delete(client); if (blackjackRoom && client.playerId) blackjackRoom.disconnect(client.playerId); });
    ws.on('message', (raw) => {
      try {
        const now = Date.now();
        if (now - client.windowStart > RATE_WINDOW_MS) { client.windowStart = now; client.count = 0; }
        client.count += 1;
        if (client.count > RATE_MAX) return;
        const msg = JSON.parse(raw);
        if (msg.type === 'ping') { sendTo(ws, { type: 'pong' }); return; }
        if (msg.type === 'join') {
          if (client.playerId) return;
          const joined = blackjackRoom.join({ nickname: msg.nickname, token: msg.token });
          if (joined.error) { warn(`[블랙잭 참가 거절] ${ip} ${joined.error}`); return sendTo(ws, { type: 'error', message: joined.error }); }
          replaceConnection(blackjackClients, client, joined.playerId);
          client.playerId = joined.playerId;
          sendTo(ws, { type: 'welcome', playerId: joined.playerId, token: joined.token });
          sendTo(ws, blackjackRoom.stateFor(joined.playerId));
          return;
        }
        if (!client.playerId) return sendTo(ws, { type: 'error', message: '먼저 입장해 주세요.' });
        let reason = null;
        if (msg.type === 'leave') { blackjackRoom.leave(client.playerId); client.playerId = null; sendTo(ws, { type: 'left' }); return; }
        if (msg.type === 'ready') reason = blackjackRoom.setReady(client.playerId, msg.ready);
        else if (msg.type === 'baseBet') reason = blackjackRoom.proposeBaseBet(client.playerId, msg.amount);
        else if (msg.type === 'baseBetVote') reason = blackjackRoom.voteBaseBet(client.playerId, msg.proposalId, msg.agree);
        else if (msg.type === 'start') reason = blackjackRoom.begin(client.playerId);
        else if (msg.type === 'hit') reason = blackjackRoom.hit(client.playerId);
        else if (msg.type === 'stand') reason = blackjackRoom.stand(client.playerId);
        else if (msg.type === 'call') reason = blackjackRoom.call(client.playerId);
        else if (msg.type === 'raise') reason = blackjackRoom.raise(client.playerId, msg.amount);
        else if (msg.type === 'allin') reason = blackjackRoom.allin(client.playerId);
        else if (msg.type === 'fold') reason = blackjackRoom.fold(client.playerId);
        else if (msg.type === 'donate') reason = blackjackRoom.donate(client.playerId, msg.targetId, msg.amount);
        else reason = '지원하지 않는 요청입니다.';
        if (reason) sendTo(ws, { type: 'error', message: reason });
      } catch (err) {
        error(`[블랙잭 요청 실패] ${ip} ${client.playerId || '미참가'} ${err && err.stack ? err.stack : err}`);
        sendTo(ws, { type: 'error', message: '요청을 처리하지 못했습니다.' });
      }
    });
  }

  function replaceConnection(gameClients, incoming, playerId) {
    for (const existing of gameClients) {
      if (existing === incoming || existing.playerId !== playerId) continue;
      // close 이벤트가 새로 복구된 자리를 다시 끊김 처리하지 않게 먼저 연결을 떼어 낸다.
      existing.playerId = null;
      sendTo(existing.ws, { type: 'replaced', message: '같은 참가자가 다른 연결에서 다시 접속했습니다.' });
      existing.ws.close(4001, 'replaced');
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      if (server) { resolve(); return; }
      initialize();

      // ws는 http 서버의 error를 WebSocketServer로도 다시 올린다. 한쪽만 들으면
      // 나머지 한쪽이 "듣는 사람 없는 error"가 되어 결국 스택 트레이스로 죽는다.
      let settled = false;
      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      server.on('error', onError);
      wss.on('error', onError);

      server.listen(port, bindHost, () => {
        if (settled) return;
        settled = true;
        log(`[서버 시작] 포트 ${port} (${bindHost})`);
        resolve();
      });
    });
  }

  function cleanup() {
    if (room) room.dispose();
    if (pokerRoom) pokerRoom.dispose();
    if (blackjackRoom) blackjackRoom.dispose();
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    for (const client of clients) {
      try { client.ws.terminate(); } catch { /* 이미 끊김 */ }
    }
    clients.clear();
    for (const client of [...pokerClients, ...blackjackClients, ...portalClients]) {
      try { client.ws.terminate(); } catch { /* 이미 닫힘 */ }
    }
    pokerClients.clear();
    blackjackClients.clear();
    portalClients.clear();
    if (wss) { try { wss.close(); } catch { /* 무시 */ } wss = null; }
    if (server) { try { server.close(); } catch { /* 무시 */ } server = null; }
    room = null;
    pokerRoom = null;
    blackjackRoom = null;
    initialized = false;
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) { resolve(); return; }
      log('[서버 중지]');
      cleanup();
      // 소켓이 완전히 닫힐 틈을 준다. 같은 포트를 바로 다시 열 수 있어야 한다.
      setTimeout(resolve, 100);
    });
  }

  return {
    start,
    stop,
    // Vercel WebSocket Function은 포트를 직접 열지 않고 http.Server를 export한다.
    // LAN/Electron 실행 경로는 기존 start()를 그대로 사용한다.
    getHttpServer() {
      initialize();
      return server;
    },
    port,
    isRunning: () => server !== null,
    playerCount: () => [...clients].filter((c) => c.playerId).length,
  };
}

module.exports = { createGameServer };
