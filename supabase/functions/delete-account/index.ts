// ═══════════════════════════════════════════════════════════════════════════
// Safe Ride — 계정 삭제(회원탈퇴) Edge Function
//
// 클라이언트는 본인 auth 계정을 직접 삭제할 권한이 없으므로 service_role 로 대행한다.
// service_role 키는 Edge Functions 런타임에 SUPABASE_SERVICE_ROLE_KEY 로 자동 주입되며
// 절대 클라이언트로 내려가지 않는다.
//
// 처리 순서(요청자 본인 JWT 검증 후):
//   1) reports.user_id → NULL  (신고 마커는 커뮤니티 자산이므로 익명화 후 유지)
//   2) rides           → 삭제  (개인 데이터 완전 삭제)
//   3) auth.admin.deleteUser  → profiles CASCADE 삭제, emergency_logs.user_id SET NULL
//
// 배포: supabase functions deploy delete-account
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // ── 1) 요청자 본인 확인 (JWT 검증) ──────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: '인증 토큰이 없습니다' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return json({ error: '유효하지 않은 세션입니다' }, 401);
  }
  const userId = userData.user.id;

  try {
    // ── 2) 신고 마커 익명화 (삭제하지 않음) ────────────────────────────────────
    const { error: anonErr } = await admin
      .from('reports')
      .update({ user_id: null })
      .eq('user_id', userId);
    if (anonErr) throw anonErr;

    // ── 3) 개인 라이딩 기록 완전 삭제 ──────────────────────────────────────────
    const { error: ridesErr } = await admin
      .from('rides')
      .delete()
      .eq('user_id', userId);
    if (ridesErr) throw ridesErr;

    // ── 4) auth 계정 삭제 (profiles CASCADE, emergency_logs SET NULL) ──────────
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) throw delErr;

    return json({ success: true });
  } catch (e) {
    return json({ error: (e as Error).message || '계정 삭제 중 오류가 발생했습니다' }, 400);
  }
});
