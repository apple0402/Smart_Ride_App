require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 정적 파일 루트 ────────────────────────────────────────────────────────────
// `npm run build` 로 만든 dist/public(압축 + console 제거)이 있으면 그걸 서빙하고,
// 없으면(로컬 개발) 원본 public/ 을 그대로 서빙한다.
const DIST_DIR = path.join(__dirname, 'dist', 'public');
const WEB_DIR  = fs.existsSync(DIST_DIR) ? DIST_DIR : path.join(__dirname, 'public');

// ── JS / HTML / SW 파일은 브라우저·프록시 캐시 완전 금지 ───────────────────────
app.use((req, res, next) => {
  const p = req.path;
  if (p.endsWith('.js') || p.endsWith('.html') || p === '/' || p === '/sw.js') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
  next();
});

// ── 관리자 상황실 (/admin) ────────────────────────────────────────────────────
// 가드는 반드시 express.static 앞에 둔다. 뒤에 두면 /admin.html 직접 접근으로 인증이 뚫린다.
const { adminGuard, adminRouter } = require('./routes/admin');
app.use(adminGuard);
app.get('/admin', (req, res) => res.sendFile(path.join(WEB_DIR, 'admin.html')));
app.use('/admin', adminRouter);

// ── 정적 파일 서빙 (프론트엔드가 Supabase와 직접 통신) ──────────────────────
app.use(express.static(WEB_DIR));

// ── 헬스체크 ──────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', time: new Date(), backend: 'supabase' })
);

// ── 역지오코딩 프록시 (마커 등록 시 한글 지번 주소 조회) ────────────────────────
app.use('/api/geocode', require('./routes/geocode'));

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Safe Ride server running at http://localhost:${PORT}`);
});
