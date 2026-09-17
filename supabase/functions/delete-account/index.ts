// ═══════════════════════════════════════════════════════════════════════════
// Safe Ride — 계정 삭제(회원탈퇴) Edge Function
//
// 클라이언트는 본인 auth 계정을 직접 삭제할 권한이 없으므로 service_role 로 대행한다.
// service_role 키는 Edge Functions 런타임에 SUPABASE_SERVICE_ROLE_KEY 로 자동 주입되며
// 절대 클라이언트로 내려가지 않는다.
//
// 처리 순서(요청자 본인 JWT 검증 후):
//   1) rides            → 삭제      (개인 데이터 완전 삭제)
//   2) reports.user_id  → NULL      (신고 마커는 커뮤니티 자산 → 익명화 후 유지)
//   3) zones 배열 익명화 → reporter_ids / safe_voter_ids 에서 본인 id 제거
//   4) auth.admin.deleteUser        → profiles CASCADE 삭제, emergency_logs.user_id SET NULL
//
// 진단성: 각 단계에 라벨(step)을 달고, 실패 시 어느 단계에서 무슨 이유로 실패했는지
//         응답 본문과 함수 로그(console)에 함께 남긴다. 이렇게 하면 클라이언트가
//         non-2xx 만 보는 상황에서도 로그로 정확한 원인을 파악할 수 있다.
//
// 배포: supabase functions deploy delete-account   (또는 대시보드 에디터 붙여넣기)
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

// 단계 라벨 + 원본 에러를 로그에 남기고, 클라이언트에는 구조화된 에러를 반환한다.
// PostgrestError 등은 Error 인스턴스가 아니라 { message, code, details, hint } 객체이므로
// String(err) 하면 "[object Object]" 로 원인이 사라진다 → 필드를 직접 추려 직렬화한다.
function fail(step: string, err: unknown, status = 400) {
  let message: string;
  if (err instanceof Error) {
    message = err.message;
  } else if (err && typeof err === 'object') {
    const e = err as { message?: string; code?: string; details?: string; hint?: string };
    message = [
      e.message,
      e.code ? `code=${e.code}` : null,
      e.details,
      e.hint,
    ].filter(Boolean).join(' | ') || JSON.stringify(err);
  } else {
    message = String(err);
  }
  console.error(`[delete-account] step="${step}" failed: ${message}`);
  return json({ error: message || '계정 삭제 중 오류가 발생했습니다', step }, status);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // ── 0) 환경변수 확인 (미주입 시 원인을 명확히 드러낸다) ──────────────────────
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return fail(
      'env',
      `필수 환경변수 미주입 (SUPABASE_URL=${!!SUPABASE_URL}, SUPABASE_SERVICE_ROLE_KEY=${!!SERVICE_ROLE})`,
      500,
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 1) 요청자 본인 확인 (JWT 검증) ──────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: '인증 토큰이 없습니다', step: 'auth' }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return json({ error: '유효하지 않은 세션입니다', step: 'auth' }, 401);
  }
  const userId = userData.user.id;

  // ── 2) 개인 라이딩 기록 완전 삭제 ──────────────────────────────────────────
  {
    const { error } = await admin.from('rides').delete().eq('user_id', userId);
    if (error) return fail('rides.delete', error);
  }

  // ── 3) 신고 마커 익명화 (삭제하지 않음) ────────────────────────────────────
  {
    const { error } = await admin.from('reports').update({ user_id: null }).eq('user_id', userId);
    if (error) return fail('reports.anonymize', error);
  }

  // ── 4) zones 배열 익명화 — reporter_ids / safe_voter_ids 에서 본인 id 제거 ──
  //     zones 에는 user_id 컬럼이 없고, 신고자·투표자 id 를 TEXT[] 배열로 보관한다.
  //     탈퇴 유저 id 를 두 배열에서 제거해 커뮤니티 마커는 유지하되 신원은 지운다.
  {
    const { data: zoneRows, error: selErr } = await admin
      .from('zones')
      .select('id, reporter_ids, safe_voter_ids')
      .or(`reporter_ids.cs.{${userId}},safe_voter_ids.cs.{${userId}}`);
    if (selErr) return fail('zones.select', selErr);

    for (const z of zoneRows ?? []) {
      const reporter_ids = (z.reporter_ids ?? []).filter((x: string) => x !== userId);
      const safe_voter_ids = (z.safe_voter_ids ?? []).filter((x: string) => x !== userId);
      const { error } = await admin
        .from('zones')
        .update({ reporter_ids, safe_voter_ids })
        .eq('id', z.id);
      if (error) return fail('zones.anonymize', error);
    }
  }

  // ── 5) auth 계정 삭제 (profiles CASCADE, emergency_logs SET NULL) ───────────
  {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) return fail('auth.deleteUser', error);
  }

  return json({ success: true });
});
