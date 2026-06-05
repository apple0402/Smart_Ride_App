require('dotenv').config();
const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 정적 파일 서빙 (프론트엔드가 Supabase와 직접 통신) ──────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── 헬스체크 ──────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', time: new Date(), backend: 'supabase' })
);

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SmartRider server running at http://localhost:${PORT}`);
});
