# 배포 가이드 요약

## 1. Supabase DB 만들기

1. Supabase 접속
2. New project 생성
3. Database password 저장
4. Project Dashboard > Connect에서 Session pooler 또는 URI 방식 연결 문자열 복사
5. `.env` 또는 Render 환경변수의 `DATABASE_URL`에 붙여넣기

## 2. GitHub 업로드

```bash
cd jeju-kakao-race
git init
git add .
git commit -m "Initial Jeju Kakao Race system"
git branch -M main
git remote add origin https://github.com/본인아이디/jeju-kakao-race.git
git push -u origin main
```

## 3. Render 배포

1. Render Dashboard 접속
2. New > Web Service
3. GitHub 저장소 연결
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Environment Variables 등록
   - `DATABASE_URL`
   - `ADMIN_PASSWORD`
   - `KAKAO_SKILL_KEY`
   - `PUBLIC_BASE_URL`
7. Deploy

## 4. 카카오 오픈빌더 연결

1. 카카오 챗봇 관리자센터 접속
2. 봇 생성 또는 기존 봇 선택
3. 스킬 메뉴에서 새 스킬 추가
4. URL 입력: `https://배포주소.onrender.com/kakao/skill?key=KAKAO_SKILL_KEY값`
5. 블록에서 스킬 연결
6. 발화 예시 등록: `게임 시작`, `미션 목록`, `순위`, `내 점수`, `M1`, `M2`
7. 배포 전 테스트

## 5. 운영 전 체크

- `/health` 정상 확인
- 관리자 로그인 확인
- 카카오에서 `게임 시작` 테스트
- 팀 등록 테스트
- M1 정답 테스트
- 사진 업로드 승인 테스트
- GPS 미션 좌표 수정 후 테스트
