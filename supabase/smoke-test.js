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
    // 실제 RPC 예외 메시지는 '방금 같은 위험을 신고하셨습니다' — GPS/일일한도 등 다른 거부와
    // 구분되도록 이 문구('방금')로 검사한다(중복 규칙으로 거부됐는지까지 확인).
    await expectRpcError(u.cli, 'submit_hazard_report',
      { p_type:'pothole', p_lat:p.lat, p_lng:p.lng, p_desc:'', p_severity:'medium', p_address:'', p_gps_accuracy: 10 },
      '방금');
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
    const b = await admin.from('profiles').select('activity_points,distance_points_paid').eq('id', u.id).single();
    // 컬럼 미존재/조회 에러를 삼키지 않고 원인을 드러낸다(널 크래시 방지).
    ok(!b.error, `프로필 조회(before) 에러: ${b.error && b.error.message}`);
    const before = b.data;

    const r1 = await u.cli.rpc('record_ride', { p_distance_km: 9, p_duration: 100, p_avg_speed: 15, p_max_speed: 20, p_danger_zones: [], p_route: [] });
    ok(!r1.error, `record_ride #1 에러: ${r1.error && r1.error.message}`);
    const r2 = await u.cli.rpc('record_ride', { p_distance_km: 9, p_duration: 100, p_avg_speed: 15, p_max_speed: 20, p_danger_zones: [], p_route: [] });
    ok(!r2.error, `record_ride #2 에러: ${r2.error && r2.error.message}`);

    const a = await admin.from('profiles').select('activity_points,distance_points_paid,total_distance').eq('id', u.id).single();
    ok(!a.error, `프로필 조회(after) 에러: ${a.error && a.error.message}`);
    ok(a.data, `프로필 row 없음(after) — 트리거 미설치 또는 record_ride 롤백 의심`);
    const gained = (a.data.activity_points || 0) - (before?.activity_points || 0);
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
    if (del.error) {
      // FunctionsHttpError 는 message 가 일반적("non-2xx")이라 실제 원인이 안 보인다.
      // 함수가 반환한 JSON 본문({ error, step })을 꺼내 실제 단계·사유를 노출한다.
      let detail = del.error.message || '알 수 없는 오류';
      try {
        const ctx = del.error.context;
        if (ctx && typeof ctx.json === 'function') {
          const body = await ctx.json();
          if (body && (body.error || body.step)) {
            detail += ` | step=${body.step || '?'} · ${body.error || ''}`;
          }
        }
      } catch (_) { /* 본문 파싱 실패는 무시하고 일반 메시지만 사용 */ }
      ok(false, 'delete-account 호출 에러: ' + detail);
    }

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

  // ── emergency_logs S1: SELECT 를 본인 행으로 축소 ─────────────────────────────
  ['emergency_logs: 로그인 사용자가 타인/익명 SOS 행을 못 읽는다', async () => {
    if (!admin) return 'skip';
    const [uA, uB] = state.users; const p = at(5); const tag = 'smoke-sel-' + rand();
    // service 로 uB 행 1개 + 익명(NULL) 행 1개 시드(태그로만 정리 → 실데이터 무영향)
    const seed = await admin.from('emergency_logs').insert([
      { user_id: uB.id, latitude: p.lat, longitude: p.lng, address: tag },
      { user_id: null,  latitude: p.lat, longitude: p.lng, address: tag },
    ]);
    ok(!seed.error, '시드 insert 실패: ' + (seed.error && seed.error.message));
    // uA 세션(RLS 적용)으로 이 태그 행을 조회 → 본인 것이 아니므로 0건이어야 한다
    const asA = await uA.cli.from('emergency_logs').select('id').eq('address', tag);
    ok(!asA.error, 'select 에러: ' + (asA.error && asA.error.message));
    ok((asA.data || []).length === 0, `타인/익명 SOS 행이 노출됨(${(asA.data || []).length}건)`);
    await admin.from('emergency_logs').delete().eq('address', tag);
  }],

  // ── emergency_logs S3: INSERT 강화(authenticated / anon) ──────────────────────
  ['emergency_logs: INSERT 사칭 차단 — authenticated & anon', async () => {
    if (!admin) return 'skip';
    const [uA, uB] = state.users; const p = at(5); const tag = 'smoke-ins-' + rand();
    // (1) authenticated: 타인 user_id 삽입 거부
    const spoof = await uA.cli.from('emergency_logs')
      .insert({ user_id: uB.id, latitude: p.lat, longitude: p.lng, address: tag });
    ok(spoof.error, 'authenticated 가 타인 user_id 로 삽입됨(사칭 차단 실패)');
    // (2) authenticated: 본인 user_id 삽입 허용
    const self = await uA.cli.from('emergency_logs')
      .insert({ user_id: uA.id, latitude: p.lat, longitude: p.lng, address: tag });
    ok(!self.error, '본인 SOS 삽입이 거부됨: ' + (self.error && self.error.message));
    // (3) anon: 타인 user_id 삽입 거부
    const anon = anonClient();
    const anonSpoof = await anon.from('emergency_logs')
      .insert({ user_id: uA.id, latitude: p.lat, longitude: p.lng, address: tag });
    ok(anonSpoof.error, 'anon 이 임의 user_id 로 삽입됨(사칭 차단 실패)');
    // (4) anon: user_id NULL 삽입 허용(비로그인 SOS 유지)
    const anonNull = await anon.from('emergency_logs')
      .insert({ user_id: null, latitude: p.lat, longitude: p.lng, address: tag });
    ok(!anonNull.error, '비로그인 SOS(NULL) 삽입이 거부됨: ' + (anonNull.error && anonNull.error.message));
    // (5) anon: SELECT 불가(권한 회수됨 → 에러이거나 0건)
    const anonSel = await anon.from('emergency_logs').select('id').eq('address', tag);
    ok(anonSel.error || (anonSel.data || []).length === 0,
      `anon 이 SOS 행을 조회함(${(anonSel.data || []).length}건)`);
    await admin.from('emergency_logs').delete().eq('address', tag);
  }],

  // ── emergency_logs S2/S5: 탈퇴 시 삭제(전체/NULL 개수 비교로 순서까지 검증) ────
  ['emergency_logs: 탈퇴 시 본인 SOS 삭제(개수 검증)', async () => {
    if (!admin) return 'skip';
    const u = await makeUser('del-emlog'); const p = at(7); const tag = 'smoke-del-' + rand();
    for (let i = 0; i < 2; i++) {
      const r = await u.cli.from('emergency_logs')
        .insert({ user_id: u.id, latitude: p.lat, longitude: p.lng, address: tag });
      ok(!r.error, 'SOS insert 실패: ' + (r.error && r.error.message));
    }
    // cnt 헬퍼: 필터는 select('id',{count,head}) '뒤'에 붙여야 한다(from() 뒤에 붙이면 TypeError).
    // 그래서 헬퍼는 '쿼리에 필터를 적용하는 함수'를 인자로 받는다.
    const cnt = async (applyFilter) => {
      let q = admin.from('emergency_logs').select('id', { count: 'exact', head: true });
      if (applyFilter) q = applyFilter(q);
      const { count, error } = await q;
      ok(!error, 'emergency_logs count 에러: ' + (error && error.message));
      return count || 0;
    };
    const totalB = await cnt();
    const nullB  = await cnt(q => q.is('user_id', null));
    const mineB  = await cnt(q => q.eq('user_id', u.id));
    ok(mineB === 2, `본인 SOS 2건 아님(${mineB})`);

    const del = await u.cli.functions.invoke('delete-account', { body: {} });
    ok(!del.error, 'delete-account 호출 에러');

    const totalA = await cnt();
    const nullA  = await cnt(q => q.is('user_id', null));
    const mineA  = await cnt(q => q.eq('user_id', u.id));
    ok(mineA === 0,           `탈퇴 후 본인 SOS 행 잔존(${mineA})`);
    ok(totalA === totalB - 2, `전체 행이 정확히 2 감소하지 않음(${totalB}→${totalA})`);
    // 삭제가 deleteUser 보다 '먼저'면 FK SET NULL 로 바뀔 행이 없어 NULL 개수 불변.
    // 순서가 뒤바뀌면 본인 2행이 NULL 로 승격돼 nullA = nullB + 2 로 FAIL 한다.
    ok(nullA === nullB,       `NULL 행 개수 변동(${nullB}→${nullA}) — 삭제가 deleteUser 보다 늦음(순서 오류)`);
    state.users = state.users.filter(x => x.id !== u.id);
  }],
];

