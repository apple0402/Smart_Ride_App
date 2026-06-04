const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, '../data/rides.json');

function read()       { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function write(data)  { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

// GET /api/rides — 라이딩 기록 목록
router.get('/', (req, res) => {
  res.json(read());
});

// POST /api/rides — 라이딩 기록 저장
router.post('/', (req, res) => {
  const { distance, duration, avgSpeed, maxSpeed, dangerZonesPassed, route } = req.body;

  const ride = {
    id: `ride-${uuidv4().slice(0, 8)}`,
    distance: parseFloat(distance) || 0,
    duration: parseInt(duration) || 0,
    avgSpeed: parseFloat(avgSpeed) || 0,
    maxSpeed: parseFloat(maxSpeed) || 0,
    dangerZonesPassed: dangerZonesPassed || [],
    route: route || [],
    createdAt: new Date().toISOString()
  };

  const rides = read();
  rides.unshift(ride);
  write(rides);
  res.status(201).json(ride);
});

module.exports = router;
