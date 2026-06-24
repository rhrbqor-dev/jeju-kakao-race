# 제주 카카오톡 챗봇 미션레이스 시스템

카카오톡 챗봇으로 참가자가 팀 등록, 미션 진행, 정답 제출, 점수 확인, 순위 확인을 할 수 있고 운영자는 웹 관리자 화면에서 현황, 제출 내역, 사진 승인, 미션 설정, CSV 저장을 할 수 있는 Node.js + PostgreSQL 프로젝트입니다.

## 포함 기능

- 카카오 오픈빌더 스킬 서버: `POST /kakao/skill`
- 관리자 대시보드: `/`
- 팀 등록 및 팀코드 자동 발급
- 퀴즈 미션 자동 채점
- 사진 미션 업로드 및 운영자 승인
- GPS 미션 인증
- 완주 미션 처리
- 실시간 순위표
- CSV 다운로드
- 미션 추가/수정/삭제
- Supabase/PostgreSQL DB 연동
- Render 배포 가능

## 로컬 실행

```bash
npm install
cp .env.example .env
# .env 파일에서 DATABASE_URL, ADMIN_PASSWORD, KAKAO_SKILL_KEY 수정
npm start
```

브라우저에서 열기:

```text
http://localhost:3000
```

헬스 체크:

```text
http://localhost:3000/health
```

## Render 환경변수

Render Web Service의 Environment에 아래 값을 등록하세요.

```text
DATABASE_URL=Supabase 또는 PostgreSQL 연결 문자열
ADMIN_PASSWORD=관리자 비밀번호
KAKAO_SKILL_KEY=카카오 스킬 URL 보호용 키
PUBLIC_BASE_URL=https://배포주소.onrender.com
```

## 카카오 오픈빌더 스킬 URL

```text
https://배포주소.onrender.com/kakao/skill?key=KAKAO_SKILL_KEY값
```

## 기본 참가자 사용 흐름

1. 카카오톡 채널에서 `게임 시작` 입력
2. 챗봇이 팀명 입력 요청
3. 참가자가 팀명 입력
4. 서버가 팀코드 발급
5. 참가자가 현장 안내판의 미션코드 입력 예: `M1`
6. 챗봇이 문제 또는 인증 버튼 제공
7. 참가자가 정답 입력 또는 사진/GPS 인증
8. `내 점수`, `순위`, `미션 목록`으로 확인

## 기본 관리자 사용 흐름

1. Render 배포 주소 접속
2. `ADMIN_PASSWORD` 입력
3. 순위표, 제출내역, 미션설정 확인
4. 사진 미션은 제출내역에서 승인/반려
5. CSV 저장으로 순위 다운로드

## 주의사항

- 사진은 PostgreSQL에 base64로 저장하는 간단한 MVP 방식입니다. 대규모 운영에서는 Supabase Storage, S3, Cloudflare R2 같은 파일 저장소를 별도로 붙이는 것이 좋습니다.
- GPS는 휴대폰 브라우저 위치 권한에 의존합니다. 실내/건물 주변에서는 오차가 커질 수 있습니다.
- ADMIN_PASSWORD와 KAKAO_SKILL_KEY는 반드시 기본값이 아닌 값으로 바꾸세요.
