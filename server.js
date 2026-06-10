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

// ── iOS 오디오 세션 유지용 무음 WAV 동적 생성 ────────────────────────────────
// HTML5 <audio loop> 로 이 파일을 재생하면 iOS가 앱을 '상시 오디오 플레이어'로
// 인식해 화면 잠금 후에도 GPS·JS 스레드를 슬립시키지 않음.
// 완전 무음(0) 대신 ±1 진폭 노이즈(-90dB) 를 주입 — iOS 무음 감지 차단용.
app.get('/assets/silent.wav', (req, res) => {
  const sampleRate = 8000;
  const seconds    = 3;
  const numSamples = sampleRate * seconds;
  const dataSize   = numSamples * 2;           // 16-bit mono
  const buf        = Buffer.alloc(44 + dataSize, 0);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1,  20);                   // PCM
  buf.writeUInt16LE(1,  22);                   // mono
  buf.writeUInt32LE(sampleRate,     24);
  buf.writeUInt32LE(sampleRate * 2, 28);       // byteRate
  buf.writeUInt16LE(2,  32);                   // blockAlign
  buf.writeUInt16LE(16, 34);                   // bitsPerSample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const v = Math.floor((Math.random() * 2 - 1) * 2); // ±2 / 32767 ≈ -84 dB
    buf.writeInt16LE(v, 44 + i * 2);
  }

  res.set('Content-Type',  'audio/wav');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buf);
});

// ── 한국어 TTS 프록시 — CORS 우회 + 서버사이드 캐싱 ─────────────────────────
// Google Translate TTS (비공식 API, 무료): 직접 호출 시 CORS 차단 → 서버 경유
// 클라이언트는 /api/tts?text=TEXT 로 요청 → 서버가 MP3 반환
// SW가 CacheStorage에 7일 캐시 → 오프라인에서도 음성 재생 가능
app.get('/api/tts', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 200).trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  const gtUrl = `https://translate.google.com/translate_tts?ie=UTF-8`
    + `&q=${encodeURIComponent(text)}&tl=ko&client=tw-ob&ttsspeed=0.85`;

  try {
    const upstream = await fetch(gtUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://translate.google.com/'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);

    const audio = await upstream.arrayBuffer();
    res.set('Content-Type',  'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=604800'); // 7일
    res.end(Buffer.from(audio));
  } catch (e) {
    console.error('[TTS proxy]', e.message);
    res.status(503).json({ error: 'TTS unavailable' });
  }
});

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
  console.log(`Safe Ride server running at http://localhost:${PORT}`);
});
