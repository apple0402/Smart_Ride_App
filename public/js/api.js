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
    severity:     z.severity,
    reportCount:  z.report_count,
    safeVotes:    z.safe_votes    || 0,
    safeVoterIds: z.safe_voter_ids || [],
    status:       z.status        || 'active',
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

function _uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
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
  async reportHazard({ lat, lng, type, desc, severity }) {
    const typeLabels = {
      pothole:      '포트홀 / 크랙',
      slippery:     '맨홀 / 미끄러움',
      construction: '도로 / 보도 공사',
      other:        '기타 위험'
    };
    const title = typeLabels[type] || '기타 위험';
    const { data: { user } } = await sb.auth.getUser();

    await sb.from('reports').insert({
      id:          _uid('rpt'),
      user_id:     user?.id || null,
      lat, lng, type, title,
      description: desc || '',
      severity:    severity || 'medium'
    });

    const { data: zones } = await sb.from('zones').select('*').eq('status', 'active');
    const nearby = (zones || []).find(z => _hav(z.lat, z.lng, lat, lng) < 100);

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
      report_count: 1,
      safe_votes:   0,
      safe_voter_ids: [],
      status:       'active'
    }).select().single();
    if (error) throw error;
    return { action: 'created', zone: mapZone(newZone) };
  },

  // ══ 안전 투표 (3인 자동 해제) ═════════════════════════════════════════════
  async voteZoneSafe(zoneId) {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error('로그인이 필요합니다');

    const { data: zone, error: zErr } = await sb.from('zones').select('*').eq('id', zoneId).single();
    if (zErr) throw zErr;

    const voterIds = zone.safe_voter_ids || [];
    if (voterIds.includes(user.id)) throw new Error('이미 투표하셨습니다');

    const newVotes    = (zone.safe_votes || 0) + 1;
    const newVoterIds = [...voterIds, user.id];
    const newStatus   = newVotes >= 3 ? 'cleared' : 'active';

    const { data, error } = await sb.from('zones')
      .update({ safe_votes: newVotes, safe_voter_ids: newVoterIds, status: newStatus })
      .eq('id', zoneId)
      .select()
      .single();
    if (error) throw error;
    return { zone: mapZone(data), cleared: newStatus === 'cleared' };
  },

  // ══ 위험구역 해제 (관리자) ═════════════════════════════════════════════════
  async clearZone(zoneId) {
    const { error } = await sb.from('zones').update({ status: 'cleared' }).eq('id', zoneId);
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

  // ══ 사용자 프로필 ══════════════════════════════════════════════════════════
  async getProfile() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
    if (error && error.code === 'PGRST116') {
      const { data: np } = await sb.from('profiles').insert({
        id: user.id,
        name: user.user_metadata?.name || user.email.split('@')[0],
        safety_points: 0, total_reports: 0, total_distance: 0
      }).select().single();
      return np || null;
    }
    return data || null;
  },

  async addSafetyPoints(points, reportsDelta = 0, distanceDelta = 0) {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data: existing } = await sb.from('profiles').select('*').eq('id', user.id).single();
    if (existing) {
      await sb.from('profiles').update({
        safety_points:  (existing.safety_points  || 0) + points,
        total_reports:  (existing.total_reports  || 0) + reportsDelta,
        total_distance: (existing.total_distance || 0) + distanceDelta,
        updated_at:     new Date().toISOString()
      }).eq('id', user.id);
    } else {
      await sb.from('profiles').insert({
        id: user.id,
        name: user.user_metadata?.name || user.email.split('@')[0],
        safety_points: points, total_reports: reportsDelta, total_distance: distanceDelta
      });
    }
  },

  // ══ 인증 ═══════════════════════════════════════════════════════════════════
  async signup(email, password, name) {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { name } }
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
