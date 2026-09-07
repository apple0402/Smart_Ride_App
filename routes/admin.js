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

// 알 수 없는 /admin/api/* 는 SPA fallback(index.html)로 새지 않게 여기서 끊는다.
router.use('/api', (req, res) => res.status(404).json({ error: '알 수 없는 관리자 API 경로입니다.' }));

module.exports = { adminGuard, adminRouter: router };
