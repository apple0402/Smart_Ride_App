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
  async getZones() {
    const { data, error } = await sb
      .from('zones')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data.map(mapZone);
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
    if (error) return { error: error.message };
    return { id: data.user?.id, email: data.user?.email, name, token: data.session?.access_token };
  },

  async login(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    const name = data.user.user_metadata?.name || email.split('@')[0];
    return { id: data.user.id, email: data.user.email, name, token: data.session.access_token };
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
