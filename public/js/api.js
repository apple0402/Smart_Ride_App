// ═══════════════════════════════════════════════════════════════════════════
// Safe Ride — api.js  (Supabase 클라이언트 기반)
// ═══════════════════════════════════════════════════════════════════════════

function mapZone(z) {
  return {
    id:           z.id,
    lat:          z.lat,
    lng:          z.lng,
    title:        z.title,
    type:         z.type,
    desc:         z.description || '',
    address:      z.address || '',
    severity:     z.severity,
    reportCount:  z.report_count,
    safeVotes:    z.safe_votes    || 0,
    safeVoterIds: z.safe_voter_ids || [],
    status:       z.status        || 'active',
    confirmation: z.confirmation  || 'unconfirmed',
    reporterIds:  z.reporter_ids  || [],
    createdAt:    z.created_at
  };
}

// get_visible_zones RPC 행 → 앱 모델. reporter_ids/safe_voter_ids 원본 대신 호출자 기준 boolean 을 받는다.
function mapVisibleZone(z) {
  return {
    id:           z.id,
    lat:          z.lat,
    lng:          z.lng,
    title:        z.title,
    type:         z.type,
    desc:         z.description || '',
    address:      z.address || '',
    severity:     z.severity,
    reportCount:  z.report_count,
    safeVotes:    z.safe_votes || 0,
    status:       z.status || 'active',
    confirmation: z.confirmation || 'unconfirmed',
    createdAt:    z.created_at,
    adminConfirmed: !!z.admin_confirmed,
    isMine:       !!z.is_mine,
    iVoted:       !!z.i_voted,
    hasOwner:     !!z.has_owner
  };
}

function mapRide(r) {
  return {
    id:                r.id,
    distance:          r.distance,
    duration:          r.duration,
    avgSpeed:          r.avg_speed,
    maxSpeed:          r.max_speed,
    dangerZonesPassed: r.danger_zones_passed || [],
    createdAt:         r.created_at
  };
}

