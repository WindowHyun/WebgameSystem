'use strict';

// Direct web clients must use this request's origin. Reverse proxies may supply
// an explicit allowlist; do not trust arbitrary forwarded headers.
function isAllowedOrigin(info, allowedOrigins = []) {
  // Origin이 없는 건 브라우저가 아닌 클라이언트다(테스트의 raw ws 클라이언트, Node 스크립트).
  // 로컬 테스트에서는 통과시켜야 하지만, 운영에서 이 문을 열어 두면 Origin 검사 자체가
  // 스크립트 한 줄로 우회된다 - 실제 배포(NODE_ENV=production, render.yaml 참고)에서는 막는다.
  if (!info.origin) return process.env.NODE_ENV !== 'production';
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
