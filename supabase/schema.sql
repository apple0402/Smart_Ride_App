-- ============================================================
-- SmartRider — Supabase Schema
-- Supabase SQL Editor에서 이 파일 전체를 실행하세요.
-- ============================================================

-- ── 1. 위험구역 테이블 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS zones (
  id           TEXT PRIMARY KEY,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  title        TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'general',
  desc         TEXT DEFAULT '',
  severity     TEXT NOT NULL DEFAULT 'medium',
  report_count INT  NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. 라이딩 기록 테이블 ────────────────────────────────────
CREATE TABLE IF NOT EXISTS rides (
  id                   TEXT PRIMARY KEY,
  user_id              UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  distance             DOUBLE PRECISION DEFAULT 0,
  duration             INT DEFAULT 0,
  avg_speed            DOUBLE PRECISION DEFAULT 0,
  max_speed            DOUBLE PRECISION DEFAULT 0,
  danger_zones_passed  TEXT[] DEFAULT '{}',
  route                JSONB DEFAULT '[]',
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. 위험 신고 테이블 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,
  user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  desc       TEXT DEFAULT '',
  severity   TEXT DEFAULT 'medium',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- RLS (Row Level Security) 정책
-- ============================================================

-- zones: 누구나 읽기 가능 / 로그인한 사용자만 쓰기 가능
ALTER TABLE zones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "zones_public_read"
  ON zones FOR SELECT USING (true);

CREATE POLICY "zones_auth_insert"
  ON zones FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "zones_auth_update"
  ON zones FOR UPDATE USING (auth.role() = 'authenticated');

CREATE POLICY "zones_auth_delete"
  ON zones FOR DELETE USING (auth.role() = 'authenticated');

-- rides: 본인 기록만 읽기/쓰기
ALTER TABLE rides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rides_own_select"
  ON rides FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "rides_own_insert"
  ON rides FOR INSERT WITH CHECK (auth.uid() = user_id);

-- reports: 누구나 읽기 / 로그인한 사용자만 신고 가능
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reports_public_read"
  ON reports FOR SELECT USING (true);

CREATE POLICY "reports_auth_insert"
  ON reports FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- ============================================================
-- 기존 데이터 마이그레이션 (zones.json → Supabase)
-- ============================================================

INSERT INTO zones (id, lat, lng, title, type, desc, severity, report_count, created_at)
VALUES
  ('zone-001', 37.5285, 126.9360, 'Sharp Turn',       'sharp_turn',  'Steep downhill with sharp curve. Reduce speed below 15 km/h.', 'high',   12, '2026-05-01T00:00:00Z'),
  ('zone-002', 37.5245, 126.9310, 'Wet Surface',       'wet_road',    'Often wet after rain. Low traction zone. Brake early.',         'medium',  7, '2026-05-03T00:00:00Z'),
  ('zone-003', 37.5265, 126.9430, 'Blind Spot',        'blind_spot',  'Pedestrian crossing with limited visibility. Ring your bell.',  'medium',  5, '2026-05-10T00:00:00Z'),
  ('zone-004', 37.5310, 126.9390, 'Road Construction', 'construction','Active construction. Narrow path, debris possible.',            'high',   20, '2026-05-15T00:00:00Z'),
  ('zone-005', 37.5220, 126.9450, 'Steep Descent',     'steep',       '8% gradient for 300m. Use brakes carefully.',                  'low',     3, '2026-05-20T00:00:00Z'),
  ('zone-556b0277', 37.5200, 126.9300, 'Road Construction', 'construction', '', 'medium', 1, '2026-06-04T04:47:48.781Z'),
  ('zone-9be30c04', 37.55793, 127.00937, 'Wet Surface', 'wet_road',   '', 'medium', 1, '2026-06-04T05:13:54.341Z')
ON CONFLICT (id) DO NOTHING;
