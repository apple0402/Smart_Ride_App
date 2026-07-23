require('dotenv').config();
const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

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

// ── 정적 파일 서빙 (프론트엔드가 Supabase와 직접 통신) ──────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── 헬스체크 ──────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', time: new Date(), backend: 'supabase' })
);

// ── 역지오코딩 프록시 (마커 등록 시 한글 지번 주소 조회) ────────────────────────
app.use('/api/geocode', require('./routes/geocode'));

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Safe Ride server running at http://localhost:${PORT}`);
});
