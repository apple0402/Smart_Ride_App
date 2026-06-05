// ═══════════════════════════════════════════════════════════════════════════
// API — Supabase 클라이언트 기반 (Express JSON 파일 백엔드 대체)
// ═══════════════════════════════════════════════════════════════════════════

// ── DB 컬럼(snake_case) → 앱 객체(camelCase) 변환 ──────────────────────────
function mapZone(z) {
  return {
    id:          z.id,
    lat:         z.lat,
    lng:         z.lng,
    title:       z.title,
    type:        z.type,
    desc:        z.description || '',   // DB: description → 앱: desc
    severity:    z.severity,
    reportCount: z.report_count,
    createdAt:   z.created_at
  };
}

function mapRide(r) {
  return {
    id:                 r.id,
    distance:           r.distance,
    duration:           r.duration,
    avgSpeed:           r.avg_speed,
    maxSpeed:           r.max_speed,
    dangerZonesPassed:  r.danger_zones_passed || [],
    createdAt:          r.created_at
  };
}

// ── Haversine (100m 이내 중복 구역 체크용) ────────────────────────────────
function _hav(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── 랜덤 ID 생성 ──────────────────────────────────────────────────────────
function _uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const API = {

  // ══ 위험구역 ══════════════════════════════════════════════════════════════

  async getZones() {
    const { data, error } = await sb
      .from('zones')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data.map(mapZone);
  },

  async getNearbyZones(lat, lng, radius = 500) {
    const all = await this.getZones();
    return all.filter(z => _hav(lat, lng, z.lat, z.lng) <= radius);
  },

  // ══ 위험 신고 ═════════════════════════════════════════════════════════════
  // 1) reports 테이블에 저장
  // 2) 100m 이내 기존 구역 → reportCount 증가
  // 3) 없으면 zones 테이블에 신규 구역 생성
  async reportHazard({ lat, lng, type, desc, severity }) {
    const typeLabels = {
      wet_road:     'Wet Surface',
      sharp_turn:   'Sharp Turn',
      blind_spot:   'Blind Spot',
      construction: 'Road Construction',
      steep:        'Steep Descent',
      debris:       'Debris on Road',
      pothole:      'Pothole',
      general:      'Hazard'
    };
    const title = typeLabels[type] || 'Hazard';
    const { data: { user } } = await sb.auth.getUser();

    // 신고 저장
    await sb.from('reports').insert({
      id:          _uid('rpt'),
      user_id:     user?.id || null,
      lat, lng, type, title,
      description: desc || '',
      severity:    severity || 'medium'
    });

    // 중복 구역 확인 (100m 이내)
    const { data: zones } = await sb.from('zones').select('*');
    const nearby = zones.find(z => _hav(z.lat, z.lng, lat, lng) < 100);

    if (nearby) {
      const newCount = (nearby.report_count || 0) + 1;
      await sb.from('zones').update({ report_count: newCount }).eq('id', nearby.id);
      return { action: 'updated', zone: mapZone({ ...nearby, report_count: newCount }) };
    }

    const { data: newZone, error } = await sb.from('zones').insert({
      id:           _uid('zone'),
      lat, lng, title, type,
      description:  desc || '',
      severity:     severity || 'medium',
      report_count: 1
    }).select().single();
    if (error) throw error;
    return { action: 'created', zone: mapZone(newZone) };
  },

  // ══ 위험구역 해제 ══════════════════════════════════════════════════════════
  async clearZone(zoneId) {
    const { error } = await sb.from('zones').delete().eq('id', zoneId);
    if (error) throw error;
    return { success: true, id: zoneId };
  },

  // ══ 라이딩 기록 ════════════════════════════════════════════════════════════
  async saveRide({ distance, duration, avgSpeed, maxSpeed, dangerZonesPassed, route }) {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error('로그인 후 라이딩을 저장할 수 있습니다');

    const { data, error } = await sb.from('rides').insert({
      id:                  _uid('ride'),
      user_id:             user.id,
      distance:            parseFloat(distance) || 0,
      duration:            parseInt(duration)   || 0,
      avg_speed:           parseFloat(avgSpeed) || 0,
      max_speed:           parseFloat(maxSpeed) || 0,
      danger_zones_passed: dangerZonesPassed || [],
      route:               route || []
    }).select().single();
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

  // ══ 인증 (Supabase Auth) ═══════════════════════════════════════════════════
  async signup(email, password, name) {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { name } }
    });
    if (error) return { error: error.message };
    return {
      id:    data.user?.id,
      email: data.user?.email,
      name,
      token: data.session?.access_token
    };
  },

  async login(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    const name = data.user.user_metadata?.name || email.split('@')[0];
    return {
      id:    data.user.id,
      email: data.user.email,
      name,
      token: data.session.access_token
    };
  },

  async logout() {
    await sb.auth.signOut();
  },

  async getMe() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return {};
    return {
      id:    user.id,
      email: user.email,
      name:  user.user_metadata?.name || user.email.split('@')[0]
    };
  }
};
