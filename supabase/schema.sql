-- ═══════════════════════════════════════════════════════════════════════════
-- Safe Ride — 전체 스키마 (Supabase PostgreSQL)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 에이전트 시스템 (기존 유지) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    goal TEXT NOT NULL,
    priority_level INTEGER DEFAULT 5,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_memory (
    id SERIAL PRIMARY KEY,
    agent_id UUID REFERENCES agents(id),
    context TEXT NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    type VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tasks (
    id SERIAL PRIMARY KEY,
    agent_id UUID REFERENCES agents(id),
    task_description TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    priority INTEGER DEFAULT 1,
    due_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ── 위험 구역 테이블 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zones (
    id TEXT PRIMARY KEY,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    title VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'other',
    description TEXT DEFAULT '',
    severity VARCHAR(20) DEFAULT 'medium',
    report_count INTEGER DEFAULT 1,
    safe_votes INTEGER DEFAULT 0,
    safe_voter_ids TEXT[] DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── 신고 테이블 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    user_id UUID,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255),
    description TEXT DEFAULT '',
    severity VARCHAR(20) DEFAULT 'medium',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── 라이딩 기록 테이블 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rides (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL,
    distance DOUBLE PRECISION DEFAULT 0,
    duration INTEGER DEFAULT 0,
    avg_speed DOUBLE PRECISION DEFAULT 0,
    max_speed DOUBLE PRECISION DEFAULT 0,
    danger_zones_passed TEXT[] DEFAULT '{}',
    route JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── 사용자 프로필 테이블 (레벨/포인트 시스템) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name VARCHAR(255),
    safety_points INTEGER DEFAULT 0,
    total_reports INTEGER DEFAULT 0,
    total_distance DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── RLS 활성화 ────────────────────────────────────────────────────────────────
ALTER TABLE zones    ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE rides    ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- ── Zone 정책 (모두 읽기 가능, 인증된 사용자 쓰기) ─────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='zones' AND policyname='zones_select') THEN
    CREATE POLICY "zones_select" ON zones FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='zones' AND policyname='zones_insert') THEN
    CREATE POLICY "zones_insert" ON zones FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='zones' AND policyname='zones_update') THEN
    CREATE POLICY "zones_update" ON zones FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='zones' AND policyname='zones_delete') THEN
    CREATE POLICY "zones_delete" ON zones FOR DELETE USING (auth.uid() IS NOT NULL);
  END IF;
END $$;

-- ── Reports 정책 ────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='reports' AND policyname='reports_select') THEN
    CREATE POLICY "reports_select" ON reports FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='reports' AND policyname='reports_insert') THEN
    CREATE POLICY "reports_insert" ON reports FOR INSERT WITH CHECK (true);
  END IF;
END $$;

-- ── Rides 정책 ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rides' AND policyname='rides_select') THEN
    CREATE POLICY "rides_select" ON rides FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rides' AND policyname='rides_insert') THEN
    CREATE POLICY "rides_insert" ON rides FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- ── Profiles 정책 ──────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='profiles_select') THEN
    CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (auth.uid() = id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='profiles_insert') THEN
    CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='profiles_update') THEN
    CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);
  END IF;
END $$;

-- ── 긴급 SOS 로그 테이블 (B2G 관제 연동용) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS emergency_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    address TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE emergency_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='emergency_logs' AND policyname='emergency_logs_insert') THEN
    CREATE POLICY "emergency_logs_insert" ON emergency_logs FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='emergency_logs' AND policyname='emergency_logs_select') THEN
    CREATE POLICY "emergency_logs_select" ON emergency_logs FOR SELECT USING (auth.uid() = user_id OR auth.uid() IS NOT NULL);
  END IF;
END $$;

-- ── 기존 zones 테이블에 컬럼 추가 (마이그레이션용) ─────────────────────────────
-- 이미 zones 테이블이 존재하는 경우 아래 3줄을 Supabase SQL 에디터에서 직접 실행하세요:
-- ALTER TABLE zones ADD COLUMN IF NOT EXISTS safe_votes INTEGER DEFAULT 0;
-- ALTER TABLE zones ADD COLUMN IF NOT EXISTS safe_voter_ids TEXT[] DEFAULT '{}';
-- ALTER TABLE zones ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
