# instagram-message-auto

인스타그램 @livelihood_tody 릴스 댓글 → 공개 답글 · 여는 DM · 팔로우 확인 · 링크 DM 을 보내는 Cloudflare Worker (Meta 웹훅).

- `src/index.js` — 웹훅 받기(`/webhook`, 서명 확인), 개인정보처리방침(`/privacy`), 데이터 삭제 안내(`/delete`), 상태(`/health`)
- `rules.json` — 릴스별 문구·링크(토큰 없음). 이 PC의 `인스타/도구/규칙_웹훅반영.py` 가 만들어 올림
- 비밀 값은 저장소에 넣지 않습니다. Cloudflare Worker 설정 → Variables and Secrets 에 `IG_TOKEN`, `APP_SECRET`, `VERIFY_TOKEN`
