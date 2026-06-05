const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, '../data/zones.json');

function readZones() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeZones(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// GET /api/zones — 전체 위험구간 조회
router.get('/', (req, res) => {
  res.json(readZones());
});

// GET /api/zones/nearby — 반경 내 위험구간 조회 (?lat=&lng=&radius=500)
router.get('/nearby', (req, res) => {
  const { lat, lng, radius = 500 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng required' });

  const zones = readZones();
  const nearby = zones.filter(z => {
    const d = haversine(parseFloat(lat), parseFloat(lng), z.lat, z.lng);
    return d <= parseFloat(radius);
  });
  res.json(nearby);
});

// POST /api/zones — 위험구간 추가
router.post('/', (req, res) => {
  const { lat, lng, title, type, desc, severity } = req.body;
  if (!lat || !lng || !title) return res.status(400).json({ error: 'lat, lng, title required' });

  const zones = readZones();
  const newZone = {
    id: `zone-${uuidv4().slice(0, 8)}`,
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    title,
    type: type || 'general',
    desc: desc || '',
    severity: severity || 'medium',
    reportCount: 1,
    createdAt: new Date().toISOString()
  };
  zones.push(newZone);
  writeZones(zones);
  res.status(201).json(newZone);
});

// DELETE /api/zones/:id — 위험구간 해제
router.delete('/:id', (req, res) => {
  const zones = readZones();
  const idx = zones.findIndex(z => z.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Zone not found' });
  const [removed] = zones.splice(idx, 1);
  writeZones(zones);
  res.json({ success: true, id: removed.id });
});

// Haversine 거리 계산 (미터 단위)
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

module.exports = router;
