# WebgameSystem

`WindowHyun/liar`의 웹 버전을 Render의 상시 Node.js Web Service로 실행하는 프로젝트입니다.

## 로컬 실행

```bash
npm ci
npm run web
```

브라우저에서 `http://localhost:4100`을 엽니다.

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
