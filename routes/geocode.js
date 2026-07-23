// 위경도를 한글 지번 주소로 변환하는 Nominatim 역지오코딩 서버 프록시
const express = require('express');
const router = express.Router();

// GET /api/geocode?lat=&lng= — 서버가 백그라운드에서 Nominatim 호출 후 지번 주소 반환
router.get('/', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng required' });

  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=ko&zoom=18&addressdetails=1`,
      { headers: { 'User-Agent': 'SafeRideApp/1.0' } }
    );
    const j = await r.json();
    const addr = j.address || {};
    const parts = [
      addr.city || addr.state,
      addr.borough || addr.city_district || addr.county,
      addr.suburb || addr.neighbourhood || addr.quarter || addr.village,
      addr.house_number
    ].filter(Boolean);
    const address = parts.join(' ') || j.display_name || '';
    res.json({ address });
  } catch (e) {
    res.status(502).json({ error: 'geocoding failed', address: '' });
  }
});

module.exports = router;
