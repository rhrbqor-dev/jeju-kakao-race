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

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const KAKAO_SKILL_KEY = process.env.KAKAO_SKILL_KEY || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

let dbReady = false;
let dbInitError = '';

if (!DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. DB routes will fail until it is configured.');
}

if (ADMIN_PASSWORD === 'admin1234' || ADMIN_PASSWORD === 'change-this-admin-password') {
  console.warn('WARNING: ADMIN_PASSWORD is using a default/example value. Change it before public operation.');
}

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
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
    .split(/[|,，/]/)
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
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function teamToken() {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

async function query(sql, params = []) {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set.');
  }
  return pool.query(sql, params);
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
      current_mission_id INTEGER,
      start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finish_time TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'playing',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS leader_name TEXT NOT NULL DEFAULT '';`);
  await query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';`);
  await query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS public_token TEXT;`);
  await query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS current_mission_id INTEGER;`);
  await query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS finish_time TIMESTAMPTZ;`);
  await query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'playing';`);

  await query(`
    UPDATE teams
    SET public_token = CONCAT('legacy_', id, '_', REPLACE(CAST(NOW() AS TEXT), ' ', '_'))
    WHERE public_token IS NULL OR public_token = '';
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

  await query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS member_name TEXT NOT NULL DEFAULT '';`);
  await query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';`);

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
  await query(`CREATE INDEX IF NOT EXISTS idx_submissions_team ON submissions(team_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_submissions_mission ON submissions(mission_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);`);

  await query(`
    INSERT INTO team_members(event_id, team_id, kakao_user_id, member_name, role)
    SELECT event_id, id, kakao_user_id, COALESCE(NULLIF(leader_name, ''), NULLIF(team_name, ''), '팀장'), 'leader'
    FROM teams
    WHERE kakao_user_id IS NOT NULL AND kakao_user_id <> ''
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
  const result = await query(`SELECT * FROM missions WHERE event_id=$1 ORDER BY sort_order ASC, id ASC;`, [eventId]);
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

  const fallback = await query(
    `SELECT * FROM teams WHERE event_id=$1 AND kakao_user_id=$2 LIMIT 1;`,
    [eventId, kakaoUserId]
  );
  return fallback.rows[0] || null;
}

async function getTeamMember(eventId, kakaoUserId) {
  const result = await query(
    `SELECT tm.*, t.team_name, t.team_code
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     WHERE tm.event_id=$1 AND tm.kakao_user_id=$2
     LIMIT 1;`,
    [eventId, kakaoUserId]
  );
  return result.rows[0] || null;
}

async function getTeamById(eventId, teamId) {
  const result = await query(`SELECT * FROM teams WHERE event_id=$1 AND id=$2 LIMIT 1;`, [eventId, teamId]);
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
  const result = await query(
    `INSERT INTO teams(event_id, team_code, team_name, leader_name, kakao_user_id, public_token)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *;`,
    [eventId, code, teamName, memberName || '팀장', kakaoUserId, token]
  );

  const team = result.rows[0];

  await query(
    `INSERT INTO team_members(event_id, team_id, kakao_user_id, member_name, role)
     VALUES ($1,$2,$3,$4,'leader')
     ON CONFLICT(event_id, kakao_user_id)
     DO UPDATE SET team_id=$2, member_name=$4, role='leader', joined_at=NOW();`,
    [eventId, team.id, kakaoUserId, memberName || '팀장']
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
    `SELECT * FROM user_states WHERE event_id=$1 AND kakao_user_id=$2 LIMIT 1;`,
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
  await query(`DELETE FROM user_states WHERE event_id=$1 AND kakao_user_id=$2;`, [eventId, kakaoUserId]);
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

function cleanName(text) {
  return String(text || '')
    .replace(/^(이름|닉네임|닉명)[:：]?/i, '')
    .trim()
    .slice(0, 30);
}

function isBlockedTeamName(text) {
  return [
    '게임 시작', '시작', '참여', '참가', '참여하기', '도움말', '미션 목록', '순위', '랭킹',
    '내 점수', '팀 생성', '팀 참가', '팀명 수정', '팀원', '팀원 목록', '취소', '완주',
  ].includes(String(text).trim());
}

function isTeamNameEditCommand(text) {
  return ['팀명 수정', '팀이름 수정', '팀 이름 수정', '팀명변경', '팀명 변경'].includes(String(text).trim().toLowerCase());
}

function isMemberNameEditCommand(text) {
  return ['이름 수정', '닉네임 수정', '내 이름 수정', '내 닉네임 수정', '이름변경', '닉네임변경'].includes(
    String(text).trim().toLowerCase()
  );
}

function isCreateTeamCommand(text) {
  return ['팀 생성', '팀생성', '새 팀', '새팀', '팀 만들기', '팀만들기'].includes(String(text).trim().toLowerCase());
}

function isJoinTeamCommand(text) {
  return ['팀 참가', '팀참가', '팀 합류', '팀합류', '참가코드 입력', '팀코드 입력'].includes(String(text).trim().toLowerCase());
}

function isTeamMembersCommand(text) {
  return ['팀원', '팀원 목록', '팀원보기', '팀원 보기', '우리 팀'].includes(String(text).trim().toLowerCase());
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
  const safeQuickReplies = Array.isArray(quickReplies)
    ? quickReplies
        .filter((q) => typeof q === 'string' && q.trim() !== '')
        .slice(0, 10)
        .map((q) => ({ action: 'message', label: q, messageText: q }))
    : [];

  const response = {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text: String(text || '응답 메시지가 없습니다.') } }],
    },
  };

  if (safeQuickReplies.length > 0) response.template.quickReplies = safeQuickReplies;
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

  if (safeQuickReplies.length > 0) response.template.quickReplies = safeQuickReplies;
  return response;
}

const startQuickReplies = ['팀 생성', '팀 참가', '도움말'];
const menuQuickReplies = ['미션 목록', '내 점수', '순위', '팀원 목록', '팀명 수정', '이름 수정', '도움말'];

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
  if (!members.length) return kakaoText(`${team.team_name} 팀원 정보가 없습니다.`, menuQuickReplies);

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
    return kakaoText('아직 생성된 팀이 없습니다.\n\n새 팀을 만들려면 "팀 생성"을 입력해주세요.', ['팀 생성', '도움말']);
  }

  const lines = teams.map((team, index) => `${index + 1}. ${team.team_name} (${team.member_count}명)`);
  await setUserState(event.id, kakaoUserId, 'WAIT_SELECT_JOIN_TEAM', {
    teams: teams.map((team) => ({ id: team.id, name: team.team_name })),
  });

  const quickReplies = teams.slice(0, 10).map((_, index) => String(index + 1));
  return kakaoText(
    `참가할 팀을 선택해주세요.\n\n${lines.join('\n')}\n\n번호를 입력하면 이름 또는 닉네임 입력 단계로 넘어갑니다.\n취소하려면 "취소"를 입력하세요.`,
    [...quickReplies, '취소'].slice(0, 10)
  );
}

async function handleMissionStart(req, event, team, missionCode) {
  const mission = await getMissionByCode(event.id, missionCode);
  if (!mission) return kakaoText(`'${missionCode}' 미션을 찾을 수 없습니다. 미션 목록을 확인해주세요.`, menuQuickReplies);

  await query(`UPDATE teams SET current_mission_id=$1 WHERE id=$2;`, [mission.id, team.id]);

  if (mission.mission_type === 'photo') {
    const url = `${baseUrl(req)}/upload?team=${encodeURIComponent(team.team_code)}&mission=${encodeURIComponent(mission.mission_code)}&token=${encodeURIComponent(team.public_token)}`;
    return kakaoCard(
      `${mission.mission_code} ${mission.mission_name}`,
      `${mission.question}\n\n아래 버튼을 눌러 사진을 업로드하면 운영자 승인 후 점수가 반영됩니다.`,
      [{ action: 'webLink', label: '사진 업로드', webLinkUrl: url }],
      menuQuickReplies
    );
  }

  if (mission.mission_type === 'gps') {
    const url = `${baseUrl(req)}/gps?team=${encodeURIComponent(team.team_code)}&mission=${encodeURIComponent(mission.mission_code)}&token=${encodeURIComponent(team.public_token)}`;
    return kakaoCard(
      `${mission.mission_code} ${mission.mission_name}`,
      `${mission.question}\n\n아래 버튼을 눌러 위치 권한을 허용해주세요.`,
      [{ action: 'webLink', label: 'GPS 인증하기', webLinkUrl: url }],
      menuQuickReplies
    );
  }

  if (mission.mission_type === 'complete') {
    return kakaoText(
      `${mission.mission_code} ${mission.mission_name}\n\n${mission.question}\n\n완료하려면 '${mission.answer || '완주'}'라고 입력해주세요.`,
      ['완주', ...menuQuickReplies]
    );
  }

  return kakaoText(`${mission.mission_code} ${mission.mission_name}\n\n${mission.question}\n\n정답을 입력해주세요.`, menuQuickReplies);
}

async function afterMissionCompleted(event, team, mission, kakaoUserId, actorName) {
  await maybeMarkFinished(team, event.id);
  const total = await teamTotalScore(team.id);
  const name = actorName || '팀원';
  await addTeamNotice(
    event.id,
    team.id,
    `${name}님이 ${mission.mission_code} ${mission.mission_name} 미션을 완료했습니다. 현재 팀 점수는 ${total}점입니다.`,
    kakaoUserId
  );
  return total;
}

async function handleAnswer(req, event, team, utterance, kakaoUserId) {
  const teamReload = (await query(`SELECT * FROM teams WHERE id=$1;`, [team.id])).rows[0];
  const member = await getTeamMember(event.id, kakaoUserId);
  const actorName = member?.member_name || '팀원';

  if (!teamReload.current_mission_id) {
    return kakaoText('먼저 QR코드를 스캔해주세요.', ['미션 목록', ...menuQuickReplies]);
  }

  const mission = (await query(`SELECT * FROM missions WHERE id=$1;`, [teamReload.current_mission_id])).rows[0];
  if (!mission) return kakaoText('진행 중인 미션 정보를 찾을 수 없습니다. 미션 목록에서 다시 선택해주세요.', menuQuickReplies);

  const already = await isMissionAlreadyCompleted(team.id, mission.id);
  if (already) {
    return kakaoText(`이미 완료한 미션입니다.\n\n${mission.mission_code} ${mission.mission_name}\n\n다음 미션으로 이동해주세요.`, menuQuickReplies);
  }

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
    const earnedScore = isCorrect ? Math.max(minimumScore, baseScore - wrongCount * penaltyPerWrong) : 0;

    await query(
      `INSERT INTO submissions(event_id, team_id, mission_id, answer_text, status, score)
       VALUES ($1,$2,$3,$4,$5,$6);`,
      [event.id, team.id, mission.id, utterance, isCorrect ? 'correct' : 'wrong', earnedScore]
    );

    if (isCorrect) {
      const total = await afterMissionCompleted(event, team, mission, kakaoUserId, actorName);
      return kakaoText(
        `정답입니다!\n\n${mission.mission_code} ${mission.mission_name} 완료\n수행자: ${actorName}\n기본 점수: ${baseScore}점\n오답 횟수: ${wrongCount}회\n획득 점수: ${earnedScore}점\n현재 팀 총점: ${total}점\n\n다른 팀원에게도 미션 완료 알림이 표시됩니다.`,
        menuQuickReplies
      );
    }

    return kakaoText(
      `아쉽습니다. 정답이 아닙니다.\n\n현재 오답 횟수: ${wrongCount + 1}회\n힌트: ${mission.hint || '현장 안내문을 다시 확인해보세요.'}\n\n다시 정답을 입력해주세요.`,
      ['다시 입력하기', ...menuQuickReplies]
    );
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
      const total = await afterMissionCompleted(event, team, mission, kakaoUserId, actorName);
      return kakaoText(`방문 인증 완료!\n\n수행자: ${actorName}\n획득 점수: ${mission.score}점\n현재 팀 총점: ${total}점`, menuQuickReplies);
    }

    return kakaoText(`인증 문구가 맞지 않습니다.\n\n힌트: ${mission.hint || '현장 안내판의 인증 문구를 확인해주세요.'}`, menuQuickReplies);
  }

  if (mission.mission_type === 'complete') {
    const acceptable = splitAnswers(mission.answer || '완주');
    if (!acceptable.includes(normalizeAnswer(utterance))) {
      return kakaoText(`완료하려면 '${mission.answer || '완주'}'라고 입력해주세요.`, ['완주', ...menuQuickReplies]);
    }

    await query(
      `INSERT INTO submissions(event_id, team_id, mission_id, answer_text, status, score)
       VALUES ($1,$2,$3,$4,'approved',$5);`,
      [event.id, team.id, mission.id, utterance, mission.score]
    );

    const total = await afterMissionCompleted(event, team, mission, kakaoUserId, actorName);
    const ranking = await buildRanking(event.id);
    const myRank = ranking.find((r) => r.id === team.id)?.rank || '-';

    return kakaoText(
      `축하합니다! 완주 처리되었습니다.\n\n팀명: ${team.team_name}\n수행자: ${actorName}\n최종 점수: ${total}점\n현재 순위: ${myRank}위`,
      ['순위', '내 점수']
    );
  }

  if (mission.mission_type === 'photo' || mission.mission_type === 'gps') {
    return handleMissionStart(req, event, team, mission.mission_code);
  }

  return kakaoText('처리할 수 없는 미션 유형입니다. 운영자에게 문의해주세요.', menuQuickReplies);
}

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

  if (/^M\d+$/i.test(qrText)) return qrText.toUpperCase();

  try {
    const url = new URL(qrText);
    const code = url.searchParams.get('mission') || url.searchParams.get('code');
    if (code && /^M\d+$/i.test(code)) return code.toUpperCase();
  } catch {
    // URL이 아니면 무시
  }

  const found = qrText.match(/\bM\d+\b/i);
  return found ? found[0].toUpperCase() : '';
}

function requireAdmin(req, res, next) {
  const headerPassword = req.headers['x-admin-password'];
  const queryPassword = req.query.password;
  const cookiePassword = req.cookies?.admin_password;
  const password = headerPassword || queryPassword || cookiePassword;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, message: '관리자 비밀번호가 올바르지 않습니다.' });
  }

  next();
}

async function handleKakaoSkill(req, res) {
  try {
    if (KAKAO_SKILL_KEY && req.query.key !== KAKAO_SKILL_KEY) {
      return respondKakao(res, kakaoText('스킬 서버 인증키가 올바르지 않습니다. 운영자에게 문의해주세요.'));
    }

    if (!dbReady) {
      return respondKakao(
        res,
        kakaoText(`서버는 켜졌지만 DB 준비가 아직 끝나지 않았습니다.\n잠시 후 다시 시도해주세요.\n\nDB상태: ${dbInitError || '초기화 중'}`)
      );
    }

    const event = await getActiveEvent();
    const normalUtterance = String(req.body?.userRequest?.utterance || '').trim();
    const qrMissionCode = extractMissionCodeFromQr(req.body);
    const utterance = String(qrMissionCode || normalUtterance).trim();
    const kakaoUserId = String(
      req.body?.userRequest?.user?.id || req.body?.userRequest?.user?.properties?.plusfriendUserKey || ''
    ).trim();

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

    if (!team && userState?.state === 'WAIT_LEADER_NAME') {
      const memberName = cleanName(utterance);
      if (memberName.length < 2) {
        return respondKakao(res, kakaoText('이름 또는 닉네임은 2글자 이상으로 입력해주세요.\n예: 홍길동'));
      }
      await setUserState(event.id, kakaoUserId, 'WAIT_TEAM_NAME', { memberName });
      return respondKakao(res, kakaoText(`${memberName}님으로 등록하겠습니다.\n\n이제 팀명을 입력해주세요.\n예: 귤탐험대`, ['취소']));
    }

    if (!team && userState?.state === 'WAIT_TEAM_NAME') {
      const teamName = utterance.replace(/^(팀명|팀이름|팀 이름)[:：]?/i, '').trim();
      const memberName = data.memberName || '팀장';

      if (!teamName || teamName.length < 2) {
        return respondKakao(res, kakaoText('팀 이름은 2글자 이상으로 입력해주세요.\n예: 귤탐험대'));
      }
      if (teamName.length > 30) {
        return respondKakao(res, kakaoText('팀 이름은 30글자 이하로 입력해주세요.'));
      }
      if (isBlockedTeamName(teamName)) {
        return respondKakao(res, kakaoText('사용할 수 없는 팀 이름입니다.\n다른 팀 이름을 입력해주세요.\n예: 귤탐험대'));
      }

      team = await createTeam(event.id, kakaoUserId, teamName.slice(0, 30), memberName);
      await clearUserState(event.id, kakaoUserId);

      return respondKakao(
        res,
        kakaoText(
          `${team.team_name} 등록 완료!\n\n팀장: ${memberName}\n팀코드: ${team.team_code}\n\n이제 현장 QR코드를 스캔하면 미션이 시작됩니다.`,
          ['미션 목록', '팀원 목록', '도움말']
        ),
        event,
        team,
        kakaoUserId
      );
    }

    if (!team && userState?.state === 'WAIT_SELECT_JOIN_TEAM') {
      const index = Number(utterance) - 1;
      const teams = Array.isArray(data.teams) ? data.teams : [];
      if (!Number.isInteger(index) || index < 0 || index >= teams.length) {
        return respondKakao(res, kakaoText('목록에 있는 번호를 입력해주세요.\n예: 1', ['취소']));
      }
      const selected = teams[index];
      await setUserState(event.id, kakaoUserId, 'WAIT_JOIN_MEMBER_NAME', { teamId: selected.id, teamName: selected.name });
      return respondKakao(
        res,
        kakaoText(`${selected.name} 팀에 참가합니다.\n\n팀원 목록에 표시될 이름 또는 닉네임을 입력해주세요.\n예: 홍길동`, ['취소'])
      );
    }

    if (!team && userState?.state === 'WAIT_JOIN_MEMBER_NAME') {
      const memberName = cleanName(utterance);
      if (memberName.length < 2) {
        return respondKakao(res, kakaoText('이름 또는 닉네임은 2글자 이상으로 입력해주세요.\n예: 홍길동', ['취소']));
      }
      team = await joinTeamById(event.id, data.teamId, kakaoUserId, memberName);
      if (!team) {
        await clearUserState(event.id, kakaoUserId);
        return respondKakao(res, kakaoText('선택한 팀을 찾을 수 없습니다. 다시 팀 참가를 진행해주세요.', ['팀 참가', '팀 생성']));
      }
      await clearUserState(event.id, kakaoUserId);
      await addTeamNotice(event.id, team.id, `${memberName}님이 팀에 참가했습니다.`, kakaoUserId);
      return respondKakao(
        res,
        kakaoText(`${team.team_name} 팀 참가 완료!\n\n이름/닉네임: ${memberName}\n팀코드: ${team.team_code}\n\n이제 같은 팀으로 미션을 진행합니다.`, menuQuickReplies),
        event,
        team,
        kakaoUserId
      );
    }

    if (team && userState?.state === 'WAIT_EDIT_TEAM_NAME') {
      const teamName = utterance.replace(/^(팀명|팀이름|팀 이름)[:：]?/i, '').trim();
      if (!teamName || teamName.length < 2) {
        return respondKakao(res, kakaoText('팀 이름은 2글자 이상으로 입력해주세요.\n예: 한라탐험대', ['취소']), event, team, kakaoUserId);
      }
      if (teamName.length > 30 || isBlockedTeamName(teamName)) {
        return respondKakao(res, kakaoText('사용할 수 없는 팀 이름입니다. 다른 팀 이름을 입력해주세요.', ['취소']), event, team, kakaoUserId);
      }
      await query(`UPDATE teams SET team_name=$1 WHERE id=$2;`, [teamName.slice(0, 30), team.id]);
      await clearUserState(event.id, kakaoUserId);
      team = await getTeamByKakaoUser(event.id, kakaoUserId);
      await addTeamNotice(event.id, team.id, `팀명이 '${team.team_name}'(으)로 변경되었습니다.`, kakaoUserId);
      return respondKakao(res, kakaoText(`팀명 수정 완료!\n\n새 팀명: ${team.team_name}`, menuQuickReplies), event, team, kakaoUserId);
    }

    if (team && userState?.state === 'WAIT_EDIT_MEMBER_NAME') {
      const memberName = cleanName(utterance);
      if (memberName.length < 2) {
        return respondKakao(res, kakaoText('이름 또는 닉네임은 2글자 이상으로 입력해주세요.\n예: 홍길동', ['취소']), event, team, kakaoUserId);
      }
      await query(
        `UPDATE team_members SET member_name=$1 WHERE event_id=$2 AND kakao_user_id=$3;`,
        [memberName, event.id, kakaoUserId]
      );
      await clearUserState(event.id, kakaoUserId);
      await addTeamNotice(event.id, team.id, `${memberName}님이 이름/닉네임을 수정했습니다.`, kakaoUserId);
      return respondKakao(res, kakaoText(`이름/닉네임 수정 완료!\n\n새 이름: ${memberName}`, menuQuickReplies), event, team, kakaoUserId);
    }

    if (isStartCommand(utterance) || isHelpCommand(utterance)) {
      if (!team) {
        return respondKakao(
          res,
          kakaoText('제주 AI 탐험대에 오신 것을 환영합니다!\n\n새 팀을 만들거나 기존 팀에 참가해주세요.', startQuickReplies)
        );
      }
      return respondKakao(
        res,
        kakaoText(`${team.team_name} 팀으로 참여 중입니다.\n\n현장 QR코드를 스캔하거나 메뉴를 선택해주세요.`, menuQuickReplies),
        event,
        team,
        kakaoUserId
      );
    }

    if (!team && isCreateTeamCommand(utterance)) {
      await setUserState(event.id, kakaoUserId, 'WAIT_LEADER_NAME', {});
      return respondKakao(res, kakaoText('팀원 목록에 표시될 이름 또는 닉네임을 입력해주세요.\n예: 홍길동', ['취소']));
    }

    if (!team && isJoinTeamCommand(utterance)) {
      const response = await handleJoinTeamList(event, kakaoUserId);
      return respondKakao(res, response);
    }

    if (!team) {
      return respondKakao(res, kakaoText('먼저 팀을 만들거나 기존 팀에 참가해주세요.', startQuickReplies));
    }

    if (isTeamNameEditCommand(utterance)) {
      await setUserState(event.id, kakaoUserId, 'WAIT_EDIT_TEAM_NAME', {});
      return respondKakao(res, kakaoText('새 팀명을 입력해주세요.\n예: 한라탐험대', ['취소']), event, team, kakaoUserId);
    }

    if (isMemberNameEditCommand(utterance)) {
      await setUserState(event.id, kakaoUserId, 'WAIT_EDIT_MEMBER_NAME', {});
      return respondKakao(res, kakaoText('새 이름 또는 닉네임을 입력해주세요.\n예: 홍길동', ['취소']), event, team, kakaoUserId);
    }

    if (isTeamMembersCommand(utterance)) {
      return respondKakao(res, await handleTeamMembers(team), event, team, kakaoUserId);
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
    console.error('Kakao skill error:', error);
    return res.status(200).json(kakaoText(`서버 처리 중 오류가 발생했습니다.\n\n${error.message}`));
  }
}

app.get('/', (_req, res) => {
  res.status(200).send('Jeju Kakao Race Server Running');
});

app.get('/health', async (_req, res) => {
  if (!DATABASE_URL) {
    return res.status(200).json({ ok: true, server: 'running', db_ready: false, db_error: 'DATABASE_URL is not set', time: nowIso() });
  }

  try {
    await query('SELECT 1;');
    res.status(200).json({ ok: true, server: 'running', db_ready: dbReady, time: nowIso() });
  } catch (error) {
    res.status(200).json({ ok: true, server: 'running', db_ready: false, db_error: error.message, time: nowIso() });
  }
});

app.post('/kakao/skill', handleKakaoSkill);
app.post('/webhook', handleKakaoSkill);

app.get('/kakao/skill', (_req, res) => {
  res.send('Kakao skill endpoint is alive. Kakao uses POST.');
});

app.get('/webhook', (_req, res) => {
  res.send('Kakao webhook endpoint is alive. Kakao uses POST.');
});

app.get('/upload', (_req, res) => res.sendFile(path.join(publicDir, 'upload.html')));
app.get('/gps', (_req, res) => res.sendFile(path.join(publicDir, 'gps.html')));

app.post('/api/public/upload/photo', upload.single('photo'), async (req, res) => {
  try {
    const event = await getActiveEvent();
    const { team_code, mission_code, token, comment = '' } = req.body;
    const team = await getTeamByCodeAndToken(event.id, team_code, token);
    const mission = await getMissionByCode(event.id, mission_code);

    if (!team || !mission || mission.mission_type !== 'photo') {
      return res.status(400).json({ ok: false, message: '팀/미션 인증 정보가 올바르지 않습니다.' });
    }
    if (!req.file) return res.status(400).json({ ok: false, message: '사진 파일이 필요합니다.' });
    if (await isMissionAlreadyCompleted(team.id, mission.id)) return res.json({ ok: true, message: '이미 완료된 미션입니다.' });

    await query(
      `INSERT INTO submissions(event_id, team_id, mission_id, answer_text, image_data, image_mime, status, score)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',0);`,
      [event.id, team.id, mission.id, comment, req.file.buffer.toString('base64'), req.file.mimetype]
    );

    await addTeamNotice(event.id, team.id, `${mission.mission_code} ${mission.mission_name} 사진이 접수되었습니다. 운영자 승인 후 점수가 반영됩니다.`);
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

    if (!team || !mission || mission.mission_type !== 'gps') {
      return res.status(400).json({ ok: false, message: '팀/미션 인증 정보가 올바르지 않습니다.' });
    }
    if (mission.latitude === null || mission.longitude === null) {
      return res.status(400).json({ ok: false, message: '미션 좌표가 설정되어 있지 않습니다.' });
    }
    if (await isMissionAlreadyCompleted(team.id, mission.id)) {
      return res.json({ ok: true, message: '이미 완료된 미션입니다.' });
    }

    const distance = haversineMeters(Number(lat), Number(lng), Number(mission.latitude), Number(mission.longitude));
    const ok = distance <= Number(mission.radius_m || 80);

    await query(
      `INSERT INTO submissions(event_id, team_id, mission_id, answer_text, gps_lat, gps_lng, distance_m, status, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9);`,
      [event.id, team.id, mission.id, `GPS ${Math.round(distance)}m`, Number(lat), Number(lng), distance, ok ? 'approved' : 'rejected', ok ? mission.score : 0]
    );

    if (ok) {
      await maybeMarkFinished(team, event.id);
      const total = await teamTotalScore(team.id);
      await addTeamNotice(event.id, team.id, `${mission.mission_code} ${mission.mission_name} GPS 인증이 완료되었습니다. 현재 팀 점수는 ${total}점입니다.`);
    }

    res.json({
      ok,
      distance_m: Math.round(distance),
      message: ok
        ? `GPS 인증 완료! ${mission.score}점이 반영되었습니다.`
        : `현재 위치가 미션 장소에서 ${Math.round(distance)}m 떨어져 있습니다. 현장에서 다시 시도해주세요.`,
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get('/api/admin/status', requireAdmin, async (_req, res) => {
  res.json({ ok: true, db_ready: dbReady, db_error: dbInitError, time: nowIso() });
});

app.get('/api/admin/rankings', requireAdmin, async (_req, res) => {
  const event = await getActiveEvent();
  res.json({ ok: true, rankings: await buildRanking(event.id) });
});

app.get('/api/admin/teams', requireAdmin, async (_req, res) => {
  const event = await getActiveEvent();
  const result = await query(
    `SELECT t.*, COUNT(tm.id)::int AS member_count
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
    `INSERT INTO missions(event_id, mission_code, mission_name, mission_type, question, answer, score, hint, location_name, latitude, longitude, radius_m, sort_order, is_required)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *;`,
    [event.id, m.mission_code, m.mission_name, m.mission_type, m.question || '', m.answer || '', Number(m.score || 0), m.hint || '', m.location_name || '', m.latitude || null, m.longitude || null, Number(m.radius_m || 80), Number(m.sort_order || 0), m.is_required !== false]
  );
  res.json({ ok: true, mission: result.rows[0] });
});

app.patch('/api/admin/missions/:id', requireAdmin, async (req, res) => {
  const m = req.body;
  const result = await query(
    `UPDATE missions SET
      mission_code=$1, mission_name=$2, mission_type=$3, question=$4, answer=$5, score=$6,
      hint=$7, location_name=$8, latitude=$9, longitude=$10, radius_m=$11, sort_order=$12, is_required=$13
     WHERE id=$14 RETURNING *;`,
    [m.mission_code, m.mission_name, m.mission_type, m.question || '', m.answer || '', Number(m.score || 0), m.hint || '', m.location_name || '', m.latitude || null, m.longitude || null, Number(m.radius_m || 80), Number(m.sort_order || 0), m.is_required !== false, req.params.id]
  );
  res.json({ ok: true, mission: result.rows[0] });
});

app.delete('/api/admin/missions/:id', requireAdmin, async (req, res) => {
  await query(`DELETE FROM missions WHERE id=$1;`, [req.params.id]);
  res.json({ ok: true });
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
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ ok: false, message: 'decision은 approved 또는 rejected여야 합니다.' });
  }

  const sub = (
    await query(`SELECT s.*, m.score AS mission_score, m.mission_code, m.mission_name FROM submissions s JOIN missions m ON m.id=s.mission_id WHERE s.id=$1;`, [req.params.id])
  ).rows[0];

  if (!sub) return res.status(404).json({ ok: false, message: '제출 기록을 찾을 수 없습니다.' });

  const score = decision === 'approved' ? Number(sub.mission_score || 0) : 0;
  const result = await query(
    `UPDATE submissions SET status=$1, score=$2, review_note=$3, reviewed_at=NOW() WHERE id=$4 RETURNING *;`,
    [decision, score, note, req.params.id]
  );

  const team = (await query(`SELECT * FROM teams WHERE id=$1;`, [sub.team_id])).rows[0];
  await maybeMarkFinished(team, sub.event_id);

  if (decision === 'approved') {
    const total = await teamTotalScore(team.id);
    await addTeamNotice(sub.event_id, team.id, `${sub.mission_code} ${sub.mission_name} 사진 미션이 승인되었습니다. 현재 팀 점수는 ${total}점입니다.`);
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

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, message: err.message || '서버 오류' });
});

// 중요: Render 배포 실패를 막기 위해 DB 초기화보다 먼저 포트를 엽니다.
// Render Web Service는 반드시 process.env.PORT로 0.0.0.0에 바인딩되어야 합니다.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Jeju Kakao Race server running on 0.0.0.0:${PORT}`);

  initDb()
    .then(() => {
      dbReady = true;
      dbInitError = '';
      console.log('DB initialization completed.');
    })
    .catch((error) => {
      dbReady = false;
      dbInitError = error.message;
      console.error('DB initialization failed:', error);
      // process.exit(1)을 하지 않습니다. 그래야 Render가 포트 감지에 성공합니다.
    });
});
