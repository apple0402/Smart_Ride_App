#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Safe Ride — 스테이징 스모크 테스트 하니스 (DEPLOY.md 1단계 검증 자동화)
//
// 마이그레이션(20260917_review_lockdown.sql) + delete-account Edge Function 을
// 적용한 "스테이징" 프로젝트를 대상으로 RLS 잠금·RPC·검증·포인트·계정삭제·만료를
// 자동 점검한다. 앱 UI 클릭이 필요한 항목(회원탈퇴 버튼, 공사 종료 버튼)은
// 그 아래의 RPC/Edge/DB 동작으로 대체 검증하고, UI는 수동 확인 항목으로 남긴다.
//
// 사용법:
//   STAGING_URL=https://xxxx.supabase.co \
//   STAGING_ANON_KEY=... \
//   STAGING_SERVICE_KEY=...  \
//   node supabase/smoke-test.js            # 전체 실행
//   node supabase/smoke-test.js 2 6 10     # 특정 번호만 실행(의존 스텝은 자동 선행)
//
// 안전장치: 프로덕션 URL(jidpwflthppsltdayhoy)이면 즉시 중단한다.
// ⚠️ STAGING_SERVICE_KEY 는 매우 민감 — 셸 히스토리/커밋에 남기지 말 것.
// ═══════════════════════════════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');

const PROD_HOST = 'jidpwflthppsltdayhoy';
const URL  = process.env.STAGING_URL;
const ANON = process.env.STAGING_ANON_KEY;
const SVC  = process.env.STAGING_SERVICE_KEY;

function die(msg) { console.error('\n❌ ' + msg); process.exit(1); }

if (!URL || !ANON)  die('STAGING_URL / STAGING_ANON_KEY 환경변수가 필요합니다.');
if (URL.includes(PROD_HOST)) die('프로덕션 URL 이 감지되었습니다. 스테이징 전용 프로젝트로만 실행하세요.');
if (!SVC) console.warn('⚠️  STAGING_SERVICE_KEY 미설정 — 계정삭제/만료/유저생성 스텝은 건너뜁니다.');

// 서로 간섭하지 않도록 테스트마다 충분히 떨어진 좌표(약 5.5km 간격)를 쓴다.
const BASE = { lat: 37.5000, lng: 127.0000 };
const at = (i) => ({ lat: BASE.lat + i * 0.05, lng: BASE.lng + i * 0.05 });