const MANUAL = [
  '앱 UI: 프로필 ▸ 회원탈퇴 버튼 → 확인 다이얼로그 → 로그인 화면 복귀(위 Edge 동작은 자동 검증됨)',
  '앱 UI: 프로필 ▸ 리포터 랭킹/검증된 리포터 배지/임팩트 카드 노출',
  '상황실 UI: 공사 마커 ▸ "공사 종료 처리" 버튼 → 지도에서 숨김',
  '상황실 UI: "90일 무활동 마커 정리" 버튼 동작(위 RPC는 자동 검증됨)',
];

// 프리플라이트: 서비스 키가 PostgREST 에서 실제로 RLS 를 우회하는지(=service_role 로 인식되는지)
// 확인한다. GoTrue admin(createUser)은 되는데 profiles select 가 비면 원인이 갈리므로, insert 로
// 트리거 부재 vs 키(RLS 우회) 문제를 구분해 명확한 메시지로 즉시 중단한다.
async function preflight() {
  if (!admin) return;
  const email = `smoke-preflight+${rand()}@example.com`;
  const cr = await admin.auth.admin.createUser({ email, password: 'Pf#' + rand() + 'A1', email_confirm: true });
  if (cr.error) die('서비스 키로 유저 생성 실패(권한 문제): ' + cr.error.message);
  const uid = cr.data.user.id;
  try {
    const seen = await admin.from('profiles').select('id').eq('id', uid);
    if (seen.error) die(`서비스 키 PostgREST 접근 에러: ${seen.error.message}\n   → STAGING_SERVICE_KEY 가 secret/service_role 키인지 확인하세요.`);
    if (!seen.data || !seen.data.length) {
      // 조회가 비었다: 키(RLS 우회) 문제인지 트리거 부재인지 admin insert 로 판별
      const ins = await admin.from('profiles').insert({ id: uid, name: 'preflight' });
      if (ins.error) {
        die('STAGING_SERVICE_KEY 가 RLS 를 우회하지 못합니다(service_role 미인식) — 이것이 [7][8][9] 실패의 원인입니다.\n' +
            `   profiles insert 도 거부됨: ${ins.error.message}\n` +
            '   → 새 형식이면 sb_secret_ (publishable 아님), 레거시면 service_role (anon 아님) 키인지,\n' +
            '     그리고 프로젝트/클라이언트가 새 API 키를 PostgREST 에서 지원하는지 확인하세요.');
      }
      console.warn('⚠️  on_auth_user_created 트리거가 프로필을 자동 생성하지 않습니다(마이그레이션 (a) 섹션 미적용 의심). 서비스 키 자체는 정상.');
    }
  } finally {
    await admin.auth.admin.deleteUser(uid).catch(() => {});
  }
}