function _hav(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const API = {

  // ══ 위험구역 (활성 상태만 조회) ════════════════════════════════════════════
  // get_visible_zones RPC 가 활성 마커를 돌려준다. reporter_ids/safe_voter_ids 원본 대신
  // 호출자 기준 boolean(isMine/iVoted/hasOwner/adminConfirmed)만 받고, 차단한 소유자의 마커는
  // 서버에서 제외된다(비로그인도 호출 가능 — 지도는 로그인 없이 보임).
  async getZones() {
    const { data, error } = await sb.rpc('get_visible_zones');
    if (error) throw error;
    return (data || []).map(mapVisibleZone);
  },

  async getNearbyZones(lat, lng, radius = 500) {
    const all = await this.getZones();
    return all.filter(z => _hav(lat, lng, z.lat, z.lng) <= radius);
  },

  // ══ 위험 신고 ═════════════════════════════════════════════════════════════
  // 쓰기·검증(GPS정확도/중복/일일한도)·포인트·확인상태 판정을 모두 서버 RPC(submit_hazard_report)가 처리한다.
  // 검증 실패 시 RPC 가 한국어 예외 메시지를 반환 → error.message 그대로 노출한다.
  async reportHazard({ lat, lng, type, desc, severity, address, gpsAccuracy }) {
    const { data, error } = await sb.rpc('submit_hazard_report', {
      p_type:         type,
      p_lat:          lat,
      p_lng:          lng,
      p_desc:         desc || '',
      p_severity:     severity || 'medium',
      p_address:      address || '',
      p_gps_accuracy: (gpsAccuracy != null ? gpsAccuracy : null)
    });
    if (error) throw new Error(error.message || '신고 처리 중 오류가 발생했습니다');
    return { action: data.action, zone: mapZone(data.zone) };
  },

  // ══ 안전 투표 (3인 자동 해제) ═════════════════════════════════════════════
  // 중복 방지·집계·투표 포인트(+5)를 서버 RPC(cast_safety_vote)가 원자적으로 처리한다.
  async voteZoneSafe(zoneId) {
    const { data, error } = await sb.rpc('cast_safety_vote', { p_zone_id: zoneId });
    if (error) throw new Error(error.message || '투표 처리 중 오류');
    return { zone: mapZone(data.zone), cleared: data.cleared };
  },

  // ══ 라이딩 기록 ════════════════════════════════════════════════════════════
  // 저장 + 주행거리 포인트(누적 10km 경계 통과분)를 서버 RPC(record_ride)가 원자적으로 처리한다.
  async saveRide({ distance, duration, avgSpeed, maxSpeed, dangerZonesPassed, route }) {
    const { data, error } = await sb.rpc('record_ride', {
      p_distance_km:  parseFloat(distance) || 0,
      p_duration:     parseInt(duration)   || 0,
      p_avg_speed:    parseFloat(avgSpeed) || 0,
      p_max_speed:    parseFloat(maxSpeed) || 0,
      p_danger_zones: dangerZonesPassed || [],
      p_route:        route || []
    });
    if (error) throw error;
    return mapRide(data);
  },

  async getRides() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return [];
    const { data, error } = await sb.from('rides')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data.map(mapRide);
  },

  // ══ 사용자 프로필 ══════════════════════════════════════════════════════════
  // 프로필 row 는 회원가입 시 서버 트리거(handle_new_user)가 자동 생성한다.
  // RLS 로 클라이언트 직접 insert 가 막혀 있으므로 여기서는 조회만 한다.
  // (트리거 이전에 가입한 유저 등 행이 없으면 기본값으로 표시)
  async getProfile() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    return data || {
      id: user.id,
      name: user.user_metadata?.name || user.email.split('@')[0],
      safety_points: 0, total_reports: 0, total_distance: 0
    };
  },

  // 포인트 증감은 서버 RPC(submit_hazard_report / cast_safety_vote / record_ride)가
  // 원자적으로 전담한다. 클라이언트는 더 이상 profiles 를 직접 UPDATE 하지 않는다.

  // ══ 계정 삭제 (회원탈퇴) ════════════════════════════════════════════════════
  // auth 계정 삭제는 service_role 권한이 필요하므로 Edge Function(delete-account)이 대행한다.
  // reports 익명화 + rides 삭제 + auth 유저 삭제(profiles CASCADE)까지 서버에서 처리.
  async deleteAccount() {
    const { data, error } = await sb.functions.invoke('delete-account', { body: {} });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context?.json())?.error || msg; } catch {}
      throw new Error(msg || '계정 삭제에 실패했습니다');
    }
    if (data?.error) throw new Error(data.error);
    return { success: true };
  },

  // ══ 피드백 루프 / 랭킹 (섹션 6·7) ═════════════════════════════════════════
  // 안전 통과 카운트 — 라이딩 중 confirmed 마커 통과 시 호출(본인 신고 제외는 서버가 판정).
  async recordZonePass(zoneId) {
    await sb.rpc('record_zone_pass', { p_zone_id: zoneId });
  },

  // 내 신고가 만든 안전 통과 총합 (프로필 표시용)
  async getMyImpact() {
    const { data, error } = await sb.rpc('get_my_impact');
    if (error) return { safePasses: 0, markerCount: 0 };
    return { safePasses: data?.safePasses || 0, markerCount: data?.markerCount || 0 };
  },

  // 리포터 랭킹 (기여 포인트 상위)
  async getLeaderboard(limit = 20) {
    const { data, error } = await sb.rpc('get_leaderboard', { p_limit: limit });
    if (error) return [];
    return data || [];
  },

  // ══ 콘텐츠 신고 · 사용자 차단 (App Review 대응) ═════════════════════════════
  // 위험구역 마커(UGC) 신고 — 서버 RPC(submit_content_report)가 소유자(reporter_ids[1])를
  // 해석해 content_reports 에 기록한다(앱은 마커 ID만 전달, 상대 ID 비노출).
  // 반환 status: 'created' | 'duplicate'(이미 신고한 구역).
  async reportContent({ hazardId, reason, detail }) {
    const { data, error } = await sb.rpc('submit_content_report', {
      p_hazard_id: hazardId || null,
      p_reason:    reason,
      p_detail:    detail || null
    });
    if (error) throw new Error(error.message || '신고 처리 중 오류가 발생했습니다');
    return { status: (data && data.status) || 'created' };
  },

  // 마커 소유자 차단 — 서버 RPC(block_zone_owner)가 소유자를 해석해 blocked_users 에 기록(멱등).
  // 앱은 마커 ID만 전달(상대 ID 비노출).
  async blockZoneOwner(zoneId) {
    const { error } = await sb.rpc('block_zone_owner', { p_zone_id: zoneId });
    if (error) throw new Error(error.message || '차단 처리 중 오류가 발생했습니다');
  },

  // 차단 목록 (설정 관리 화면용). 이름은 익명화 정책상 노출하지 않는다.
  async getBlockedUsers() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return [];
    const { data, error } = await sb.from('blocked_users')
      .select('blocked_id, created_at')
      .order('created_at', { ascending: false });
    if (error) return [];
    return data || [];
  },

  async unblockUser(blockedId) {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error('로그인이 필요합니다');
    const { error } = await sb.from('blocked_users')
      .delete()
      .eq('blocker_id', user.id)
      .eq('blocked_id', blockedId);
    if (error) throw new Error(error.message || '차단 해제 중 오류가 발생했습니다');
  },

  // ══ 인증 ═══════════════════════════════════════════════════════════════════
  async signup(email, password, name) {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: {
        data: { name },
        // 네이티브 앱: 이메일 인증 링크 클릭 후 커스텀 스킴으로 앱 복귀 (SceneDelegate → appUrlOpen)
        emailRedirectTo: 'com.gansam.smartrider://auth-callback'
      }
    });
    if (error) return { error: error.message, code: error.code };
    // Confirm email ON 상태에서 '이미 가입된 이메일'은 (이메일 열거 방지로) 에러 없이
    // identities 가 빈 배열인 가짜 user 를 돌려준다 → 호출측에서 중복 가입으로 판정한다.
    return {
      id:         data.user?.id,
      email:      data.user?.email,
      name,
      identities: data.user?.identities ?? [],
      token:      data.session?.access_token
    };
  },

  async login(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message, code: error.code };
    const name = data.user.user_metadata?.name || email.split('@')[0];
    return { id: data.user.id, email: data.user.email, name, token: data.session.access_token };
  },

  // 가입 인증 메일 재발송. 서버가 60초 쿨다운·시간당 레이트리밋을 강제한다(초과 시 code=over_email_send_rate_limit).
  async resendSignupEmail(email) {
    const { error } = await sb.auth.resend({
      type:    'signup',
      email,
      options: { emailRedirectTo: 'com.gansam.smartrider://auth-callback' }
    });
    if (error) return { error: error.message, code: error.code };
    return {};
  },

  async logout() { await sb.auth.signOut(); },

  async getMe() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return {};
    return { id: user.id, email: user.email, name: user.user_metadata?.name || user.email.split('@')[0] };
  },

  // ══ SOS 긴급 로그 저장 (관제 연동용) ════════════════════════════════════════
  async logEmergency({ lat, lng, address }) {
    const { data: { user } } = await sb.auth.getUser();
    const { error } = await sb.from('emergency_logs').insert({
      user_id:   user?.id || null,
      latitude:  lat,
      longitude: lng,
      address:   address || ''
    });
    if (error) throw error;
  }
};
