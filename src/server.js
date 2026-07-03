import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const MISSION_IMAGE_LIMIT = 5;
const MISSION_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const MISSION_IMAGE_ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const KAKAO_SKILL_KEY = process.env.KAKAO_SKILL_KEY || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

if (!DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. The server will fail when DB access is required.');
}
if (ADMIN_PASSWORD === 'admin1234' || ADMIN_PASSWORD === 'change-this-admin-password') {
  console.warn('WARNING: ADMIN_PASSWORD is using a default/example value. Change it before public operation.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('이미지 파일만 업로드할 수 있습니다.'));
    cb(null, true);
  },
});

const missionImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MISSION_IMAGE_MAX_BYTES,
    files: MISSION_IMAGE_LIMIT,
  },
  fileFilter: (_req, file, cb) => {
    if (!MISSION_IMAGE_ALLOWED_TYPES.has(file.mimetype)) {
      return cb(new Error('미션 이미지는 JPG, PNG, WEBP 파일만 업로드할 수 있습니다.'));
    }
    cb(null, true);
  },
});

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true, limit: '6mb' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 300 }));
app.use(express.static(publicDir));

function nowIso() {
  return new Date().toISOString();
}

function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return `${req.protocol}://${req.get('host')}`;
}

function normalizeAnswer(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[!?,.·ㆍ~`'"“”‘’()\[\]{}:;\-_/\\|]/g, '');
}

function splitAnswers(answer = '') {
  return String(answer)
    .split(/[|,，\/]/)
    .map((item) => normalizeAnswer(item))
    .filter(Boolean);
}

function escapeCsv(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function teamToken() {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result;
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      event_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS missions (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      mission_code TEXT NOT NULL,
      mission_name TEXT NOT NULL,
      mission_type TEXT NOT NULL CHECK (mission_type IN ('quiz', 'photo', 'gps', 'visit', 'complete')),
      question TEXT NOT NULL DEFAULT '',
      answer TEXT NOT NULL DEFAULT '',
      score INTEGER NOT NULL DEFAULT 0,
      hint TEXT NOT NULL DEFAULT '',
      correct_message TEXT NOT NULL DEFAULT '',
      answer_explanation TEXT NOT NULL DEFAULT '',
      wrong_message TEXT NOT NULL DEFAULT '',
      mission_images TEXT NOT NULL DEFAULT '',
      location_name TEXT NOT NULL DEFAULT '',
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      radius_m INTEGER NOT NULL DEFAULT 80,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_required BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(event_id, mission_code)
    );
  `);

  // 기존 DB에도 새 필드를 자동으로 추가합니다.
  await query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS correct_message TEXT NOT NULL DEFAULT '';`);
  await query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS answer_explanation TEXT NOT NULL DEFAULT '';`);
  await query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS wrong_message TEXT NOT NULL DEFAULT '';`);
  await query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS mission_images TEXT NOT NULL DEFAULT '';`);

  await query(`
    CREATE TABLE IF NOT EXISTS mission_images (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      image_data TEXT NOT NULL,
      image_mime TEXT NOT NULL,
      image_type TEXT NOT NULL DEFAULT 'mission',
      original_name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE mission_images ADD COLUMN IF NOT EXISTS image_type TEXT NOT NULL DEFAULT 'mission';`);
  await query(`UPDATE mission_images SET image_type='mission' WHERE image_type IS NULL OR image_type='';`);

  await query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      team_code TEXT NOT NULL UNIQUE,
      team_name TEXT NOT NULL,
      leader_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      kakao_user_id TEXT UNIQUE,
      public_token TEXT NOT NULL UNIQUE,
      current_mission_id INTEGER REFERENCES missions(id),
      start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finish_time TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'playing',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      kakao_user_id TEXT NOT NULL,
      member_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(event_id, kakao_user_id)
    );
  `);

  await query(`
    ALTER TABLE team_members
    ADD COLUMN IF NOT EXISTS member_name TEXT NOT NULL DEFAULT '';
  `);

  await query(`
    ALTER TABLE team_members
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_states (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      kakao_user_id TEXT NOT NULL,
      state TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(event_id, kakao_user_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS team_notices (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      notice_text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS team_notice_reads (
      id SERIAL PRIMARY KEY,
      notice_id INTEGER NOT NULL REFERENCES team_notices(id) ON DELETE CASCADE,
      kakao_user_id TEXT NOT NULL,
      read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(notice_id, kakao_user_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      answer_text TEXT NOT NULL DEFAULT '',
      image_data TEXT,
      image_mime TEXT,
      gps_lat DOUBLE PRECISION,
      gps_lng DOUBLE PRECISION,
      distance_m DOUBLE PRECISION,
      status TEXT NOT NULL CHECK (status IN ('pending', 'correct', 'wrong', 'approved', 'rejected')),
      score INTEGER NOT NULL DEFAULT 0,
      review_note TEXT NOT NULL DEFAULT '',
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(kakao_user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_team_notices_team ON team_notices(team_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_mission_images_mission ON mission_images(mission_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_mission_images_type ON mission_images(mission_id, image_type);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_submissions_team ON submissions(team_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_submissions_mission ON submissions(mission_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);`);

  // 기존 버전에서 teams.kakao_user_id에 저장되어 있던 팀장 정보를 team_members로 이관
  await query(`
    INSERT INTO team_members(event_id, team_id, kakao_user_id, member_name, role)
    SELECT event_id, id, kakao_user_id, COALESCE(NULLIF(team_name, ''), '팀장'), 'leader'
    FROM teams
    WHERE kakao_user_id IS NOT NULL
    ON CONFLICT(event_id, kakao_user_id) DO NOTHING;
  `);

  const eventCount = await query(`SELECT COUNT(*)::int AS count FROM events;`);
  if (eventCount.rows[0].count === 0) {
    await query(`INSERT INTO events(event_name, status) VALUES ($1, 'active');`, ['제주 AI 탐험대']);
  }

  const event = await getActiveEvent();
  const missionCount = await query(`SELECT COUNT(*)::int AS count FROM missions WHERE event_id=$1;`, [event.id]);
  if (missionCount.rows[0].count === 0) {
    const seedMissions = [
      ['M1', '해신사', 'quiz', '이 장소의 이름은 무엇일까요?', '해신사', 10, '안내판의 제목을 확인해보세요.', '해신사', null, null, 80, 1],
      ['M2', '환해장성', 'quiz', '제주 해안 방어 유적 중 돌로 쌓은 성의 이름은?', '환해장성', 10, '해안선을 따라 쌓은 성입니다.', '환해장성', null, null, 80, 2],
      ['M3', '포구사진', 'photo', '포구 배경이 보이도록 팀 사진을 업로드해주세요.', '', 20, '팀원 또는 팀 표식이 함께 보이면 좋습니다.', '포구', null, null, 80, 3],
      ['M4', '현장 GPS 인증', 'gps', '현재 미션 장소에서 GPS 인증을 진행해주세요.', '', 15, 'GPS 인증 버튼을 눌러 현재 위치를 허용해주세요.', '미션 장소', 33.51411, 126.52969, 120, 4],
      ['M5', '완주 선언', 'complete', '모든 미션을 끝냈다면 완주를 선언하세요.', '완주', 10, '앞 미션을 먼저 완료해야 합니다.', '완주지점', null, null, 80, 5],
    ];
    for (const m of seedMissions) {
      await query(
        `INSERT INTO missions(event_id, mission_code, mission_name, mission_type, question, answer, score, hint, location_name, latitude, longitude, radius_m, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT(event_id, mission_code) DO NOTHING;`,
        [event.id, ...m]
      );
    }
  }
}

async function getActiveEvent() {
  const result = await query(`SELECT * FROM events WHERE status='active' ORDER BY id DESC LIMIT 1;`);
  if (!result.rows.length) throw new Error('active event not found');
  return result.rows[0];
}

async function getMissions(eventId) {
  const result = await query(
    `SELECT
       m.*,
       COALESCE(mi.image_count, 0)::int AS image_count,
       COALESCE(ai.answer_image_count, 0)::int AS answer_image_count
     FROM missions m
     LEFT JOIN (
       SELECT mission_id, COUNT(*)::int AS image_count
       FROM mission_images
       WHERE image_type='mission'
       GROUP BY mission_id
     ) mi ON mi.mission_id=m.id
     LEFT JOIN (
       SELECT mission_id, COUNT(*)::int AS answer_image_count
       FROM mission_images
       WHERE image_type='answer'
       GROUP BY mission_id
     ) ai ON ai.mission_id=m.id
     WHERE m.event_id=$1
     ORDER BY m.sort_order ASC, m.id ASC;`,
    [eventId]
  );
  return result.rows;
}

async function getMissionByCode(eventId, code) {
  const result = await query(
    `SELECT * FROM missions WHERE event_id=$1 AND UPPER(mission_code)=UPPER($2) LIMIT 1;`,
    [eventId, code]
  );
  return result.rows[0] || null;
}

async function getTeamByKakaoUser(eventId, kakaoUserId) {
  const result = await query(
    `SELECT t.*
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     WHERE tm.event_id=$1 AND tm.kakao_user_id=$2
     LIMIT 1;`,
    [eventId, kakaoUserId]
  );
  if (result.rows[0]) return result.rows[0];

  // 기존 데이터 호환용
  const fallback = await query(
    `SELECT * FROM teams WHERE event_id=$1 AND kakao_user_id=$2 LIMIT 1;`,
    [eventId, kakaoUserId]
  );
  return fallback.rows[0] || null;
}

async function getTeamByCode(eventId, teamCode) {
  const result = await query(
    `SELECT * FROM teams WHERE event_id=$1 AND UPPER(team_code)=UPPER($2) LIMIT 1;`,
    [eventId, teamCode]
  );
  return result.rows[0] || null;
}

async function getTeamById(eventId, teamId) {
  const result = await query(
    `SELECT * FROM teams WHERE event_id=$1 AND id=$2 LIMIT 1;`,
    [eventId, teamId]
  );
  return result.rows[0] || null;
}

async function getTeamByCodeAndToken(eventId, teamCode, token) {
  const result = await query(
    `SELECT * FROM teams WHERE event_id=$1 AND UPPER(team_code)=UPPER($2) AND public_token=$3 LIMIT 1;`,
    [eventId, teamCode, token]
  );
  return result.rows[0] || null;
}

async function generateTeamCode() {
  const result = await query(`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM teams;`);
  return `T${String(result.rows[0].next_id).padStart(3, '0')}`;
}

async function createTeam(eventId, kakaoUserId, teamName, memberName = '팀장') {
  const code = await generateTeamCode();
  const token = teamToken();
  const safeMemberName = memberName || '팀장';
  const result = await query(
    `INSERT INTO teams(event_id, team_code, team_name, leader_name, kakao_user_id, public_token)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *;`,
    [eventId, code, teamName, safeMemberName, kakaoUserId, token]
  );

  const team = result.rows[0];

  await query(
    `INSERT INTO team_members(event_id, team_id, kakao_user_id, member_name, role)
     VALUES ($1,$2,$3,$4,'leader')
     ON CONFLICT(event_id, kakao_user_id)
     DO UPDATE SET team_id=$2, member_name=$4, role='leader', joined_at=NOW();`,
    [eventId, team.id, kakaoUserId, safeMemberName]
  );

  return team;
}

async function listJoinableTeams(eventId) {
  const result = await query(
    `SELECT
       t.id,
       t.team_code,
       t.team_name,
       t.status,
       COUNT(tm.id)::int AS member_count
     FROM teams t
     LEFT JOIN team_members tm ON tm.team_id=t.id
     WHERE t.event_id=$1
     GROUP BY t.id
     ORDER BY t.id ASC
     LIMIT 20;`,
    [eventId]
  );
  return result.rows;
}

async function getTeamMembers(teamId) {
  const result = await query(
    `SELECT member_name, role, joined_at
     FROM team_members
     WHERE team_id=$1
     ORDER BY CASE WHEN role='leader' THEN 0 ELSE 1 END, joined_at ASC, id ASC;`,
    [teamId]
  );
  return result.rows;
}

async function getTeamMember(eventId, kakaoUserId) {
  const result = await query(
    `SELECT *
     FROM team_members
     WHERE event_id=$1 AND kakao_user_id=$2
     LIMIT 1;`,
    [eventId, kakaoUserId]
  );
  return result.rows[0] || null;
}


async function getMemberDisplayName(eventId, kakaoUserId) {
  if (!kakaoUserId) return '팀원';
  const member = await getTeamMember(eventId, kakaoUserId);
  return member?.member_name || (member?.role === 'leader' ? '팀장' : '팀원');
}

async function addMissionCompleteNotice(eventId, team, mission, kakaoUserId, actorName, earnedScore = null) {
  if (!team?.id || !mission?.id) return;

  const scoreText = earnedScore === null || earnedScore === undefined
    ? ''
    : ` 획득 점수: ${earnedScore}점`;

  await addTeamNotice(
    eventId,
    team.id,
    `${actorName || '팀원'}님이 ${mission.mission_code} ${mission.mission_name} 미션을 완료했습니다.${scoreText}`,
    kakaoUserId || ''
  );
}

async function joinTeamById(eventId, teamId, kakaoUserId, memberName) {
  const team = await getTeamById(eventId, teamId);
  if (!team) return null;

  await query(
    `INSERT INTO team_members(event_id, team_id, kakao_user_id, member_name, role)
     VALUES ($1,$2,$3,$4,'member')
     ON CONFLICT(event_id, kakao_user_id)
     DO UPDATE SET team_id=$2, member_name=$4, role='member', joined_at=NOW();`,
    [eventId, team.id, kakaoUserId, memberName]
  );

  return team;
}

async function getUserState(eventId, kakaoUserId) {
  const result = await query(
    `SELECT * FROM user_states
     WHERE event_id=$1 AND kakao_user_id=$2
     LIMIT 1;`,
    [eventId, kakaoUserId]
  );

  return result.rows[0] || null;
}

function stateData(userState) {
  if (!userState?.data) return {};
  if (typeof userState.data === 'object') return userState.data;
  try {
    return JSON.parse(userState.data);
  } catch {
    return {};
  }
}

async function setUserState(eventId, kakaoUserId, state, data = {}) {
  await query(
    `INSERT INTO user_states(event_id, kakao_user_id, state, data, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT(event_id, kakao_user_id)
     DO UPDATE SET state=$3, data=$4, updated_at=NOW();`,
    [eventId, kakaoUserId, state, JSON.stringify(data)]
  );
}

async function clearUserState(eventId, kakaoUserId) {
  await query(
    `DELETE FROM user_states
     WHERE event_id=$1 AND kakao_user_id=$2;`,
    [eventId, kakaoUserId]
  );
}

async function addTeamNotice(eventId, teamId, noticeText, excludeKakaoUserId = '') {
  const result = await query(
    `INSERT INTO team_notices(event_id, team_id, notice_text)
     VALUES ($1,$2,$3)
     RETURNING id;`,
    [eventId, teamId, noticeText]
  );

  if (excludeKakaoUserId) {
    await query(
      `INSERT INTO team_notice_reads(notice_id, kakao_user_id)
       VALUES ($1,$2)
       ON CONFLICT(notice_id, kakao_user_id) DO NOTHING;`,
      [result.rows[0].id, excludeKakaoUserId]
    );
  }
}

async function getAndMarkUnreadNotices(eventId, teamId, kakaoUserId) {
  if (!teamId || !kakaoUserId) return '';

  const result = await query(
    `SELECT n.id, n.notice_text
     FROM team_notices n
     WHERE n.event_id=$1
       AND n.team_id=$2
       AND NOT EXISTS (
         SELECT 1 FROM team_notice_reads r
         WHERE r.notice_id=n.id AND r.kakao_user_id=$3
       )
     ORDER BY n.created_at ASC
     LIMIT 5;`,
    [eventId, teamId, kakaoUserId]
  );

  if (!result.rows.length) return '';

  for (const row of result.rows) {
    await query(
      `INSERT INTO team_notice_reads(notice_id, kakao_user_id)
       VALUES ($1,$2)
       ON CONFLICT(notice_id, kakao_user_id) DO NOTHING;`,
      [row.id, kakaoUserId]
    );
  }

  return result.rows.map((row) => `- ${row.notice_text}`).join('\n');
}

async function addUnreadNoticesToResponse(eventId, team, kakaoUserId, response) {
  const noticeText = await getAndMarkUnreadNotices(eventId, team?.id, kakaoUserId);
  if (!noticeText) return response;

  const prefix = `📢 팀 알림\n${noticeText}\n\n`;
  const firstOutput = response?.template?.outputs?.[0];

  if (firstOutput?.simpleText?.text) {
    firstOutput.simpleText.text = prefix + firstOutput.simpleText.text;
  } else if (firstOutput?.basicCard?.description) {
    firstOutput.basicCard.description = prefix + firstOutput.basicCard.description;
  }

  return response;
}

async function respondKakao(res, response, event = null, team = null, kakaoUserId = '') {
  if (event && team && kakaoUserId) {
    response = await addUnreadNoticesToResponse(event.id, team, kakaoUserId, response);
  }
  return res.status(200).json(response);
}

function isTeamNameEditCommand(text) {
  return ['팀명 수정', '팀이름 수정', '팀 이름 수정', '팀명변경', '팀명 변경'].includes(
    String(text).trim().toLowerCase()
  );
}

function isMemberNameEditCommand(text) {
  return ['이름 수정', '닉네임 수정', '내 이름 수정', '내 닉네임 수정', '이름변경', '이름 변경', '닉네임변경', '닉네임 변경'].includes(
    String(text).trim().toLowerCase()
  );
}

function isBlockedTeamName(text) {
  return ['게임 시작', '시작', '참여', '참가', '참여하기', '도움말', '미션 목록', '순위', '랭킹', '내 점수', '팀 생성', '팀 참가', '팀명 수정', '이름 수정', '닉네임 수정'].includes(
    String(text).trim()
  );
}

function isCreateTeamCommand(text) {
  return ['팀 생성', '팀생성', '새 팀', '새팀', '팀 만들기', '팀만들기'].includes(
    String(text).trim().toLowerCase()
  );
}

function isJoinTeamCommand(text) {
  return ['팀 참가', '팀참가', '팀 합류', '팀합류', '참가코드 입력', '팀코드 입력'].includes(
    String(text).trim().toLowerCase()
  );
}

function isTeamMembersCommand(text) {
  return ['팀원', '팀원 목록', '팀원보기', '팀원 보기', '우리 팀'].includes(
    String(text).trim().toLowerCase()
  );
}

function isCancelCommand(text) {
  return ['취소', '그만', '중지', '처음으로'].includes(String(text).trim().toLowerCase());
}

async function getCompletedMissionIds(teamId) {
  const result = await query(
    `SELECT DISTINCT mission_id
     FROM submissions
     WHERE team_id=$1 AND status IN ('correct', 'approved') AND score > 0;`,
    [teamId]
  );
  return new Set(result.rows.map((r) => r.mission_id));
}

async function bestScoresByMission(teamId) {
  const result = await query(
    `SELECT mission_id, MAX(score)::int AS score
     FROM submissions
     WHERE team_id=$1 AND status IN ('correct', 'approved')
     GROUP BY mission_id;`,
    [teamId]
  );
  const map = new Map();
  for (const row of result.rows) map.set(row.mission_id, Number(row.score || 0));
  return map;
}

async function teamTotalScore(teamId) {
  const map = await bestScoresByMission(teamId);
  return [...map.values()].reduce((sum, v) => sum + v, 0);
}

async function isMissionAlreadyCompleted(teamId, missionId) {
  const result = await query(
    `SELECT id FROM submissions
     WHERE team_id=$1 AND mission_id=$2 AND status IN ('correct', 'approved') AND score > 0
     LIMIT 1;`,
    [teamId, missionId]
  );
  return Boolean(result.rows.length);
}

async function maybeMarkFinished(team, eventId) {
  const missions = await getMissions(eventId);
  const requiredIds = missions.filter((m) => m.is_required).map((m) => m.id);
  const completed = await getCompletedMissionIds(team.id);
  const allDone = requiredIds.every((id) => completed.has(id));
  if (allDone && !team.finish_time) {
    await query(`UPDATE teams SET status='finished', finish_time=NOW() WHERE id=$1;`, [team.id]);
  }
}

async function buildRanking(eventId) {
  const result = await query(
    `WITH best AS (
       SELECT team_id, mission_id, MAX(score)::int AS best_score
       FROM submissions
       WHERE event_id=$1 AND status IN ('correct', 'approved')
       GROUP BY team_id, mission_id
     ), totals AS (
       SELECT team_id, COALESCE(SUM(best_score), 0)::int AS total_score
       FROM best GROUP BY team_id
     ), completed AS (
       SELECT team_id, COUNT(DISTINCT mission_id)::int AS completed_count
       FROM submissions
       WHERE event_id=$1 AND status IN ('correct', 'approved') AND score > 0
       GROUP BY team_id
     )
     SELECT
       t.id, t.team_code, t.team_name, t.start_time, t.finish_time, t.status,
       COALESCE(totals.total_score, 0)::int AS total_score,
       COALESCE(completed.completed_count, 0)::int AS completed_count,
       CASE WHEN t.finish_time IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM (t.finish_time - t.start_time))::int END AS duration_seconds
     FROM teams t
     LEFT JOIN totals ON totals.team_id=t.id
     LEFT JOIN completed ON completed.team_id=t.id
     WHERE t.event_id=$1
     ORDER BY
       CASE WHEN t.finish_time IS NULL THEN 1 ELSE 0 END ASC,
       duration_seconds ASC NULLS LAST,
       total_score DESC,
       t.start_time ASC,
       t.id ASC;`,
    [eventId]
  );
  return result.rows.map((row, idx) => ({ ...row, rank: idx + 1 }));
}

function kakaoText(text, quickReplies = []) {
  const safeText = String(text || '응답 메시지가 없습니다.');

  const safeQuickReplies = Array.isArray(quickReplies)
    ? quickReplies
        .filter((q) => typeof q === 'string' && q.trim() !== '')
        .slice(0, 10)
        .map((q) => ({
          action: 'message',
          label: q,
          messageText: q,
        }))
    : [];

  const response = {
    version: '2.0',
    template: {
      outputs: [
        {
          simpleText: {
            text: safeText,
          },
        },
      ],
    },
  };

  if (safeQuickReplies.length > 0) {
    response.template.quickReplies = safeQuickReplies;
  }

  return response;
}

function kakaoCard(title, description, buttons = [], quickReplies = []) {
  const safeQuickReplies = Array.isArray(quickReplies)
    ? quickReplies
        .filter((q) => typeof q === 'string' && q.trim() !== '')
        .slice(0, 10)
        .map((q) => ({ action: 'message', label: q, messageText: q }))
    : [];

  const response = {
    version: '2.0',
    template: {
      outputs: [
        {
          basicCard: {
            title: String(title || ''),
            description: String(description || ''),
            buttons: buttons.slice(0, 3),
          },
        },
      ],
    },
  };

  if (safeQuickReplies.length > 0) {
    response.template.quickReplies = safeQuickReplies;
  }

  return response;
}


function renderMissionTemplate(template, values = {}) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function buildMissionSuccessMessage(mission, values, defaultMessage) {
  const explanation = String(mission.answer_explanation || '').trim();

  let message = defaultMessage;

  if (explanation) {
    message += `

정답 설명
${renderMissionTemplate(explanation, values)}`;
  }

  return message;
}

function buildMissionWrongMessage(mission, values, defaultMessage) {
  const customMessage = String(mission.wrong_message || '').trim();
  if (!customMessage) return defaultMessage;
  return renderMissionTemplate(customMessage, values);
}

function parseMissionImages(value = '') {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//i.test(item))
    .slice(0, MISSION_IMAGE_LIMIT);
}

async function getMissionImageUrls(req, mission, imageType = 'mission') {
  if (!mission?.id) return [];
  const safeType = imageType === 'answer' ? 'answer' : 'mission';

  const uploaded = await query(
    `SELECT id
     FROM mission_images
     WHERE mission_id=$1 AND image_type=$2
     ORDER BY sort_order ASC, id ASC
     LIMIT $3;`,
    [mission.id, safeType, MISSION_IMAGE_LIMIT]
  );

  if (uploaded.rows.length) {
    return uploaded.rows.map((row) => `${baseUrl(req)}/api/public/mission-images/${row.id}`);
  }

  // 기존 URL 입력 방식으로 저장된 데이터는 미션 시작 이미지에만 하위 호환으로 표시합니다.
  if (safeType === 'mission') return parseMissionImages(mission?.mission_images || '');
  return [];
}

async function applyMissionImages(req, response, mission, imageType = 'mission', placement = 'before') {
  const images = await getMissionImageUrls(req, mission, imageType);
  if (!images.length || !response?.template?.outputs) return response;

  const isAnswer = imageType === 'answer';
  const carousel = {
    carousel: {
      type: 'basicCard',
      items: images.map((imageUrl, index) => ({
        title: isAnswer ? `정답 설명 이미지 ${index + 1}` : `참고 이미지 ${index + 1}`,
        thumbnail: { imageUrl },
      })),
    },
  };

  const outputs = placement === 'after'
    ? [...response.template.outputs, carousel]
    : [carousel, ...response.template.outputs];

  return {
    ...response,
    template: {
      ...response.template,
      outputs,
    },
  };
}

async function applyAnswerImages(req, response, mission) {
  return applyMissionImages(req, response, mission, 'answer', 'after');
}

const startQuickReplies = ['팀 생성', '팀 참가', '도움말'];
const menuQuickReplies = ['미션 목록', '내 점수', '순위', '팀원 목록', '이름 수정', '팀명 수정', '도움말'];

function isStartCommand(text) {
  return ['시작', '게임 시작', '참여하기', '참가', 'start'].includes(String(text).trim().toLowerCase());
}

function isHelpCommand(text) {
  return ['도움말', '사용법', 'help'].includes(String(text).trim().toLowerCase());
}

function isScoreCommand(text) {
  return ['내 점수', '점수', '현재 점수'].includes(String(text).trim().toLowerCase());
}

function isRankCommand(text) {
  return ['순위', '랭킹', '순위 보기'].includes(String(text).trim().toLowerCase());
}

function isMissionListCommand(text) {
  return ['미션 목록', '미션', '다음 미션', '목록'].includes(String(text).trim().toLowerCase());
}

function isMissionCode(text) {
  return /^m\d+$/i.test(String(text).trim());
}

async function handleMissionList(event, team) {
  const missions = await getMissions(event.id);
  const completed = team ? await getCompletedMissionIds(team.id) : new Set();
  const lines = missions.map((m) => {
    const done = completed.has(m.id) ? '✅' : '⬜';
    return `${done} ${m.mission_code} ${m.mission_name} (${m.score}점)`;
  });
  return kakaoText(`미션 목록입니다.\n\n${lines.join('\n')}\n\n장소에 도착하면 QR코드를 스캔해주세요.`, menuQuickReplies);
}

async function handleScore(team) {
  const total = await teamTotalScore(team.id);
  const result = await query(
    `SELECT m.mission_code, m.mission_name, MAX(s.score)::int AS score
     FROM submissions s
     JOIN missions m ON m.id=s.mission_id
     WHERE s.team_id=$1 AND s.status IN ('correct', 'approved')
     GROUP BY m.mission_code, m.mission_name, m.sort_order
     ORDER BY m.sort_order;`,
    [team.id]
  );
  const detail = result.rows.length
    ? result.rows.map((r) => `${r.mission_code} ${r.mission_name}: ${r.score}점`).join('\n')
    : '아직 완료한 미션이 없습니다.';
  return kakaoText(`${team.team_name} 현재 점수\n\n총점: ${total}점\n\n${detail}`, menuQuickReplies);
}

async function handleRanking(eventId) {
  const ranking = await buildRanking(eventId);
  if (!ranking.length) return kakaoText('아직 등록된 팀이 없습니다.', menuQuickReplies);
  const top = ranking.slice(0, 10).map((r) => `${r.rank}위 ${r.team_name} (${r.team_code}) - ${r.total_score}점`).join('\n');
  return kakaoText(`현재 순위입니다.\n\n${top}`, menuQuickReplies);
}

async function handleTeamMembers(team) {
  const members = await getTeamMembers(team.id);
  if (!members.length) {
    return kakaoText(`${team.team_name} 팀원 정보가 없습니다.`, menuQuickReplies);
  }

  const lines = members.map((m, idx) => {
    const roleLabel = m.role === 'leader' ? '팀장' : '팀원';
    const name = m.member_name || roleLabel;
    return `${idx + 1}. ${name} (${roleLabel})`;
  });

  return kakaoText(`${team.team_name} 팀원 목록\n\n${lines.join('\n')}`, menuQuickReplies);
}

async function handleJoinTeamList(event, kakaoUserId) {
  const teams = await listJoinableTeams(event.id);

  if (!teams.length) {
    return kakaoText(
      '아직 생성된 팀이 없습니다.\n\n새 팀을 만들려면 "팀 생성"을 입력해주세요.',
      ['팀 생성', '도움말']
    );
  }

  const lines = teams.map((team, index) => `${index + 1}. ${team.team_name} (${team.member_count}명)`);
  await setUserState(event.id, kakaoUserId, 'WAIT_SELECT_JOIN_TEAM', {
    teams: teams.map((team) => ({ id: team.id, name: team.team_name })),
  });

  const quickReplies = teams.slice(0, 10).map((_, index) => String(index + 1));
  return kakaoText(
    `참가할 팀을 선택해주세요.\n\n${lines.join('\n')}\n\n번호를 입력하면 팀코드 확인 단계로 넘어갑니다.\n취소하려면 "취소"를 입력하세요.`,
    quickReplies.length ? quickReplies : ['취소']
  );
}

async function handleMissionStart(req, event, team, missionCode) {
  const mission = await getMissionByCode(event.id, missionCode);
  if (!mission) return kakaoText(`'${missionCode}' 미션을 찾을 수 없습니다. 미션 목록을 확인해주세요.`, menuQuickReplies);

  await query(`UPDATE teams SET current_mission_id=$1 WHERE id=$2;`, [mission.id, team.id]);

  if (mission.mission_type === 'photo') {
    const url = `${baseUrl(req)}/upload?team=${encodeURIComponent(team.team_code)}&mission=${encodeURIComponent(mission.mission_code)}&token=${encodeURIComponent(team.public_token)}`;
    return await applyMissionImages(
      req,
      kakaoCard(
        `${mission.mission_code} ${mission.mission_name}`,
        `${mission.question}

아래 버튼을 눌러 사진을 업로드하면 운영자 승인 후 점수가 반영됩니다.`,
        [{ action: 'webLink', label: '사진 업로드', webLinkUrl: url }],
        menuQuickReplies
      ),
      mission
    );
  }

  if (mission.mission_type === 'gps') {
    const url = `${baseUrl(req)}/gps?team=${encodeURIComponent(team.team_code)}&mission=${encodeURIComponent(mission.mission_code)}&token=${encodeURIComponent(team.public_token)}`;
    return await applyMissionImages(
      req,
      kakaoCard(
        `${mission.mission_code} ${mission.mission_name}`,
        `${mission.question}

아래 버튼을 눌러 위치 권한을 허용해주세요.`,
        [{ action: 'webLink', label: 'GPS 인증하기', webLinkUrl: url }],
        menuQuickReplies
      ),
      mission
    );
  }

  if (mission.mission_type === 'complete') {
    return await applyMissionImages(
      req,
      kakaoText(`${mission.mission_code} ${mission.mission_name}

${mission.question}

완료하려면 '${mission.answer || '완주'}'라고 입력해주세요.`, ['완주', ...menuQuickReplies]),
      mission
    );
  }

  return await applyMissionImages(
    req,
    kakaoText(`${mission.mission_code} ${mission.mission_name}

${mission.question}

정답을 입력해주세요.`, menuQuickReplies),
    mission
  );
}
async function handleAnswer(req, event, team, utterance, kakaoUserId = '') {
  const teamReload = (await query(`SELECT * FROM teams WHERE id=$1;`, [team.id])).rows[0];
  if (!teamReload.current_mission_id) {
    return kakaoText('먼저 QR코드를 스캔해주세요.', ['미션 목록', ...menuQuickReplies]);
  }
  const mission = (await query(`SELECT * FROM missions WHERE id=$1;`, [teamReload.current_mission_id])).rows[0];
  if (!mission) return kakaoText('진행 중인 미션 정보를 찾을 수 없습니다. 미션 목록에서 다시 선택해주세요.', menuQuickReplies);

  const already = await isMissionAlreadyCompleted(team.id, mission.id);
  if (already) {
    return kakaoText(`이미 완료한 미션입니다.\n\n${mission.mission_code} ${mission.mission_name}\n\n다음 미션으로 이동해주세요.`, menuQuickReplies);
  }

  const actorName = await getMemberDisplayName(event.id, kakaoUserId);

  if (mission.mission_type === 'quiz') {
    const acceptable = splitAnswers(mission.answer);
    const isCorrect = acceptable.includes(normalizeAnswer(utterance));

    const wrongCountResult = await query(
      `SELECT COUNT(*)::int AS count
       FROM submissions
       WHERE team_id=$1 AND mission_id=$2 AND status='wrong';`,
      [team.id, mission.id]
    );

    const wrongCount = Number(wrongCountResult.rows[0]?.count || 0);
    const baseScore = Number(mission.score || 0);
    const penaltyPerWrong = 2;
    const minimumScore = baseScore > 0 ? Math.min(2, baseScore) : 0;
    const earnedScore = isCorrect
      ? Math.max(minimumScore, baseScore - wrongCount * penaltyPerWrong)
      : 0;

    await query(
      `INSERT INTO submissions(event_id, team_id, mission_id, answer_text, status, score)
       VALUES ($1,$2,$3,$4,$5,$6);`,
      [event.id, team.id, mission.id, utterance, isCorrect ? 'correct' : 'wrong', earnedScore]
    );

    if (isCorrect) {
      await maybeMarkFinished(team, event.id);
      const total = await teamTotalScore(team.id);
      await addMissionCompleteNotice(event.id, team, mission, kakaoUserId, actorName, earnedScore);
      const defaultMessage = `정답입니다!\n\n${mission.mission_code} ${mission.mission_name} 완료\n기본 점수: ${baseScore}점\n오답 횟수: ${wrongCount}회\n획득 점수: ${earnedScore}점\n현재 총점: ${total}점`;
      const successMessage = buildMissionSuccessMessage(
        mission,
        {
          teamName: team.team_name,
          teamCode: team.team_code,
          missionCode: mission.mission_code,
          missionName: mission.mission_name,
          answer: utterance,
          score: earnedScore,
          earnedScore,
          baseScore,
          wrongCount,
          totalScore: total,
        },
        defaultMessage
      );

      return await applyAnswerImages(req, kakaoText(successMessage, menuQuickReplies), mission);
    }

    const defaultWrongMessage = `아쉽습니다. 정답이 아닙니다.\n\n현재 오답 횟수: ${wrongCount + 1}회\n다음 정답 시 감점이 적용됩니다.\n\n힌트: ${mission.hint || '현장 안내문을 다시 확인해보세요.'}\n\n다시 정답을 입력해주세요.`;
    const wrongMessage = buildMissionWrongMessage(
      mission,
      {
        teamName: team.team_name,
        teamCode: team.team_code,
        missionCode: mission.mission_code,
        missionName: mission.mission_name,
        answer: utterance,
        wrongCount: wrongCount + 1,
        hint: mission.hint || '현장 안내문을 다시 확인해보세요.',
      },
      defaultWrongMessage
    );

    return kakaoText(wrongMessage, ['다시 입력하기', ...menuQuickReplies]);
  }

  if (mission.mission_type === 'visit') {
    const acceptable = splitAnswers(mission.answer);
    const ok = acceptable.length ? acceptable.includes(normalizeAnswer(utterance)) : true;
    await query(
      `INSERT INTO submissions(event_id, team_id, mission_id, answer_text, status, score)
       VALUES ($1,$2,$3,$4,$5,$6);`,
      [event.id, team.id, mission.id, utterance, ok ? 'approved' : 'wrong', ok ? mission.score : 0]
    );
    if (ok) {
      await maybeMarkFinished(team, event.id);
      const total = await teamTotalScore(team.id);
      const score = Number(mission.score || 0);
      await addMissionCompleteNotice(event.id, team, mission, kakaoUserId, actorName, score);
      const defaultMessage = `방문 인증 완료!\n\n획득 점수: ${score}점\n현재 총점: ${total}점`;
      const successMessage = buildMissionSuccessMessage(
        mission,
        {
          teamName: team.team_name,
          teamCode: team.team_code,
          missionCode: mission.mission_code,
          missionName: mission.mission_name,
          answer: utterance,
          score,
          earnedScore: score,
          baseScore: score,
          wrongCount: 0,
          totalScore: total,
        },
        defaultMessage
      );
      return await applyAnswerImages(req, kakaoText(successMessage, menuQuickReplies), mission);
    }
    const defaultWrongMessage = `인증 문구가 맞지 않습니다.\n\n힌트: ${mission.hint || '현장 안내판의 인증 문구를 확인해주세요.'}`;
    const wrongMessage = buildMissionWrongMessage(
      mission,
      {
        teamName: team.team_name,
        teamCode: team.team_code,
        missionCode: mission.mission_code,
        missionName: mission.mission_name,
        answer: utterance,
        wrongCount: 1,
        hint: mission.hint || '현장 안내판의 인증 문구를 확인해주세요.',
      },
      defaultWrongMessage
    );
    return kakaoText(wrongMessage, menuQuickReplies);
  }

  if (mission.mission_type === 'complete') {
    const missions = await getMissions(event.id);
    const completed = await getCompletedMissionIds(team.id);
    const priorRequired = missions.filter((m) => m.is_required && m.id !== mission.id);
    const missing = priorRequired.filter((m) => !completed.has(m.id));
    const acceptable = splitAnswers(mission.answer || '완주');
    const okText = acceptable.includes(normalizeAnswer(utterance));
    if (missing.length) {
      return kakaoText(`아직 완료하지 않은 미션이 있습니다.\n\n${missing.map((m) => `${m.mission_code} ${m.mission_name}`).join('\n')}`, menuQuickReplies);
    }
    if (!okText) {
      const defaultWrongMessage = `완주 선언 문구가 맞지 않습니다. '${mission.answer || '완주'}'라고 입력해주세요.`;
      const wrongMessage = buildMissionWrongMessage(
        mission,
        {
          teamName: team.team_name,
          teamCode: team.team_code,
          missionCode: mission.mission_code,
          missionName: mission.mission_name,
          answer: utterance,
          wrongCount: 1,
          hint: mission.hint || '',
        },
        defaultWrongMessage
      );
      return kakaoText(wrongMessage, ['완주', ...menuQuickReplies]);
    }
    await query(
      `INSERT INTO submissions(event_id, team_id, mission_id, answer_text, status, score)
       VALUES ($1,$2,$3,$4,'approved',$5);`,
      [event.id, team.id, mission.id, utterance, mission.score]
    );
    await maybeMarkFinished(team, event.id);
    const total = await teamTotalScore(team.id);
    const ranking = await buildRanking(event.id);
    const myRank = ranking.find((r) => r.id === team.id)?.rank || '-';
    const score = Number(mission.score || 0);
    await addMissionCompleteNotice(event.id, team, mission, kakaoUserId, actorName, score);
    const defaultMessage = `축하합니다! 완주 처리되었습니다.\n\n팀명: ${team.team_name}\n최종 점수: ${total}점\n현재 순위: ${myRank}위`;
    const successMessage = buildMissionSuccessMessage(
      mission,
      {
        teamName: team.team_name,
        teamCode: team.team_code,
        missionCode: mission.mission_code,
        missionName: mission.mission_name,
        answer: utterance,
        score,
        earnedScore: score,
        baseScore: score,
        wrongCount: 0,
        totalScore: total,
        rank: myRank,
      },
      defaultMessage
    );
    return await applyAnswerImages(req, kakaoText(successMessage, ['순위', '내 점수']), mission);
  }

  if (mission.mission_type === 'photo' || mission.mission_type === 'gps') {
    return handleMissionStart(req, event, team, mission.mission_code);
  }

  return kakaoText('처리할 수 없는 미션 유형입니다. 운영자에게 문의해주세요.', menuQuickReplies);
}

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1;');
    res.json({ ok: true, time: nowIso() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

function extractMissionCodeFromQr(body) {
  const params = body?.action?.params || {};
  const detailParams = body?.action?.detailParams || {};

  const raw =
    params.barcode ||
    params.mission_qr ||
    params.qr ||
    detailParams.barcode?.value ||
    detailParams.mission_qr?.value ||
    '';

  if (!raw) return '';

  let qrText = raw;

  try {
    const parsed = JSON.parse(raw);
    qrText = parsed.barcodeData || parsed.value || raw;
  } catch {
    qrText = raw;
  }

  qrText = String(qrText).trim();

  if (/^M\d+$/i.test(qrText)) {
    return qrText.toUpperCase();
  }

  try {
    const url = new URL(qrText);
    const code = url.searchParams.get('mission') || url.searchParams.get('code');
    if (code && /^M\d+$/i.test(code)) {
      return code.toUpperCase();
    }
  } catch {
    // URL이 아니면 무시
  }

  const found = qrText.match(/\bM\d+\b/i);
  return found ? found[0].toUpperCase() : '';
}

async function handleKakaoSkill(req, res) {
  try {
    if (KAKAO_SKILL_KEY && req.query.key !== KAKAO_SKILL_KEY) {
      return respondKakao(res, kakaoText('스킬 서버 인증키가 올바르지 않습니다. 운영자에게 문의해주세요.'));
    }

    const event = await getActiveEvent();
    const normalUtterance = String(req.body?.userRequest?.utterance || '').trim();
    const qrMissionCode = extractMissionCodeFromQr(req.body);
    const utterance = String(qrMissionCode || normalUtterance).trim();
    const kakaoUserId = String(req.body?.userRequest?.user?.id || req.body?.userRequest?.user?.properties?.plusfriendUserKey || '').trim();

    if (!kakaoUserId) {
      return respondKakao(res, kakaoText('사용자 식별 정보를 확인할 수 없습니다. 카카오 챗봇 설정을 확인해주세요.'));
    }

    let team = await getTeamByKakaoUser(event.id, kakaoUserId);
    const userState = await getUserState(event.id, kakaoUserId);
    const data = stateData(userState);

    if (isCancelCommand(utterance)) {
      await clearUserState(event.id, kakaoUserId);
      return respondKakao(res, kakaoText('진행 중인 입력을 취소했습니다.', team ? menuQuickReplies : startQuickReplies), event, team, kakaoUserId);
    }

    // 1. 새 팀 생성: 팀명 입력 대기
    if (!team && userState?.state === 'WAIT_CREATE_TEAM_NAME') {
      const teamName = utterance.replace(/^(팀명|팀이름|팀 이름)[:：]?/i, '').trim();

      if (!teamName || teamName.length < 2) {
        return respondKakao(res, kakaoText('팀 이름은 2글자 이상으로 입력해주세요.\n예: 귤탐험대'));
      }

      if (teamName.length > 30) {
        return respondKakao(res, kakaoText('팀 이름은 30글자 이하로 입력해주세요.'));
      }

      if (isBlockedTeamName(teamName)) {
        return respondKakao(res, kakaoText('사용할 수 없는 팀 이름입니다.\n다른 팀 이름을 입력해주세요.\n예: 귤탐험대'));
      }

      await setUserState(event.id, kakaoUserId, 'WAIT_CREATE_MEMBER_NAME', {
        team_name: teamName.slice(0, 30),
      });

      return respondKakao(
        res,
        kakaoText(
          `${teamName.slice(0, 30)} 팀으로 생성할게요.\n\n팀장으로 표시할 이름 또는 닉네임을 입력해주세요.\n예: 홍길동`,
          ['취소']
        )
      );
    }

    // 2. 새 팀 생성: 팀장 이름/닉네임 입력 후 생성 완료
    if (!team && userState?.state === 'WAIT_CREATE_MEMBER_NAME') {
      const dataTeamName = String(data.team_name || '').trim();
      const memberName = utterance.replace(/^(이름|닉네임)[:：]?/i, '').trim();

      if (!dataTeamName) {
        await clearUserState(event.id, kakaoUserId);
        return respondKakao(res, kakaoText('팀 생성 정보가 사라졌습니다. 다시 "팀 생성"을 입력해주세요.', ['팀 생성']));
      }

      if (!memberName || memberName.length < 2) {
        return respondKakao(res, kakaoText('이름 또는 닉네임은 2글자 이상으로 입력해주세요.\n예: 홍길동'));
      }

      if (memberName.length > 20) {
        return respondKakao(res, kakaoText('이름 또는 닉네임은 20글자 이하로 입력해주세요.'));
      }

      if (isBlockedTeamName(memberName)) {
        return respondKakao(res, kakaoText('사용할 수 없는 이름입니다.\n다른 이름 또는 닉네임을 입력해주세요.\n예: 홍길동'));
      }

      team = await createTeam(event.id, kakaoUserId, dataTeamName, memberName.slice(0, 20));
      await clearUserState(event.id, kakaoUserId);

      return respondKakao(
        res,
        kakaoText(
          `${team.team_name} 팀이 생성되었습니다!\n\n팀장: ${memberName.slice(0, 20)}\n팀코드: ${team.team_code}\n\n팀원에게 이 코드를 알려주세요.\n팀원은 "팀 참가"를 누른 뒤 팀을 선택하고 팀코드를 입력하면 합류할 수 있습니다.\n\n이제 현장 QR코드를 스캔하면 미션이 시작됩니다.`,
          menuQuickReplies
        ),
        event,
        team,
        kakaoUserId
      );
    }

    // 3. 팀 참가: 팀 목록에서 번호 선택
    if (!team && userState?.state === 'WAIT_SELECT_JOIN_TEAM') {
      if (!/^\d+$/.test(utterance)) {
        return respondKakao(res, kakaoText('참가할 팀 번호를 숫자로 입력해주세요.\n취소하려면 "취소"를 입력하세요.'));
      }

      const selectedIndex = Number(utterance) - 1;
      const selected = Array.isArray(data.teams) ? data.teams[selectedIndex] : null;

      if (!selected) {
        return respondKakao(res, kakaoText('선택한 번호의 팀을 찾을 수 없습니다.\n팀 참가를 다시 진행해주세요.', ['팀 참가', '취소']));
      }

      await setUserState(event.id, kakaoUserId, 'WAIT_JOIN_TEAM_CODE', {
        selected_team_id: selected.id,
        selected_team_name: selected.name,
      });

      return respondKakao(
        res,
        kakaoText(`${selected.name} 팀을 선택했습니다.\n\n팀장에게 받은 팀코드를 입력해주세요.\n예: T001`, ['취소'])
      );
    }

    // 3. 팀 참가: 팀코드 확인
    if (!team && userState?.state === 'WAIT_JOIN_TEAM_CODE') {
      const selectedTeam = await getTeamById(event.id, Number(data.selected_team_id || 0));
      const teamCode = utterance.toUpperCase().trim();

      if (!selectedTeam) {
        await clearUserState(event.id, kakaoUserId);
        return respondKakao(res, kakaoText('선택한 팀 정보를 찾을 수 없습니다.\n다시 "팀 참가"를 입력해주세요.', ['팀 참가']));
      }

      if (teamCode !== selectedTeam.team_code.toUpperCase()) {
        return respondKakao(res, kakaoText('팀코드가 일치하지 않습니다.\n팀장에게 받은 팀코드를 다시 입력해주세요.\n예: T001', ['취소']));
      }

      await setUserState(event.id, kakaoUserId, 'WAIT_JOIN_MEMBER_NAME', {
        selected_team_id: selectedTeam.id,
        selected_team_name: selectedTeam.team_name,
      });

      return respondKakao(res, kakaoText(`${selectedTeam.team_name} 팀코드가 확인되었습니다.\n\n팀에서 사용할 이름 또는 닉네임을 입력해주세요.\n예: 홍길동`, ['취소']));
    }

    // 4. 팀 참가: 참가자 이름 입력 후 합류 완료
    if (!team && userState?.state === 'WAIT_JOIN_MEMBER_NAME') {
      const memberName = utterance.replace(/^(이름|닉네임)[:：]?/i, '').trim();

      if (!memberName || memberName.length < 2) {
        return respondKakao(res, kakaoText('이름 또는 닉네임은 2글자 이상으로 입력해주세요.\n예: 홍길동'));
      }

      if (memberName.length > 20) {
        return respondKakao(res, kakaoText('이름 또는 닉네임은 20글자 이하로 입력해주세요.'));
      }

      const joinedTeam = await joinTeamById(event.id, Number(data.selected_team_id || 0), kakaoUserId, memberName.slice(0, 20));

      if (!joinedTeam) {
        await clearUserState(event.id, kakaoUserId);
        return respondKakao(res, kakaoText('팀 참가 처리 중 오류가 발생했습니다.\n다시 "팀 참가"를 입력해주세요.', ['팀 참가']));
      }

      await clearUserState(event.id, kakaoUserId);
      await addTeamNotice(event.id, joinedTeam.id, `${memberName}님이 ${joinedTeam.team_name} 팀에 참가했습니다.`, kakaoUserId);

      const members = await getTeamMembers(joinedTeam.id);
      const memberLines = members.map((m, idx) => `${idx + 1}. ${m.member_name || (m.role === 'leader' ? '팀장' : '팀원')}${m.role === 'leader' ? ' (팀장)' : ''}`);

      return respondKakao(
        res,
        kakaoText(
          `${joinedTeam.team_name} 팀에 합류했습니다!\n\n팀코드: ${joinedTeam.team_code}\n\n현재 팀원:\n${memberLines.join('\n')}\n\n이제 같은 팀으로 미션을 수행합니다.`,
          menuQuickReplies
        ),
        event,
        joinedTeam,
        kakaoUserId
      );
    }

    // 5. 팀명 수정 대기 상태
    if (team && userState?.state === 'WAIT_TEAM_RENAME') {
      const newTeamName = utterance.replace(/^(팀명|팀이름|팀 이름)[:：]?/i, '').trim();
      const member = await getTeamMember(event.id, kakaoUserId);

      if (!member || member.role !== 'leader') {
        await clearUserState(event.id, kakaoUserId);
        return respondKakao(
          res,
          kakaoText(`팀 이름 수정은 팀장만 가능합니다.

현재 팀명: ${team.team_name}`, menuQuickReplies),
          event,
          team,
          kakaoUserId
        );
      }

      if (!newTeamName || newTeamName.length < 2) {
        return respondKakao(res, kakaoText('새 팀 이름은 2글자 이상으로 입력해주세요.\n예: 귤탐험대'), event, team, kakaoUserId);
      }

      if (newTeamName.length > 30) {
        return respondKakao(res, kakaoText('팀 이름은 30글자 이하로 입력해주세요.'), event, team, kakaoUserId);
      }

      if (isBlockedTeamName(newTeamName)) {
        return respondKakao(res, kakaoText('사용할 수 없는 팀 이름입니다.\n다른 팀 이름을 입력해주세요.'), event, team, kakaoUserId);
      }

      const oldTeamName = team.team_name;
      const result = await query(
        `UPDATE teams
         SET team_name=$1
         WHERE id=$2
         RETURNING *;`,
        [newTeamName.slice(0, 30), team.id]
      );

      await clearUserState(event.id, kakaoUserId);
      team = result.rows[0];
      await addTeamNotice(event.id, team.id, `팀명이 ${oldTeamName}에서 ${team.team_name}(으)로 변경되었습니다.`, kakaoUserId);

      return respondKakao(
        res,
        kakaoText(`팀 이름이 수정되었습니다.\n\n현재 팀명: ${team.team_name}\n팀코드: ${team.team_code}`, menuQuickReplies),
        event,
        team,
        kakaoUserId
      );
    }

    // 6. 이름/닉네임 수정 대기 상태
    if (team && userState?.state === 'WAIT_MEMBER_RENAME') {
      const newMemberName = utterance.replace(/^(이름|닉네임)[:：]?/i, '').trim();
      const member = await getTeamMember(event.id, kakaoUserId);

      if (!member) {
        await clearUserState(event.id, kakaoUserId);
        return respondKakao(
          res,
          kakaoText('팀원 정보를 찾을 수 없습니다. 다시 참가 등록을 확인해주세요.', menuQuickReplies),
          event,
          team,
          kakaoUserId
        );
      }

      if (!newMemberName || newMemberName.length < 2) {
        return respondKakao(res, kakaoText('이름 또는 닉네임은 2글자 이상으로 입력해주세요.\n예: 홍길동', ['취소']), event, team, kakaoUserId);
      }

      if (newMemberName.length > 20) {
        return respondKakao(res, kakaoText('이름 또는 닉네임은 20글자 이하로 입력해주세요.', ['취소']), event, team, kakaoUserId);
      }

      if (isBlockedTeamName(newMemberName)) {
        return respondKakao(res, kakaoText('사용할 수 없는 이름입니다.\n다른 이름 또는 닉네임을 입력해주세요.\n예: 홍길동', ['취소']), event, team, kakaoUserId);
      }

      const oldMemberName = member.member_name || (member.role === 'leader' ? '팀장' : '팀원');
      const safeMemberName = newMemberName.slice(0, 20);

      await query(
        `UPDATE team_members
         SET member_name=$1
         WHERE event_id=$2 AND kakao_user_id=$3
         RETURNING *;`,
        [safeMemberName, event.id, kakaoUserId]
      );

      if (member.role === 'leader') {
        await query(`UPDATE teams SET leader_name=$1 WHERE id=$2;`, [safeMemberName, team.id]);
      }

      await clearUserState(event.id, kakaoUserId);
      await addTeamNotice(event.id, team.id, `${oldMemberName}님이 이름을 ${safeMemberName}(으)로 변경했습니다.`, kakaoUserId);

      return respondKakao(
        res,
        kakaoText(`이름 또는 닉네임이 수정되었습니다.

현재 표시 이름: ${safeMemberName}`, menuQuickReplies),
        event,
        team,
        kakaoUserId
      );
    }

    // 7. 아직 팀 등록이 안 된 사용자
    if (!team) {
      if (isStartCommand(utterance)) {
        return respondKakao(
          res,
          kakaoText(
            '제주 AI 탐험대에 오신 것을 환영합니다!\n\n새 팀을 만들려면 "팀 생성"\n기존 팀에 합류하려면 "팀 참가"를 선택해주세요.',
            startQuickReplies
          )
        );
      }

      if (isCreateTeamCommand(utterance)) {
        await setUserState(event.id, kakaoUserId, 'WAIT_CREATE_TEAM_NAME');
        return respondKakao(res, kakaoText('새 팀을 생성합니다.\n\n먼저 사용할 팀 이름을 입력해주세요.\n예: 귤탐험대', ['취소']));
      }

      if (isJoinTeamCommand(utterance)) {
        return respondKakao(res, await handleJoinTeamList(event, kakaoUserId));
      }

      return respondKakao(
        res,
        kakaoText(
          '먼저 참가 등록이 필요합니다.\n\n새 팀을 만들려면 "팀 생성"\n기존 팀에 합류하려면 "팀 참가"를 입력해주세요.',
          startQuickReplies
        )
      );
    }

    // 8. 이미 팀에 속한 사용자
    if (!utterance) {
      return respondKakao(res, kakaoText('입력값이 비어 있습니다. QR코드를 스캔하거나 메뉴를 입력해주세요.', menuQuickReplies), event, team, kakaoUserId);
    }

    if (isCreateTeamCommand(utterance) || isJoinTeamCommand(utterance)) {
      return respondKakao(
        res,
        kakaoText(`${team.team_name} 팀에 이미 참가되어 있습니다.\n\n팀코드: ${team.team_code}`, menuQuickReplies),
        event,
        team,
        kakaoUserId
      );
    }

    if (isStartCommand(utterance)) {
      return respondKakao(
        res,
        kakaoText(`${team.team_name}님, 이미 참가 등록되어 있습니다.\n\n팀코드: ${team.team_code}`, menuQuickReplies),
        event,
        team,
        kakaoUserId
      );
    }

    if (isMemberNameEditCommand(utterance)) {
      const member = await getTeamMember(event.id, kakaoUserId);
      const currentName = member?.member_name || (member?.role === 'leader' ? '팀장' : '팀원');

      await setUserState(event.id, kakaoUserId, 'WAIT_MEMBER_RENAME');
      return respondKakao(
        res,
        kakaoText(`현재 표시 이름: ${currentName}

새로운 이름 또는 닉네임을 입력해주세요.
예: 홍길동`, ['취소']),
        event,
        team,
        kakaoUserId
      );
    }

    if (isTeamNameEditCommand(utterance)) {
      const member = await getTeamMember(event.id, kakaoUserId);

      if (!member || member.role !== 'leader') {
        return respondKakao(
          res,
          kakaoText(`팀 이름 수정은 팀장만 가능합니다.\n\n현재 팀명: ${team.team_name}`, menuQuickReplies),
          event,
          team,
          kakaoUserId
        );
      }

      await setUserState(event.id, kakaoUserId, 'WAIT_TEAM_RENAME');
      return respondKakao(res, kakaoText(`현재 팀명: ${team.team_name}\n\n새로운 팀 이름을 입력해주세요.`, ['취소']), event, team, kakaoUserId);
    }

    if (isTeamMembersCommand(utterance)) {
      return respondKakao(res, await handleTeamMembers(team), event, team, kakaoUserId);
    }

    if (isHelpCommand(utterance)) {
      return respondKakao(
        res,
        kakaoText(
          '사용법\n\n1. 현장 QR코드를 스캔합니다.\n2. 챗봇이 내는 문제에 답합니다.\n3. 사진/GPS 미션은 버튼을 눌러 인증합니다.\n4. 내 점수 또는 순위를 입력해 확인합니다.\n5. 내 이름을 바꾸려면 "이름 수정"을 입력합니다.\n6. 팀명을 바꾸려면 "팀명 수정"을 입력합니다.\n7. 팀원을 보려면 "팀원 목록"을 입력합니다.',
          menuQuickReplies
        ),
        event,
        team,
        kakaoUserId
      );
    }

    if (isMissionListCommand(utterance)) {
      return respondKakao(res, await handleMissionList(event, team), event, team, kakaoUserId);
    }

    if (isScoreCommand(utterance)) {
      return respondKakao(res, await handleScore(team), event, team, kakaoUserId);
    }

    if (isRankCommand(utterance)) {
      return respondKakao(res, await handleRanking(event.id), event, team, kakaoUserId);
    }

    if (isMissionCode(utterance)) {
      return respondKakao(res, await handleMissionStart(req, event, team, utterance.toUpperCase()), event, team, kakaoUserId);
    }

    return respondKakao(res, await handleAnswer(req, event, team, utterance, kakaoUserId), event, team, kakaoUserId);
  } catch (error) {
    console.error('[카카오 스킬 오류]', error);
    return respondKakao(
      res,
      kakaoText('서버 처리 중 오류가 발생했습니다.\n\n관리자에게 문의해주세요.')
    );
  }
}

app.post('/kakao/skill', handleKakaoSkill);
app.post('/webhook', handleKakaoSkill);

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-password') || req.query.admin_password || req.body.admin_password;
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: '관리자 비밀번호가 필요합니다.' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, message: '비밀번호가 틀렸습니다.' });
  res.json({ ok: true });
});

app.get('/api/admin/summary', requireAdmin, async (_req, res) => {
  const event = await getActiveEvent();
  const ranking = await buildRanking(event.id);
  const missions = await getMissions(event.id);
  const pending = await query(`SELECT COUNT(*)::int AS count FROM submissions WHERE event_id=$1 AND status='pending';`, [event.id]);
  const wrong = await query(`SELECT COUNT(*)::int AS count FROM submissions WHERE event_id=$1 AND status='wrong';`, [event.id]);
  const finished = ranking.filter((r) => r.status === 'finished').length;
  res.json({
    ok: true,
    event,
    teamCount: ranking.length,
    finishedCount: finished,
    missionCount: missions.length,
    pendingCount: pending.rows[0].count,
    wrongCount: wrong.rows[0].count,
    topTeam: ranking[0] || null,
  });
});

app.get('/api/admin/rankings', requireAdmin, async (_req, res) => {
  const event = await getActiveEvent();
  res.json({ ok: true, rankings: await buildRanking(event.id) });
});

app.get('/api/admin/teams', requireAdmin, async (_req, res) => {
  const event = await getActiveEvent();
  const result = await query(
    `SELECT
       t.*,
       COUNT(tm.id)::int AS member_count
     FROM teams t
     LEFT JOIN team_members tm ON tm.team_id=t.id
     WHERE t.event_id=$1
     GROUP BY t.id
     ORDER BY t.id DESC;`,
    [event.id]
  );
  res.json({ ok: true, teams: result.rows });
});

app.get('/api/admin/teams/:id/members', requireAdmin, async (req, res) => {
  const members = await getTeamMembers(req.params.id);
  res.json({ ok: true, members });
});

app.get('/api/admin/missions', requireAdmin, async (_req, res) => {
  const event = await getActiveEvent();
  res.json({ ok: true, missions: await getMissions(event.id) });
});

app.post('/api/admin/missions', requireAdmin, async (req, res) => {
  const event = await getActiveEvent();
  const m = req.body;
  const result = await query(
    `INSERT INTO missions(event_id, mission_code, mission_name, mission_type, question, answer, score, hint, correct_message, answer_explanation, wrong_message, mission_images, location_name, latitude, longitude, radius_m, sort_order, is_required)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *;`,
    [
      event.id,
      m.mission_code,
      m.mission_name,
      m.mission_type,
      m.question || '',
      m.answer || '',
      Number(m.score || 0),
      m.hint || '',
      m.correct_message || '',
      m.answer_explanation || '',
      m.wrong_message || '',
      m.mission_images || '',
      m.location_name || '',
      m.latitude || null,
      m.longitude || null,
      Number(m.radius_m || 80),
      Number(m.sort_order || 0),
      m.is_required !== false,
    ]
  );
  res.json({ ok: true, mission: result.rows[0] });
});

app.patch('/api/admin/missions/:id', requireAdmin, async (req, res) => {
  const m = req.body;
  const result = await query(
    `UPDATE missions SET
      mission_code=$1, mission_name=$2, mission_type=$3, question=$4, answer=$5, score=$6,
      hint=$7, correct_message=$8, answer_explanation=$9, wrong_message=$10, mission_images=$11, location_name=$12, latitude=$13, longitude=$14, radius_m=$15, sort_order=$16, is_required=$17
     WHERE id=$18 RETURNING *;`,
    [
      m.mission_code,
      m.mission_name,
      m.mission_type,
      m.question || '',
      m.answer || '',
      Number(m.score || 0),
      m.hint || '',
      m.correct_message || '',
      m.answer_explanation || '',
      m.wrong_message || '',
      m.mission_images || '',
      m.location_name || '',
      m.latitude || null,
      m.longitude || null,
      Number(m.radius_m || 80),
      Number(m.sort_order || 0),
      m.is_required !== false,
      req.params.id,
    ]
  );
  res.json({ ok: true, mission: result.rows[0] });
});

app.delete('/api/admin/missions/:id', requireAdmin, async (req, res) => {
  await query(`DELETE FROM missions WHERE id=$1;`, [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/admin/missions/:id/images', requireAdmin, async (req, res) => {
  const event = await getActiveEvent();
  const imageType = req.query.type === 'answer' ? 'answer' : 'mission';
  const mission = (await query(
    `SELECT id FROM missions WHERE id=$1 AND event_id=$2 LIMIT 1;`,
    [req.params.id, event.id]
  )).rows[0];

  if (!mission) return res.status(404).json({ ok: false, message: '미션을 찾을 수 없습니다.' });

  const result = await query(
    `SELECT id, original_name, image_mime, image_type, sort_order, created_at
     FROM mission_images
     WHERE event_id=$1 AND mission_id=$2 AND image_type=$3
     ORDER BY sort_order ASC, id ASC;`,
    [event.id, req.params.id, imageType]
  );

  res.json({ ok: true, images: result.rows, image_type: imageType });
});

app.post('/api/admin/missions/:id/images', requireAdmin, missionImageUpload.array('images', MISSION_IMAGE_LIMIT), async (req, res) => {
  const event = await getActiveEvent();
  const imageType = req.query.type === 'answer' ? 'answer' : 'mission';
  const imageLabel = imageType === 'answer' ? '정답 설명 이미지' : '미션 이미지';
  const mission = (await query(
    `SELECT id FROM missions WHERE id=$1 AND event_id=$2 LIMIT 1;`,
    [req.params.id, event.id]
  )).rows[0];

  if (!mission) return res.status(404).json({ ok: false, message: '미션을 찾을 수 없습니다.' });

  const files = req.files || [];
  if (!files.length) return res.status(400).json({ ok: false, message: '업로드할 이미지 파일을 선택해주세요.' });

  const current = await query(
    `SELECT COUNT(*)::int AS count FROM mission_images WHERE event_id=$1 AND mission_id=$2 AND image_type=$3;`,
    [event.id, req.params.id, imageType]
  );
  const currentCount = Number(current.rows[0]?.count || 0);

  if (currentCount + files.length > MISSION_IMAGE_LIMIT) {
    return res.status(400).json({
      ok: false,
      message: `${imageLabel}는 최대 ${MISSION_IMAGE_LIMIT}장까지만 등록할 수 있습니다. 기존 ${currentCount}장, 추가 ${files.length}장입니다.`,
    });
  }

  const inserted = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const result = await query(
      `INSERT INTO mission_images(event_id, mission_id, image_data, image_mime, image_type, original_name, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, original_name, image_mime, image_type, sort_order, created_at;`,
      [
        event.id,
        req.params.id,
        file.buffer.toString('base64'),
        file.mimetype,
        imageType,
        file.originalname || '',
        currentCount + i + 1,
      ]
    );
    inserted.push(result.rows[0]);
  }

  res.json({ ok: true, images: inserted, image_type: imageType });
});

app.delete('/api/admin/mission-images/:id', requireAdmin, async (req, res) => {
  const event = await getActiveEvent();
  const result = await query(
    `DELETE FROM mission_images
     WHERE id=$1 AND event_id=$2
     RETURNING mission_id, image_type;`,
    [req.params.id, event.id]
  );

  if (!result.rows.length) return res.status(404).json({ ok: false, message: '이미지를 찾을 수 없습니다.' });

  const missionId = result.rows[0].mission_id;
  const imageType = result.rows[0].image_type || 'mission';
  const remaining = await query(
    `SELECT id FROM mission_images WHERE mission_id=$1 AND image_type=$2 ORDER BY sort_order ASC, id ASC;`,
    [missionId, imageType]
  );

  for (let i = 0; i < remaining.rows.length; i += 1) {
    await query(`UPDATE mission_images SET sort_order=$1 WHERE id=$2;`, [i + 1, remaining.rows[i].id]);
  }

  res.json({ ok: true });
});

app.get('/api/public/mission-images/:id', async (req, res) => {
  try {
    const result = await query(`SELECT image_data, image_mime FROM mission_images WHERE id=$1 LIMIT 1;`, [req.params.id]);
    const row = result.rows[0];
    if (!row || !row.image_data) return res.status(404).send('image not found');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Content-Type', row.image_mime || 'image/jpeg');
    res.send(Buffer.from(row.image_data, 'base64'));
  } catch (error) {
    res.status(500).send(error.message || 'server error');
  }
});

app.get('/api/admin/submissions', requireAdmin, async (req, res) => {
  const event = await getActiveEvent();
  const status = req.query.status;
  const params = [event.id];
  let where = 's.event_id=$1';
  if (status) {
    params.push(status);
    where += ` AND s.status=$${params.length}`;
  }
  const result = await query(
    `SELECT s.id, s.answer_text, s.status, s.score, s.submitted_at, s.reviewed_at, s.review_note,
            s.image_mime, CASE WHEN s.image_data IS NULL THEN false ELSE true END AS has_image,
            s.gps_lat, s.gps_lng, s.distance_m,
            t.team_code, t.team_name,
            m.mission_code, m.mission_name, m.mission_type
     FROM submissions s
     JOIN teams t ON t.id=s.team_id
     JOIN missions m ON m.id=s.mission_id
     WHERE ${where}
     ORDER BY s.submitted_at DESC
     LIMIT 500;`,
    params
  );
  res.json({ ok: true, submissions: result.rows });
});

app.get('/api/admin/submissions/:id/image', requireAdmin, async (req, res) => {
  const result = await query(`SELECT image_data, image_mime FROM submissions WHERE id=$1;`, [req.params.id]);
  const row = result.rows[0];
  if (!row || !row.image_data) return res.status(404).send('image not found');
  res.set('Content-Type', row.image_mime || 'image/jpeg');
  res.send(Buffer.from(row.image_data, 'base64'));
});

app.post('/api/admin/submissions/:id/review', requireAdmin, async (req, res) => {
  const { decision, note = '' } = req.body;
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ ok: false, message: 'decision은 approved 또는 rejected여야 합니다.' });
  const sub = (await query(
    `SELECT s.*, m.score AS mission_score FROM submissions s JOIN missions m ON m.id=s.mission_id WHERE s.id=$1;`,
    [req.params.id]
  )).rows[0];
  if (!sub) return res.status(404).json({ ok: false, message: '제출 기록을 찾을 수 없습니다.' });
  const score = decision === 'approved' ? Number(sub.mission_score || 0) : 0;
  const result = await query(
    `UPDATE submissions SET status=$1, score=$2, review_note=$3, reviewed_at=NOW() WHERE id=$4 RETURNING *;`,
    [decision, score, note, req.params.id]
  );
  const team = (await query(`SELECT * FROM teams WHERE id=$1;`, [sub.team_id])).rows[0];
  await maybeMarkFinished(team, sub.event_id);
  if (decision === 'approved' && sub.status !== 'approved') {
    const mission = (await query(`SELECT * FROM missions WHERE id=$1;`, [sub.mission_id])).rows[0];
    if (mission) {
      await addTeamNotice(sub.event_id, team.id, `${mission.mission_code} ${mission.mission_name} 미션이 운영자 승인으로 완료되었습니다. 획득 점수: ${score}점`);
    }
  }
  res.json({ ok: true, submission: result.rows[0] });
});

app.get('/api/admin/export/rankings.csv', requireAdmin, async (_req, res) => {
  const event = await getActiveEvent();
  const ranking = await buildRanking(event.id);
  const header = ['순위', '팀코드', '팀명', '총점', '완료미션수', '상태', '시작시간', '완료시간', '소요초'];
  const rows = ranking.map((r) => [r.rank, r.team_code, r.team_name, r.total_score, r.completed_count, r.status, r.start_time, r.finish_time || '', r.duration_seconds || '']);
  const csv = [header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rankings.csv"');
  res.send('\uFEFF' + csv);
});

app.post('/api/admin/reset-event', requireAdmin, async (_req, res) => {
  const event = await getActiveEvent();
  await query(`DELETE FROM team_notice_reads WHERE notice_id IN (SELECT id FROM team_notices WHERE event_id=$1);`, [event.id]);
  await query(`DELETE FROM team_notices WHERE event_id=$1;`, [event.id]);
  await query(`DELETE FROM user_states WHERE event_id=$1;`, [event.id]);
  await query(`DELETE FROM submissions WHERE event_id=$1;`, [event.id]);
  await query(`DELETE FROM team_members WHERE event_id=$1;`, [event.id]);
  await query(`DELETE FROM teams WHERE event_id=$1;`, [event.id]);
  res.json({ ok: true });
});

app.get('/upload', (_req, res) => res.sendFile(path.join(publicDir, 'upload.html')));
app.get('/gps', (_req, res) => res.sendFile(path.join(publicDir, 'gps.html')));

app.post('/api/public/upload/photo', upload.single('photo'), async (req, res) => {
  try {
    const event = await getActiveEvent();
    const { team_code, mission_code, token, comment = '' } = req.body;
    const team = await getTeamByCodeAndToken(event.id, team_code, token);
    const mission = await getMissionByCode(event.id, mission_code);
    if (!team || !mission || mission.mission_type !== 'photo') return res.status(400).json({ ok: false, message: '팀/미션 인증 정보가 올바르지 않습니다.' });
    if (!req.file) return res.status(400).json({ ok: false, message: '사진 파일이 필요합니다.' });
    if (await isMissionAlreadyCompleted(team.id, mission.id)) return res.json({ ok: true, message: '이미 완료된 미션입니다.' });
    await query(
      `INSERT INTO submissions(event_id, team_id, mission_id, answer_text, image_data, image_mime, status, score)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',0);`,
      [event.id, team.id, mission.id, comment, req.file.buffer.toString('base64'), req.file.mimetype]
    );
    res.json({ ok: true, message: '사진이 접수되었습니다. 운영자 승인 후 점수가 반영됩니다.' });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post('/api/public/verify/location', async (req, res) => {
  try {
    const event = await getActiveEvent();
    const { team_code, mission_code, token, lat, lng } = req.body;
    const team = await getTeamByCodeAndToken(event.id, team_code, token);
    const mission = await getMissionByCode(event.id, mission_code);
    if (!team || !mission || mission.mission_type !== 'gps') return res.status(400).json({ ok: false, message: '팀/미션 인증 정보가 올바르지 않습니다.' });
    if (mission.latitude === null || mission.longitude === null) return res.status(400).json({ ok: false, message: '미션 좌표가 설정되어 있지 않습니다.' });
    if (await isMissionAlreadyCompleted(team.id, mission.id)) return res.json({ ok: true, message: '이미 완료된 미션입니다.' });
    const distance = haversineMeters(Number(lat), Number(lng), Number(mission.latitude), Number(mission.longitude));
    const ok = distance <= Number(mission.radius_m || 80);
    await query(
      `INSERT INTO submissions(event_id, team_id, mission_id, answer_text, gps_lat, gps_lng, distance_m, status, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9);`,
      [event.id, team.id, mission.id, `GPS ${Math.round(distance)}m`, Number(lat), Number(lng), distance, ok ? 'approved' : 'rejected', ok ? mission.score : 0]
    );
    await maybeMarkFinished(team, event.id);
    if (ok) {
      await addTeamNotice(event.id, team.id, `${mission.mission_code} ${mission.mission_name} GPS 미션이 완료되었습니다. 획득 점수: ${mission.score}점`);
    }
    res.json({ ok, distance_m: Math.round(distance), message: ok ? `GPS 인증 완료! ${mission.score}점이 반영되었습니다.` : `현재 위치가 미션 장소에서 ${Math.round(distance)}m 떨어져 있습니다. 현장에서 다시 시도해주세요.` });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ ok: false, message: `이미지 1장당 최대 ${Math.round(MISSION_IMAGE_MAX_BYTES / 1024 / 1024)}MB까지만 업로드할 수 있습니다.` });
  }
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ ok: false, message: `미션 이미지는 최대 ${MISSION_IMAGE_LIMIT}장까지만 업로드할 수 있습니다.` });
  }
  res.status(500).json({ ok: false, message: err.message || '서버 오류' });
});

app.get('/kakao/skill', (_req, res) => {
  res.send('Kakao skill endpoint is alive. Kakao uses POST.');
});

app.get('/webhook', (_req, res) => {
  res.send('Kakao webhook endpoint is alive. Kakao uses POST.');
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Jeju Kakao Race server running on :${PORT}`));
  })
  .catch((error) => {
    console.error('DB initialization failed:', error);
    process.exit(1);
  });