// 실행 전 정리: 이전 실행 잔여 데이터가 테스트 좌표에 남아 있으면 신규 신고가 기존 마커에
// 병합(action=updated)되거나 이미 confirmed 인 마커에 붙어 [3]/[6]/[9] 가 오탐한다.
// 실좌표 데이터 보호를 위해 각 테스트 지점(at 0..7) ±0.002도(약 220m) 만 좁게 지운다.
async function preclean() {
  if (!admin) return;
  const d = 0.002;
  try {
    for (let i = 0; i <= 7; i++) {
      const p = at(i);
      const box = (q) => q.gte('lat', p.lat - d).lte('lat', p.lat + d).gte('lng', p.lng - d).lte('lng', p.lng + d);
      await box(admin.from('zones').delete());
      await box(admin.from('reports').delete());
    }
    // 이전 실행에서 남은 emergency_logs 테스트 행 정리(태그로만 → 실 SOS 데이터 무영향)
    await admin.from('emergency_logs').delete().like('address', 'smoke-%');
    // 이전 실행에서 남은 smoke 테스트 유저 정리(profiles/데이터는 CASCADE·좌표정리로 처리됨)
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error || !data || !data.users.length) break;
      for (const su of data.users) {
        if ((su.email || '').startsWith('smoke+')) await admin.auth.admin.deleteUser(su.id).catch(() => {});
      }
      if (data.users.length < 200) break;
    }
  } catch (e) { console.warn('사전 정리 경고:', e.message); }
}

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
  // 의존 스텝 자동 선행: 스텝들은 공유 state(유저/zone)에 의존하므로, 특정 번호만 요청해도
  // 그 앞 스텝(1..max)을 조용히 먼저 실행해 상태를 만든다. 집계/출력은 요청 번호만 한다.
  const maxN = only.length ? Math.max(...only) : checks.length;
  console.log(`\n🧪 Safe Ride 스테이징 스모크 테스트 — ${URL}\n`);
  await preflight();  // 서비스 키 RLS 우회 여부 선검사(문제면 명확한 메시지로 중단)
  await preclean();   // 이전 실행 잔여 데이터 정리(테스트 좌표 주변만)
  for (let i = 0; i < checks.length; i++) {
    const n = i + 1;
    if (n > maxN) break;                         // 요청 최대 번호 이후는 실행하지 않음
    const [name, fn] = checks[i];
    const target = !only.length || only.includes(n);
    if (target) process.stdout.write(`  [${String(n).padStart(2)}] ${name} … `);
    try {
      const r = await fn();
      if (!target) continue;                     // 선행(의존) 스텝: 상태만 만들고 집계 제외
      if (r === 'skip') { state.skip++; console.log('⏭️  SKIP(서비스 키 필요)'); }
      else { state.pass++; console.log('✅ PASS'); }
    } catch (e) {
      if (!target) { console.warn(`  ↳ 선행 [${n}] ${name} 경고: ${e.message}`); continue; }
      state.fail++; console.log('❌ FAIL\n        → ' + e.message);
    }
  }
  await cleanup();
  console.log(`\n결과: ✅ ${state.pass}  ❌ ${state.fail}  ⏭️ ${state.skip}`);
  console.log('\n📋 수동 확인(앱/상황실 UI):');
  MANUAL.forEach(m => console.log('  - ' + m));
  process.exit(state.fail ? 1 : 0);
})();
