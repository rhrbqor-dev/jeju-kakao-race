
const $ = (id) => document.getElementById(id);
let adminPassword = localStorage.getItem('adminPassword') || '';
let missionsCache = [];
let knownPendingPhotoIds = new Set();
let notificationEnabled = false;

function authHeaders() { return { 'Content-Type': 'application/json', 'x-admin-password': adminPassword }; }
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.message || '요청 실패');
  return data;
}
function esc(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function formatTime(v) { return v ? new Date(v).toLocaleString('ko-KR') : '-'; }
function duration(sec) { if (!sec) return '-'; const m=Math.floor(sec/60), s=sec%60; return `${m}분 ${s}초`; }
function badge(status) { return `<span class="badge ${esc(status)}">${esc(status)}</span>`; }
function toDatetimeLocalValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function datetimeLocalToIso(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}
function togglePhotoAutoTimeFields() {
  const enabled = $('photoAutoEnabled')?.checked;
  const useTime = $('photoAutoUseTime')?.checked;
  if ($('photoAutoTimeBox')) $('photoAutoTimeBox').style.opacity = enabled && useTime ? '1' : '.45';
  if ($('photoAutoStart')) $('photoAutoStart').disabled = !(enabled && useTime);
  if ($('photoAutoEnd')) $('photoAutoEnd').disabled = !(enabled && useTime);
}
function renderPhotoAutoStatus(data) {
  if (!data || !data.settings) {
    $('photoAutoStatus').textContent = '설정을 불러오지 못했습니다.';
    return;
  }
  const s = data.settings;
  const lines = [];
  lines.push(`자동 승인: ${s.enabled ? 'ON' : 'OFF'}`);
  lines.push(`시간 설정: ${s.use_time_window ? 'ON' : 'OFF'}`);
  if (s.use_time_window) {
    lines.push(`시작: ${s.start_at ? formatTime(s.start_at) : '-'}`);
    lines.push(`종료: ${s.end_at ? formatTime(s.end_at) : '-'}`);
  }
  lines.push(`현재 적용 상태: ${data.active ? '자동 승인 적용 중' : '자동 승인 미적용'}`);
  lines.push(`서버 시간: ${formatTime(data.server_time)}`);
  $('photoAutoStatus').textContent = lines.join('\n');
}
async function loadPhotoAutoApproval() {
  const data = await api('/api/admin/settings/photo-auto-approval');
  const s = data.settings || {};
  $('photoAutoEnabled').checked = !!s.enabled;
  $('photoAutoUseTime').checked = !!s.use_time_window;
  $('photoAutoStart').value = toDatetimeLocalValue(s.start_at);
  $('photoAutoEnd').value = toDatetimeLocalValue(s.end_at);
  togglePhotoAutoTimeFields();
  renderPhotoAutoStatus(data);
}
async function savePhotoAutoApproval() {
  const enabled = $('photoAutoEnabled').checked;
  const useTime = $('photoAutoUseTime').checked;
  const body = {
    enabled,
    use_time_window: useTime,
    start_at: useTime ? datetimeLocalToIso($('photoAutoStart').value) : '',
    end_at: useTime ? datetimeLocalToIso($('photoAutoEnd').value) : '',
  };
  const data = await api('/api/admin/settings/photo-auto-approval', { method:'PATCH', body: JSON.stringify(body) });
  renderPhotoAutoStatus(data);
  alert('사진 자동 승인 설정이 저장되었습니다.');
}


let messageDefaults = null;
const messageImageFields = [
  { key:'start', input:'imgStart', clear:'clearImgStart', status:'imgStartStatus' },
  { key:'returning', input:'imgReturning', clear:'clearImgReturning', status:'imgReturningStatus' },
  { key:'create_prompt', input:'imgCreatePrompt', clear:'clearImgCreatePrompt', status:'imgCreatePromptStatus' },
  { key:'team_name_saved', input:'imgTeamNameSaved', clear:'clearImgTeamNameSaved', status:'imgTeamNameSavedStatus' },
  { key:'team_created', input:'imgTeamCreated', clear:'clearImgTeamCreated', status:'imgTeamCreatedStatus' },
  { key:'need_team', input:'imgNeedTeam', clear:'clearImgNeedTeam', status:'imgNeedTeamStatus' },
  { key:'finish', input:'imgFinish', clear:'clearImgFinish', status:'imgFinishStatus' },
];

function messageImageStatusHtml(s, key) {
  if (s && s[key + '_has_image']) {
    const url = s[key + '_image_url'] || ('/api/public/settings/messages/' + encodeURIComponent(key) + '/image');
    return `현재 이미지: <a href="${url}" target="_blank">보기</a>`;
  }
  return '등록된 이미지 없음';
}
function fillMessageImages(s = {}) {
  messageImageFields.forEach(f => {
    if ($(f.input)) $(f.input).value = '';
    if ($(f.clear)) $(f.clear).checked = false;
    if ($(f.status)) $(f.status).innerHTML = messageImageStatusHtml(s, f.key);
  });
}
function fillMessageForm(s = {}, updateImages = true) {
  $('msgStart').value = s.start_message || '';
  $('msgReturning').value = s.returning_team_message || '';
  $('msgCreatePrompt').value = s.create_team_prompt || '';
  $('msgTeamNameSaved').value = s.team_name_saved_message || '';
  $('msgTeamCreated').value = s.team_created_message || '';
  $('msgNeedTeam').value = s.need_team_message || '';
  $('msgFinish').value = s.finish_message || '';
  if (updateImages) fillMessageImages(s);
}
function readMessageImage(inputId) {
  const file = $(inputId).files[0];
  if (!file) return Promise.resolve(null);
  if (file.size > 6 * 1024 * 1024) return Promise.reject(new Error('챗봇 문구 이미지는 6MB 이하로 업로드해주세요.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ data: String(reader.result).split(',')[1], mime: file.type || 'image/jpeg' });
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}
async function collectMessageForm() {
  const body = {
    start_message: $('msgStart').value,
    returning_team_message: $('msgReturning').value,
    create_team_prompt: $('msgCreatePrompt').value,
    team_name_saved_message: $('msgTeamNameSaved').value,
    team_created_message: $('msgTeamCreated').value,
    need_team_message: $('msgNeedTeam').value,
    finish_message: $('msgFinish').value,
  };

  for (const f of messageImageFields) {
    if ($(f.clear).checked) {
      body['clear_' + f.key + '_image'] = true;
      continue;
    }
    const image = await readMessageImage(f.input);
    if (image) {
      body[f.key + '_image_data'] = image.data;
      body[f.key + '_image_mime'] = image.mime;
    }
  }

  return body;
}
async function loadMessageSettings() {
  const data = await api('/api/admin/settings/messages');
  messageDefaults = data.defaults || null;
  fillMessageForm(data.settings || {});
  $('messageSettingsStatus').textContent = '문구/이미지 설정을 불러왔습니다.';
}
async function saveMessageSettings() {
  $('messageSettingsStatus').textContent = '문구/이미지를 저장하는 중입니다...';
  const body = await collectMessageForm();
  const data = await api('/api/admin/settings/messages', { method:'PATCH', body: JSON.stringify(body) });
  messageDefaults = data.defaults || messageDefaults;
  fillMessageForm(data.settings || {});
  $('messageSettingsStatus').textContent = '문구/이미지 설정이 저장되었습니다.';
  alert('챗봇 문구/이미지 설정이 저장되었습니다.');
}
async function resetMessageSettings() {
  if (!messageDefaults) {
    const data = await api('/api/admin/settings/messages');
    messageDefaults = data.defaults || data.settings || {};
  }
  fillMessageForm(messageDefaults || {}, false);
  $('messageSettingsStatus').textContent = '기본 문구로 채웠습니다. 저장 버튼을 눌러야 실제 반영됩니다. 이미지는 삭제 체크를 하지 않으면 유지됩니다.';
}

async function login() {
  adminPassword = $('adminPassword').value.trim();
  try {
    await api('/api/admin/login', { method:'POST', body: JSON.stringify({ password: adminPassword }) });
    localStorage.setItem('adminPassword', adminPassword);
    $('loginBox').classList.add('hidden');
    $('appBox').classList.remove('hidden');
    await loadAll();
    await loadPhotoAutoApproval();
    await loadMessageSettings();
  } catch(e) { $('loginMsg').textContent = e.message; }
}
function logout() { localStorage.removeItem('adminPassword'); location.reload(); }

async function enableNotifications() {
  if (!('Notification' in window)) { alert('이 브라우저는 알림을 지원하지 않습니다.'); return; }
  const result = await Notification.requestPermission();
  notificationEnabled = result === 'granted';
  alert(notificationEnabled ? '사진 업로드 알림이 허용되었습니다.' : '브라우저 알림이 허용되지 않았습니다.');
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination); gain.gain.value = 0.05; osc.frequency.value = 880; osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 220);
  } catch(e) {}
}
function showPhotoAlert(items) {
  const first = items[0];
  const msg = items.length === 1
    ? `새 사진 업로드: ${first.team_name} / ${first.actor_name || '팀원'} / ${first.mission_code} ${first.mission_name}`
    : `새 사진 업로드 ${items.length}건이 있습니다. 바로 승인해주세요.`;
  $('photoAlert').classList.remove('hidden');
  $('photoAlert').innerHTML = `<b>📸 ${esc(msg)}</b><span><button onclick="showTab('submissions')">승인하러 가기</button> <button class="secondary" onclick="$('photoAlert').classList.add('hidden')">닫기</button></span>`;
  beep();
  if (notificationEnabled && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('사진 인증 승인 대기', { body: msg });
  }
}

