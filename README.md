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
# .env 파일에서 DATABASE_URL, Supabase Storage, 관리자/카카오 환경변수 수정
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
SUPABASE_URL=https://프로젝트참조.supabase.co
SUPABASE_SERVICE_ROLE_KEY=Supabase service_role 비밀키
SUPABASE_STORAGE_BUCKET=mission-submissions
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
4. 사진 미션은 제출내역에서 확인용 사진을 보고 승인/반려하거나 원본 다운로드
5. CSV 저장으로 순위 다운로드

## 주의사항

- 참가자 사진은 Supabase의 비공개 `mission-submissions` 버킷에 원본과 확인용 JPEG로 분리 저장됩니다. DB에는 Storage 경로와 파일 크기만 저장합니다.
- 관리자 페이지의 `기존 DB 사진을 Storage로 이전` 버튼으로 이전 버전의 Base64 사진을 10장씩 안전하게 이전할 수 있습니다.
- 원본 다운로드 주소는 5분 후 만료됩니다. `원본 사진 일괄 삭제`는 복구할 수 없으므로 먼저 백업하세요.
- `SUPABASE_SERVICE_ROLE_KEY`는 Render 서버 환경변수에만 저장하고 Git, 브라우저, 카카오 설정에 노출하지 마세요. 환경변수가 없으면 새 사진은 이전 방식인 DB Base64로 저장됩니다.
- GPS는 휴대폰 브라우저 위치 권한에 의존합니다. 실내/건물 주변에서는 오차가 커질 수 있습니다.
- ADMIN_PASSWORD와 KAKAO_SKILL_KEY는 반드시 기본값이 아닌 값으로 바꾸세요.
