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

## 5. 카카오톡 이미지 보안전송 플러그인

사진 미션은 Event API나 외부 업로드 페이지 대신 카카오의 이미지 보안전송 플러그인을 사용합니다.

1. 챗봇 관리자센터의 시스템 엔티티에서 `@sys.plugin.secureimage`를 활성화합니다.
2. 일반 블록을 만들고 발화에 `사진 인증`, `사진 다시 제출`, `GPS 대체 사진 인증`을 등록합니다.
3. 해당 블록에 `secureimage`라는 파라미터를 만들고 `@sys.plugin.secureimage`를 선택합니다.
4. 파라미터를 필수로 설정하고 되묻기 질문의 안내 문구, 버튼명, 개인정보 수집·이용 항목을 작성합니다.
5. 이 프로젝트의 카카오 스킬을 블록에 연결하고 스킬 응답을 사용하도록 설정한 뒤 배포합니다.

사용자가 사진을 전송하면 카카오가 자동으로 완료 발화를 만들고 `secureimage` 파라미터의 임시 URL을 스킬 서버에 전달합니다. 서버는 URL 유효시간 안에 사진을 내려받아 제출 기록에 저장하고 자동 승인 또는 관리자 승인 대기 결과를 같은 대화에서 응답합니다.

제출 결과에 표시되는 `사진 다시 제출` 버튼으로 같은 플러그인을 다시 실행할 수 있습니다. 다시 받은 사진은 새 점수나 중복 제출을 만들지 않고 기존 제출 기록의 사진만 교체합니다.

## 6. 운영 전 체크

- `/health` 정상 확인
- 관리자 로그인 확인
- 카카오에서 `게임 시작` 테스트
- 팀 등록 테스트
- M1 정답 테스트
- 사진 업로드 승인 테스트
- GPS 미션 좌표 수정 후 테스트
