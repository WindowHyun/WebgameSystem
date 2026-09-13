'use strict';

// Direct web clients must use this request's origin. Reverse proxies may supply
// an explicit allowlist; do not trust arbitrary forwarded headers.
function isAllowedOrigin(info, allowedOrigins = []) {
  if (!info.origin) return true; // non-browser clients; not authentication
  try {
    const origin = new URL(info.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== info.origin) return false;
    if (allowedOrigins.includes(origin.origin)) return true;
    const requestHost = new URL(`http://${info.req.headers.host}`).host;
    // Render 같은 역방향 프록시는 외부 HTTPS를 내부 HTTP로 종료한다. 이때
    // 프로토콜은 달라도 브라우저 Origin과 실제 Host가 같으면 같은 사이트다.
    if (origin.host === requestHost) return true;
    // Electron UI servers bind to these eleven loopback ports only.
    return origin.protocol === 'http:' && origin.hostname === '127.0.0.1'
      && Number(origin.port) >= 55510 && Number(origin.port) <= 55520;
  } catch { return false; }
}

module.exports = { isAllowedOrigin };
