// 지도 관리자 상황실 — Basic Auth 가드 + zones 테이블 조회/수정/삭제를 서버가 대행하는 라우터
const express = require('express');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// ── service_role 클라이언트 (지연 생성) ───────────────────────────────────────
// 브라우저 anon 키로는 zones_delete RLS(auth.uid() IS NOT NULL)에 막혀 "에러 없이 0건 삭제"가
// 된다. 그래서 쓰기 작업은 전부 서버가 service_role로 대행한다. 이 키는 절대 응답에 싣지 않는다.
let _db = null;
function adminDb() {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

function requireDb(res) {
  const db = adminDb();
  if (!db) {
    res.status(503).json({
      error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 설정되지 않아 관리자 기능을 쓸 수 없습니다.'
    });
    return null;
  }
  return db;
}

// ── Basic Auth ────────────────────────────────────────────────────────────────
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function basicAuth(req, res, next) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;

  // 자격증명이 없으면 열어두지 않고 차단한다 (fail-closed).
  if (!user || !pass) {
    return res.status(503).type('text/plain; charset=utf-8')
      .send('ADMIN_USER / ADMIN_PASSWORD 환경변수가 설정되지 않았습니다.');
  }

  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep !== -1 &&
        safeEqual(decoded.slice(0, sep), user) &&
        safeEqual(decoded.slice(sep + 1), pass)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Safe Ride Admin", charset="UTF-8"');
  res.status(401).type('text/plain; charset=utf-8').send('관리자 인증이 필요합니다.');
}

// express.static이 라우트보다 먼저 돌기 때문에, /admin.html 직접 접근으로 인증이 우회된다.
// 이 가드를 static "앞에" 걸어 /admin, /admin.html, /admin/* 을 한 번에 막는다.
function adminGuard(req, res, next) {
  const p = req.path;
  if (p === '/admin' || p === '/admin.html' || p.startsWith('/admin/')) {
    return basicAuth(req, res, next);
  }
  next();
}

// ── 관리자 API ────────────────────────────────────────────────────────────────
router.use(express.json({ limit: '32kb' }));

const SEVERITIES = ['high', 'medium', 'low'];
const ZONE_COLUMNS = 'id, lat, lng, title, type, description, address, severity, report_count, status, created_at';

// GET /admin/api/zones — 전국 마커 전량
router.get('/api/zones', async (req, res) => {
  const db = requireDb(res);
  if (!db) return;

  const { data, error } = await db
    .from('zones')
    .select(ZONE_COLUMNS)
    .order('created_at', { ascending: false });

  if (error) return res.status(502).json({ error: error.message });
  res.json({ zones: data || [] });
});

// PATCH /admin/api/zones/:id — 제목 / 설명 / 위험도만 수정 허용
router.patch('/api/zones/:id', async (req, res) => {
  const db = requireDb(res);
  if (!db) return;

  const body  = req.body || {};
  const patch = {};

  if (typeof body.title === 'string') {
    const title = body.title.trim().slice(0, 255);
    if (!title) return res.status(400).json({ error: '제목은 비울 수 없습니다.' }); // title은 NOT NULL
    patch.title = title;
  }
  if (typeof body.description === 'string') patch.description = body.description.trim().slice(0, 2000);
  if (typeof body.severity === 'string') {
    if (!SEVERITIES.includes(body.severity)) return res.status(400).json({ error: '위험도 값이 올바르지 않습니다.' });
    patch.severity = body.severity;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: '수정할 항목이 없습니다.' });

  const { data, error } = await db
    .from('zones').update(patch).eq('id', req.params.id).select(ZONE_COLUMNS);

  if (error) return res.status(502).json({ error: error.message });
  if (!data || !data.length) return res.status(404).json({ error: '해당 마커를 찾을 수 없습니다.' });
  res.json({ zone: data[0] });
});

// DELETE /admin/api/zones/:id — 실제 행 삭제
router.delete('/api/zones/:id', async (req, res) => {
  const db = requireDb(res);
  if (!db) return;

  const { data, error } = await db
    .from('zones').delete().eq('id', req.params.id).select('id');

  if (error) return res.status(502).json({ error: error.message });
  if (!data || !data.length) return res.status(404).json({ error: '이미 삭제되었거나 존재하지 않는 마커입니다.' });
  res.json({ deleted: data[0].id });
});

// ── 과거 마커 주소 일괄 복원 ──────────────────────────────────────────────────
// 네이티브 앱의 geocode 상대 경로 버그로 address가 빈 채 저장된 행을 좌표로 채운다.
// Nominatim 정책(초당 1건)을 지키려고 1.1초 간격 — 100건이면 2분이 넘어 요청 하나로 기다릴 수 없으므로
// 백그라운드로 돌리고 진행률만 조회한다. 상태는 메모리에만 있어 서버 재시작 시 사라지지만,
// 빈 주소 행만 다시 골라 처리하므로 재실행하면 남은 건부터 이어진다.
const { reverseGeocode } = require('./geocode');
const REPAIR_DELAY_MS = 1100;
let repair = { running: false, total: 0, done: 0, filled: 0, failed: 0, startedAt: null, finishedAt: null };

async function runRepair(db, rows) {
  for (const z of rows) {
    try {
      const address = await reverseGeocode(z.lat, z.lng);
      if (!address) throw new Error('empty');
      const { error } = await db.from('zones').update({ address }).eq('id', z.id);
      if (error) throw error;
      repair.filled++;
    } catch (_) {
      repair.failed++;   // 한 건 실패로 전체를 멈추지 않는다 — 빈 주소로 남아 재실행 대상이 된다
    }
    repair.done++;
    await new Promise(r => setTimeout(r, REPAIR_DELAY_MS));
  }
  repair.running = false;
  repair.finishedAt = new Date().toISOString();
}

// GET /admin/api/repair — 진행률
router.get('/api/repair', (req, res) => res.json(repair));

// POST /admin/api/repair — 복원 시작 (202로 즉시 응답)
router.post('/api/repair', async (req, res) => {
  const db = requireDb(res);
  if (!db) return;
  if (repair.running) return res.status(409).json({ error: '이미 주소 복원이 진행 중입니다.' });

  repair = { running: true, total: 0, done: 0, filled: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null };

  const { data, error } = await db
    .from('zones').select('id, lat, lng').or('address.is.null,address.eq.');
  if (error) {
    repair.running = false;
    return res.status(502).json({ error: error.message });
  }

  // 좌표가 깨진 행은 역지오코딩할 수 없으니 제외한다 (Number(null)은 0이라 null을 따로 거른다)
  const validCoord = v => v !== null && v !== '' && Number.isFinite(Number(v));
  const rows = (data || []).filter(z => validCoord(z.lat) && validCoord(z.lng));
  repair.total = rows.length;
  if (!rows.length) {
    repair.running = false;
    repair.finishedAt = new Date().toISOString();
  }
  res.status(202).json(repair);
  if (rows.length) runRepair(db, rows);
});

// 알 수 없는 /admin/api/* 는 SPA fallback(index.html)로 새지 않게 여기서 끊는다.
router.use('/api', (req, res) => res.status(404).json({ error: '알 수 없는 관리자 API 경로입니다.' }));

module.exports = { adminGuard, adminRouter: router };
