const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const REPORTS_FILE = path.join(__dirname, '../data/reports.json');
const ZONES_FILE   = path.join(__dirname, '../data/zones.json');

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// POST /api/reports — 위험 신고 제출
router.post('/', (req, res) => {
  const { lat, lng, type, desc, severity } = req.body;
  if (!lat || !lng || !type) return res.status(400).json({ error: 'lat, lng, type required' });

  const typeLabels = {
    wet_road: 'Wet Surface', sharp_turn: 'Sharp Turn', blind_spot: 'Blind Spot',
    construction: 'Road Construction', steep: 'Steep Descent',
    debris: 'Debris on Road', pothole: 'Pothole', general: 'Hazard'
  };

  const report = {
    id: `rpt-${uuidv4().slice(0, 8)}`,
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    type,
    title: typeLabels[type] || 'Hazard',
    desc: desc || '',
    severity: severity || 'medium',
    createdAt: new Date().toISOString()
  };

  // 신고 저장
  const reports = read(REPORTS_FILE);
  reports.push(report);
  write(REPORTS_FILE, reports);

  // 같은 위치(100m 이내) 기존 위험구간이 있으면 reportCount 증가, 없으면 신규 구간 추가
  const zones = read(ZONES_FILE);
  const nearby = zones.find(z => haversine(z.lat, z.lng, report.lat, report.lng) < 100);
  if (nearby) {
    nearby.reportCount = (nearby.reportCount || 0) + 1;
    write(ZONES_FILE, zones);
    return res.status(201).json({ report, zone: nearby, action: 'updated' });
  }

  const newZone = {
    id: `zone-${uuidv4().slice(0, 8)}`,
    lat: report.lat, lng: report.lng,
    title: report.title, type: report.type,
    desc: report.desc, severity: report.severity,
    reportCount: 1, createdAt: report.createdAt
  };
  zones.push(newZone);
  write(ZONES_FILE, zones);
  res.status(201).json({ report, zone: newZone, action: 'created' });
});

// GET /api/reports — 전체 신고 목록
router.get('/', (req, res) => {
  res.json(read(REPORTS_FILE));
});

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

module.exports = router;
