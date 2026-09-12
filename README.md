# WebgameSystem

`WindowHyun/liar`의 웹 버전을 Vercel WebSocket Function으로 실행하는 프로젝트입니다.

## 로컬 실행

```bash
npm ci
npm run web
```

브라우저에서 `http://localhost:4100`을 엽니다.

## Vercel 배포

1. 이 저장소를 Vercel 프로젝트로 Import합니다.
2. Framework Preset은 `Other`, Root Directory는 저장소 루트로 둡니다.
3. Fluid Compute를 활성화합니다.
4. Deploy합니다.

Vercel에서는 화면이 `public/`에서 제공되고 WebSocket은 `/api/ws`로 연결됩니다.
Hobby 플랜의 Function 최대 실행 시간에 맞춰 300초로 설정되어 있으며, 화면은 연결이
종료되면 자동으로 다시 연결합니다.

커스텀 도메인에서 Origin 검사가 실패하면 Vercel 프로젝트의 Environment Variables에
`LIAR_ALLOWED_ORIGINS=https://game.example.com` 형식으로 추가합니다. 여러 도메인은 쉼표로
구분합니다. Vercel 기본 배포·프로덕션·브랜치 주소는 자동 허용됩니다.

## 현재 제약

게임 상태는 Function 인스턴스 메모리에 있습니다. 소규모 단일 방에는 사용할 수 있지만,
Vercel이 여러 인스턴스로 확장하거나 인스턴스를 교체하면 방이 나뉘거나 초기화될 수 있습니다.
안정적인 공개 서비스로 운영하려면 Redis 기반 공유 상태/이벤트 처리가 추가로 필요합니다.
