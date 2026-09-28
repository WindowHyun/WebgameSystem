# WebgameSystem

`WindowHyun/liar`의 웹 버전을 Render의 상시 Node.js Web Service로 실행하는 프로젝트입니다.

## 로컬 실행

```bash
npm ci
npm run web
```

브라우저에서 `http://localhost:4100`을 엽니다.

## 테스트

| 명령 | 도는 것 | 언제 |
|---|---|---|
| `npm test` | 핵심: 서버·게임 규칙(브라우저 없이, 몇 분) | 고칠 때마다 |
| `npm run test:ui` | 화면: 브라우저로 띄우는 테스트(모바일 포함, 6분 안팎) | 화면을 고쳤을 때 |
| `npm run test:all` | 핵심 + 화면 + 오래 걸리는 백그라운드 복귀 테스트(20분 안팎) | 배포 전 |

- `test/` 안의 `*-test.js`는 자동으로 잡힙니다. 브라우저(playwright)를 쓰면 화면 테스트, 아니면 핵심 테스트입니다.
- 이름 일부를 붙이면 그 스위트만 돕니다. 예: `node test/run-all.js cover mind`
- 기본은 스위트마다 한 줄 요약이고, 실패한 것만 자세히 보여 줍니다. 전체 출력은 `--verbose`로 봅니다.
- 화면 테스트는 Playwright의 Chromium이 필요합니다(`npx playwright install chromium`).
- 연결이 끊겼다 다시 붙는 순서(옛 소켓이 늦게 닫힘, 확인 중 끊김 등)는 가짜 소켓·가짜 시계로 봅니다: 카드 게임은 `socket-race`(핵심), 라이어는 `liar-socket-race`(화면). 실제 네트워크로 폰을 내려놨다 돌아오는 경우는 `background-return`이 보고, 자리를 잃거나 15초 안에 다시 붙지 못하면 실패합니다.
- 셸에 잡힌 `PORT`는 스위트에 넘기지 않습니다. 시간이 넘거나 Ctrl+C를 누르면 스위트가 띄운 서버까지 함께 끕니다.

## Render 배포

1. Render에서 이 저장소를 Web Service로 연결합니다.
2. Build Command는 `npm ci --omit=dev`, Start Command는 `npm start`로 설정합니다.
3. Health Check Path는 `/healthz`로 설정합니다.
4. 지연 없는 운영이 필요하면 휴면하지 않는 유료 인스턴스를 선택합니다.

화면과 `/api/ws` WebSocket은 같은 Render 인스턴스에서 제공됩니다. 배포나 일시적인
네트워크 단절로 연결이 종료되면 화면이 자동으로 다시 연결합니다.

커스텀 도메인에서 Origin 검사가 실패하면 Render의 Environment Variables에
`LIAR_ALLOWED_ORIGINS=https://game.example.com` 형식으로 추가합니다. 여러 도메인은 쉼표로
구분합니다. 같은 호스트에서 제공된 화면은 자동 허용됩니다.

## 현재 제약

게임 상태는 Render 인스턴스 메모리에 있습니다. 배포나 인스턴스 재시작 시 진행 중인 방은
초기화됩니다. 재시작 후에도 상태를 유지해야 한다면 Redis 기반 저장 기능이 추가로 필요합니다.

- **게임 주소는 Render(`*.onrender.com`) 하나입니다.** 인스턴스는 1개로 둡니다. 여러 개로 늘리면
  같은 게임에 들어가도 인스턴스마다 방이 따로 생겨 서로 보이지 않습니다.
- **Vercel 배포는 게임 주소로 쓰지 않습니다.** 저장소의 `vercel.json`·`api/ws.js` 때문에 PR마다
  Vercel에도 배포되지만, Vercel은 접속마다 다른 함수 인스턴스로 연결될 수 있고 인스턴스마다 방이
  따로 생깁니다. 같은 주소로 들어가도 서로 다른 방에 들어갈 수 있으니 Vercel 주소는 공유하지 마세요.
