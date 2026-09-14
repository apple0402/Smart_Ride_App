// 위경도를 한글 지번 주소로 변환하는 Nominatim 역지오코딩 서버 프록시
const express = require('express');
const router = express.Router();

// 좌표 → 한글 주소. 결과가 없으면 '' 를 반환하고, 네트워크 실패는 throw 한다.
// 관리자 주소 복원(routes/admin.js)도 같은 형식을 쓰도록 이 함수를 공유한다.
async function reverseGeocode(lat, lng) {
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
  return parts.join(' ') || j.display_name || '';
}

// GET /api/geocode?lat=&lng= — 서버가 백그라운드에서 Nominatim 호출 후 지번 주소 반환
router.get('/', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng required' });

  try {
    res.json({ address: await reverseGeocode(lat, lng) });
  } catch (e) {
    res.status(502).json({ error: 'geocoding failed', address: '' });
  }
});

module.exports = router;
module.exports.reverseGeocode = reverseGeocode;