async function loadAll() {
  const summary = await api('/api/admin/summary');
  $('teamCount').textContent = summary.teamCount;
  $('finishedCount').textContent = summary.finishedCount;
  $('missionCount').textContent = summary.missionCount;
  $('pendingCount').textContent = summary.pendingCount;
  $('topTeam').textContent = summary.topTeam ? `${summary.topTeam.team_name} ${summary.topTeam.total_score}점` : '-';
  await Promise.all([loadRanking(), loadSubmissions(), loadMissions()]);
}
async function loadRanking() {
  const data = await api('/api/admin/rankings');
  $('rankingBody').innerHTML = data.rankings.map(r => `<tr><td>${r.rank}</td><td>${esc(r.team_code)}</td><td>${esc(r.team_name)}</td><td><b>${r.total_score}</b></td><td>${r.completed_count}</td><td>${esc(r.status)}</td><td>${duration(r.duration_seconds)}</td></tr>`).join('') || '<tr><td colspan="7">등록된 팀이 없습니다.</td></tr>';
}
async function loadSubmissions() {
  const data = await api('/api/admin/submissions');
  const pendingPhotos = data.submissions.filter(s => s.mission_type === 'photo' && s.status === 'pending');
  const newPending = pendingPhotos.filter(s => !knownPendingPhotoIds.has(String(s.id)));
  pendingPhotos.forEach(s => knownPendingPhotoIds.add(String(s.id)));
  if (newPending.length) showPhotoAlert(newPending);

  $('submissionBody').innerHTML = data.submissions.map(s => {
    const img = s.has_image ? `<a href="/api/admin/submissions/${s.id}/image?admin_password=${encodeURIComponent(adminPassword)}" target="_blank">사진보기</a>` : '';
    const gps = s.distance_m != null ? `GPS ${Math.round(s.distance_m)}m` : '';
    const actor = s.actor_name || '-';
    const manage = s.status === 'pending'
      ? `<button class="ok" onclick="review(${s.id},'approved')">승인</button> <button class="danger" onclick="review(${s.id},'rejected')">반려</button>`
      : '';
    return `<tr><td>${formatTime(s.submitted_at)}</td><td>${esc(s.team_name)}<br><span class="small">${esc(s.team_code)}</span></td><td><b>${esc(actor)}</b></td><td>${esc(s.mission_code)}<br>${esc(s.mission_name)}</td><td>${esc(s.mission_type)}</td><td>${esc(s.answer_text || '')}<br>${img} ${esc(gps)}</td><td>${badge(s.status)}</td><td>${s.score}</td><td>${manage}</td></tr>`;
  }).join('') || '<tr><td colspan="9">제출 내역이 없습니다.</td></tr>';
}
async function loadMissions() {
  const data = await api('/api/admin/missions');
  missionsCache = data.missions;
  $('missionBody').innerHTML = data.missions.map(m => {
    const missionImg = Number(m.mission_image_count || 0) > 0 ? `${m.mission_image_count}장` : (m.has_mission_image ? '1장' : '-');
    const answerImg = Number(m.answer_image_count || 0) > 0 ? `${m.answer_image_count}장` : '-';
    return `<tr><td>${esc(m.mission_code)}</td><td>${esc(m.mission_name)}</td><td>${esc(m.mission_type)}</td><td>${m.score}</td><td>${missionImg}</td><td>${answerImg}</td><td>${m.wrong_message ? '있음' : '-'}</td><td>${m.answer_explanation ? '있음' : '-'}</td><td><button class="secondary" onclick="editMission(${m.id})">수정</button> <button class="danger" onclick="deleteMission(${m.id})">삭제</button></td></tr>`;
  }).join('');
}
async function review(id, decision) {
  const note = prompt(decision === 'approved' ? '승인 메모(선택)' : '반려 사유(선택)', '') || '';
  await api(`/api/admin/submissions/${id}/review`, { method:'POST', body: JSON.stringify({ decision, note }) });
  await loadAll();
}
function showTab(name) {
  ['ranking','submissions','missions','settings','messages'].forEach(t => $('tab-' + t).classList.toggle('hidden', t !== name));
  if (name === 'settings') loadPhotoAutoApproval().catch(e => alert(e.message));
  if (name === 'messages') loadMessageSettings().catch(e => alert(e.message));
}
function editMission(id) {
  const m = missionsCache.find(x => x.id === id); if (!m) return;
  $('missionFormTitle').textContent = '미션 수정';
  $('missionId').value = m.id; $('missionCode').value = m.mission_code; $('missionName').value = m.mission_name; $('missionType').value = m.mission_type;
  $('missionQuestion').value = m.question; $('missionAnswer').value = m.answer; $('missionWrongMessage').value = m.wrong_message || ''; $('missionAnswerExplanation').value = m.answer_explanation || ''; $('missionScore').value = m.score; $('missionHint').value = m.hint;
  $('missionLocation').value = m.location_name; $('missionLat').value = m.latitude || ''; $('missionLng').value = m.longitude || ''; $('missionRadius').value = m.radius_m; $('missionOrder').value = m.sort_order;
  $('missionImages').value = ''; $('answerImages').value = '';
  loadMissionImagesForForm(m.id, 'mission').catch(e => $('missionImageStatus').textContent = e.message);
  loadMissionImagesForForm(m.id, 'answer').catch(e => $('answerImageStatus').textContent = e.message);
}
function clearMissionForm() {
  ['missionId','missionCode','missionName','missionQuestion','missionAnswer','missionWrongMessage','missionAnswerExplanation','missionHint','missionLocation','missionLat','missionLng'].forEach(id => $(id).value='');
  $('missionFormTitle').textContent = '미션 추가/수정';
  $('missionType').value='quiz'; $('missionScore').value=10; $('missionRadius').value=80; $('missionOrder').value=1;
  $('missionImages').value=''; $('answerImages').value='';
  $('missionImageStatus').textContent='등록된 미션 이미지 없음';
  $('answerImageStatus').textContent='등록된 정답 설명 이미지 없음';
}
const MISSION_IMAGE_LIMITS = { maxCount: 5, maxBytes: 2 * 1024 * 1024, allowed: ['image/jpeg','image/png','image/webp'] };
async function readImageFiles(inputId) {
  const files = Array.from($(inputId).files || []);
  if (!files.length) return [];
  if (files.length > MISSION_IMAGE_LIMITS.maxCount) throw new Error('이미지는 최대 5장까지 한 번에 선택할 수 있습니다.');
  const images = [];
  for (const file of files) {
    if (!MISSION_IMAGE_LIMITS.allowed.includes(file.type)) throw new Error('JPG, PNG, WEBP 이미지만 업로드할 수 있습니다.');
    if (file.size > MISSION_IMAGE_LIMITS.maxBytes) throw new Error('이미지 1장당 최대 2MB까지만 업로드할 수 있습니다.');
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
      reader.readAsDataURL(file);
    });
    images.push({ image_data: data, image_mime: file.type, file_name: file.name });
  }
  return images;
}
function imageListHtml(images, kind) {
  if (!images.length) return kind === 'answer' ? '등록된 정답 설명 이미지 없음' : '등록된 미션 이미지 없음';
  return images.map((img, idx) => `<div style="margin:6px 0;"><a href="${img.image_url}" target="_blank">${idx + 1}. ${esc(img.file_name || '이미지 보기')}</a> <button class="danger" onclick="deleteMissionImage(${img.id}, '${kind}')">삭제</button></div>`).join('');
}
async function loadMissionImagesForForm(missionId, kind) {
  if (!missionId) return;
  const data = await api(`/api/admin/missions/${missionId}/images?kind=${encodeURIComponent(kind)}`);
  const target = kind === 'answer' ? $('answerImageStatus') : $('missionImageStatus');
  target.innerHTML = imageListHtml(data.images || [], kind);
}
async function deleteMissionImage(imageId, kind) {
  if (!confirm('이 이미지를 삭제할까요?')) return;
  await api(`/api/admin/mission-images/${imageId}`, { method:'DELETE' });
  const missionId = $('missionId').value;
  await loadMissionImagesForForm(missionId, kind);
  await loadMissions();
}
async function uploadMissionImages(missionId, kind, inputId) {
  const images = await readImageFiles(inputId);
  if (!images.length) return;
  await api(`/api/admin/missions/${missionId}/images`, { method:'POST', body: JSON.stringify({ kind, images }) });
  $(inputId).value = '';
}
async function saveMission() {
  const body = {
    mission_code:$('missionCode').value.trim(), mission_name:$('missionName').value.trim(), mission_type:$('missionType').value,
    question:$('missionQuestion').value, answer:$('missionAnswer').value, wrong_message:$('missionWrongMessage').value, answer_explanation:$('missionAnswerExplanation').value, score:Number($('missionScore').value||0), hint:$('missionHint').value,
    location_name:$('missionLocation').value, latitude:$('missionLat').value ? Number($('missionLat').value) : null, longitude:$('missionLng').value ? Number($('missionLng').value) : null,
    radius_m:Number($('missionRadius').value||80), sort_order:Number($('missionOrder').value||0), is_required:true
  };
  const id = $('missionId').value;
  const data = await api(id ? `/api/admin/missions/${id}` : '/api/admin/missions', { method:id?'PATCH':'POST', body: JSON.stringify(body) });
  const missionId = id || data.mission.id;
  await uploadMissionImages(missionId, 'mission', 'missionImages');
  await uploadMissionImages(missionId, 'answer', 'answerImages');
  clearMissionForm(); await loadAll();
}
async function deleteMission(id) { if(confirm('정말 삭제할까요? 제출 기록도 함께 삭제될 수 있습니다.')) { await api(`/api/admin/missions/${id}`, { method:'DELETE' }); await loadAll(); } }
function downloadCsv() { location.href = `/api/admin/export/rankings.csv?admin_password=${encodeURIComponent(adminPassword)}`; }
async function resetEvent() { if(confirm('정말 모든 팀과 제출 기록을 초기화할까요?')) { knownPendingPhotoIds = new Set(); await api('/api/admin/reset-event', { method:'POST', body:'{}' }); await loadAll(); } }

if (adminPassword) { $('adminPassword').value = adminPassword; login(); }
setInterval(() => { if (!$('appBox').classList.contains('hidden')) loadAll().catch(()=>{}); }, 5000);