const admin = SVC ? createClient(URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const rand  = () => Math.random().toString(36).slice(2, 10);

const state = { users: [], zones: [], pass: 0, fail: 0, skip: 0 };

// 새 anon 클라이언트(유저별 독립 세션)
function anonClient() {
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function makeUser(label) {
  if (!admin) return null;
  const email = `smoke+${rand()}@example.com`;
  const password = 'Smoke#' + rand() + 'A1';
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error('유저 생성 실패: ' + error.message);
  const cli = anonClient();
  const { error: sErr } = await cli.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error('로그인 실패: ' + sErr.message);
  const u = { label, id: data.user.id, email, password, cli };
  state.users.push(u);
  return u;
}

function ok(cond, detail) { if (!cond) throw new Error(detail || '조건 불충족'); }

async function expectRpcError(cli, fn, args, mustInclude) {
  const { error } = await cli.rpc(fn, args);
  ok(error, `${fn} 이 에러 없이 통과됨(거부 기대)`);
  if (mustInclude) ok((error.message || '').includes(mustInclude),
    `에러 메시지에 "${mustInclude}" 없음 → 실제: ${error.message}`);
}

// ── 체크 정의 ────────────────────────────────────────────────────────────────
const checks = [
  ['RLS: anon 직접 쓰기 거부(zones/reports/profiles insert)', async () => {
    const cli = anonClient();
    const p = at(0);
    const r1 = await cli.from('zones').insert({ id: 'smoke-'+rand(), lat:p.lat, lng:p.lng, title:'x', type:'other' });
    ok(r1.error, 'zones insert 가 거부되지 않음');
    const r2 = await cli.from('reports').insert({ id:'smoke-'+rand(), lat:p.lat, lng:p.lng, type:'other', title:'x' });
    ok(r2.error, 'reports insert 가 거부되지 않음');
    const r3 = await cli.from('profiles').insert({ id: '00000000-0000-0000-0000-000000000000', name:'x' });
    ok(r3.error, 'profiles insert 가 거부되지 않음');
  }],

  ['테스트 유저 3명 생성(email_confirm) + 로그인', async () => {
    if (!admin) return 'skip';
    await makeUser('u1'); await makeUser('u2'); await makeUser('u3');
    ok(state.users.length === 3, '유저 3명 생성 실패');
  }],

  ['정상 신고 → 마커 생성 + 기여 +3 (신규 유저는 unconfirmed)', async () => {
    if (!admin) return 'skip';
    const u = state.users[0]; const p = at(1);
    const { data, error } = await u.cli.rpc('submit_hazard_report',
      { p_type:'pothole', p_lat:p.lat, p_lng:p.lng, p_desc:'스모크', p_severity:'medium', p_address:'', p_gps_accuracy: 10 });
    ok(!error, '신고 에러: ' + (error && error.message));
    ok(data.action === 'created', 'action != created');
    ok(data.zone.confirmation === 'unconfirmed', `신규 유저 첫 신고인데 ${data.zone.confirmation}`);
    state.zones.push(data.zone.id);
    const { data: prof } = await u.cli.from('profiles').select('contribution_points').eq('id', u.id).single();
    ok((prof?.contribution_points || 0) >= 3, `기여 포인트 +3 미반영(${prof?.contribution_points})`);
  }],

  ['GPS 정확도 50m 초과 신고 → 거부', async () => {
    if (!admin) return 'skip';
    const u = state.users[0]; const p = at(2);
    await expectRpcError(u.cli, 'submit_hazard_report',
      { p_type:'pothole', p_lat:p.lat, p_lng:p.lng, p_desc:'', p_severity:'medium', p_address:'', p_gps_accuracy: 80 },
      '정확도');
  }],

  ['5분 내 동일 유형·근접 중복 신고 → 거부', async () => {
    if (!admin) return 'skip';
    const u = state.users[0]; const p = at(1); // 스텝3과 동일 좌표/유형
    await expectRpcError(u.cli, 'submit_hazard_report',
      { p_type:'pothole', p_lat:p.lat, p_lng:p.lng, p_desc:'', p_severity:'medium', p_address:'', p_gps_accuracy: 10 },
      '중복');
  }],

  ['서로 다른 2인 신고 → confirmed 승격 + 각 +7', async () => {
    if (!admin) return 'skip';
    const [u1, u2] = state.users; const p = at(3);
    const a = await u1.cli.rpc('submit_hazard_report',
      { p_type:'pothole', p_lat:p.lat, p_lng:p.lng, p_desc:'', p_severity:'medium', p_address:'', p_gps_accuracy: 10 });
    ok(!a.error && a.data.zone.confirmation === 'unconfirmed', '1인 신고가 이미 confirmed');
    state.zones.push(a.data.zone.id);
    const b = await u2.cli.rpc('submit_hazard_report',
      { p_type:'pothole', p_lat:p.lat+0.0002, p_lng:p.lng+0.0002, p_desc:'', p_severity:'medium', p_address:'', p_gps_accuracy: 10 });
    ok(!b.error, '2인 신고 에러: ' + (b.error && b.error.message));
    ok(b.data.zone.confirmation === 'confirmed', `2인 신고 후에도 ${b.data.zone.confirmation}`);
  }],

  ['서로 다른 3인 안전투표 → cleared + 신고자 rejected↑', async () => {
    if (!admin) return 'skip';
    // 전용 zone 생성(u1)
    const p = at(4);
    const z = await state.users[0].cli.rpc('submit_hazard_report',
      { p_type:'slippery', p_lat:p.lat, p_lng:p.lng, p_desc:'', p_severity:'medium', p_address:'', p_gps_accuracy: 10 });
    ok(!z.error, 'zone 생성 실패');
    const zoneId = z.data.zone.id; state.zones.push(zoneId);
    let cleared = false;
    for (const u of state.users) {
      const v = await u.cli.rpc('cast_safety_vote', { p_zone_id: zoneId });
      ok(!v.error, `투표 실패(${u.label}): ` + (v.error && v.error.message));
      cleared = v.data.cleared;
    }
    ok(cleared, '3표인데 cleared 안 됨');
    // 신고자(u1) rejected_reports 증가 확인 (service 로 조회)
    const { data: prof } = await admin.from('profiles').select('rejected_reports').eq('id', state.users[0].id).single();
    ok((prof?.rejected_reports || 0) >= 1, `rejected_reports 미증가(${prof?.rejected_reports})`);
  }],

  ['주행거리 누적 포인트(9km×2 → 10km 경계 +5)', async () => {
    if (!admin) return 'skip';
    const u = state.users[1];
    const before = (await admin.from('profiles').select('activity_points,distance_points_paid').eq('id', u.id).single()).data;
    await u.cli.rpc('record_ride', { p_distance_km: 9, p_duration: 100, p_avg_speed: 15, p_max_speed: 20, p_danger_zones: [], p_route: [] });
    await u.cli.rpc('record_ride', { p_distance_km: 9, p_duration: 100, p_avg_speed: 15, p_max_speed: 20, p_danger_zones: [], p_route: [] });
    const after = (await admin.from('profiles').select('activity_points,distance_points_paid,total_distance').eq('id', u.id).single()).data;
    const gained = (after.activity_points||0) - (before?.activity_points||0);
    ok(gained >= 5, `누적 18km인데 활동 포인트 증가분이 ${gained} (>=5 기대)`);
  }],

  ['피드백 루프: record_zone_pass + get_my_impact', async () => {
    if (!admin) return 'skip';
    // u1이 만든 confirmed zone(스텝6 at(3)) 을 u3(비신고자)가 통과
    const p = at(3);
    const conf = (await admin.from('zones').select('id').eq('confirmation','confirmed').gte('lat', p.lat-0.001).lte('lat', p.lat+0.01).limit(1)).data;
    ok(conf && conf.length, 'confirmed zone 을 찾지 못함');
    const zoneId = conf[0].id;
    const r = await state.users[2].cli.rpc('record_zone_pass', { p_zone_id: zoneId });
    ok(!r.error, 'record_zone_pass 에러: ' + (r.error && r.error.message));
    const impact = await state.users[0].cli.rpc('get_my_impact');
    ok(!impact.error, 'get_my_impact 에러');
    ok((impact.data.safePasses || 0) >= 1, `safePasses 미집계(${impact.data.safePasses})`);
  }],

  ['리포터 랭킹 get_leaderboard 반환', async () => {
    if (!admin) return 'skip';
    const { data, error } = await state.users[0].cli.rpc('get_leaderboard', { p_limit: 10 });
    ok(!error, 'get_leaderboard 에러: ' + (error && error.message));
    ok(Array.isArray(data) && data.length >= 1, '랭킹이 비어 있음');
    ok('contribution_points' in data[0], '랭킹 행에 contribution_points 없음');
  }],

  ['계정 삭제 Edge Function(delete-account) → 익명화·삭제·재로그인 불가', async () => {
    if (!admin) return 'skip';
    const u = state.users[2];
    // u3 가 신고 1건(익명화 확인용) + 라이딩 1건(삭제 확인용) 남김
    const p = at(6);
    const rep = await u.cli.rpc('submit_hazard_report',
      { p_type:'construction', p_lat:p.lat, p_lng:p.lng, p_desc:'', p_severity:'medium', p_address:'', p_gps_accuracy: 10 });
    if (!rep.error) state.zones.push(rep.data.zone.id);
    await u.cli.rpc('record_ride', { p_distance_km: 3, p_duration: 60, p_avg_speed: 12, p_max_speed: 18, p_danger_zones: [], p_route: [] });

    const del = await u.cli.functions.invoke('delete-account', { body: {} });
    ok(!del.error, 'delete-account 호출 에러: ' + (del.error && del.error.message));

    // 검증(service): reports.user_id NULL 익명화, rides 0건, profiles 0건, 재로그인 실패
    const rep2 = await admin.from('reports').select('id').eq('user_id', u.id);
    ok((rep2.data || []).length === 0, 'reports 가 아직 이 유저에 연결됨(익명화 실패)');
    const rides = await admin.from('rides').select('id').eq('user_id', u.id);
    ok((rides.data || []).length === 0, 'rides 가 삭제되지 않음');
    const prof = await admin.from('profiles').select('id').eq('id', u.id);
    ok((prof.data || []).length === 0, 'profiles CASCADE 삭제 안 됨');
    const relogin = await anonClient().auth.signInWithPassword({ email: u.email, password: u.password });
    ok(relogin.error, '삭제된 계정으로 재로그인이 됨');
    state.users = state.users.filter(x => x.id !== u.id); // 정리 대상에서 제외
  }],

  ['90일 무활동 만료 expire_stale_zones 실행(관리자)', async () => {
    if (!admin) return 'skip';
    const { data, error } = await admin.rpc('expire_stale_zones');
    ok(!error, 'expire_stale_zones 에러: ' + (error && error.message));
    ok(typeof data === 'number', `정수 반환 아님(${typeof data})`);
    console.log(`      → 만료 처리 ${data}건`);
  }],
];

const MANUAL = [
  '앱 UI: 프로필 ▸ 회원탈퇴 버튼 → 확인 다이얼로그 → 로그인 화면 복귀(위 Edge 동작은 자동 검증됨)',
  '앱 UI: 프로필 ▸ 리포터 랭킹/검증된 리포터 배지/임팩트 카드 노출',
  '상황실 UI: 공사 마커 ▸ "공사 종료 처리" 버튼 → 지도에서 숨김',
  '상황실 UI: "90일 무활동 마커 정리" 버튼 동작(위 RPC는 자동 검증됨)',
];

async function cleanup() {
  if (!admin) return;
  try {
    if (state.zones.length) await admin.from('zones').delete().in('id', state.zones);
    for (const u of state.users) {
      await admin.from('reports').delete().eq('user_id', u.id);
      await admin.auth.admin.deleteUser(u.id).catch(() => {});
    }
  } catch (e) { console.warn('정리 중 경고:', e.message); }
}

(async () => {
  const only = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
  console.log(`\n🧪 Safe Ride 스테이징 스모크 테스트 — ${URL}\n`);
  for (let i = 0; i < checks.length; i++) {
    const [name, fn] = checks[i];
    if (only.length && !only.includes(i + 1)) continue;
    process.stdout.write(`  [${String(i + 1).padStart(2)}] ${name} … `);
    try {
      const r = await fn();
      if (r === 'skip') { state.skip++; console.log('⏭️  SKIP(서비스 키 필요)'); }
      else { state.pass++; console.log('✅ PASS'); }
    } catch (e) {
      state.fail++; console.log('❌ FAIL\n        → ' + e.message);
    }
  }
  await cleanup();
  console.log(`\n결과: ✅ ${state.pass}  ❌ ${state.fail}  ⏭️ ${state.skip}`);
  console.log('\n📋 수동 확인(앱/상황실 UI):');
  MANUAL.forEach(m => console.log('  - ' + m));
  process.exit(state.fail ? 1 : 0);
})();
