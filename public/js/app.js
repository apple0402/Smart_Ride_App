// ═══════════════════════════════════════════════════════════════════════════
// SmartRider — app.js  (Step 1: Backend-connected foundation)
// ═══════════════════════════════════════════════════════════════════════════

// ── Map init ────────────────────────────────────────────────────────────────
const DEFAULT_CENTER = [37.5265, 126.9390];
const map = L.map('map', { zoomControl: false, attributionControl: false })
             .setView(DEFAULT_CENTER, 14);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);

// ── 현재 위치 버튼 (우상단 줌 컨트롤 아래) ────────────────────────────────
const LocateControl = L.Control.extend({
  onAdd() {
    const btn = L.DomUtil.create('button');
    btn.title = '현재 위치로 이동';
    btn.style.cssText = [
      'width:34px','height:34px','margin-top:8px',
      'background:rgba(15,23,42,0.92)','border:1px solid #475569',
      'border-radius:8px','display:flex','align-items:center',
      'justify-content:center','cursor:pointer','box-shadow:0 2px 8px rgba(0,0,0,0.4)'
    ].join(';');
    btn.innerHTML = `<svg width="18" height="18" fill="none" stroke="#94a3b8" stroke-width="2" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" fill="#94a3b8"/>
      <path stroke-linecap="round" d="M12 2v4M12 18v4M2 12h4M18 12h4"/>
      <circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>
    </svg>`;
    L.DomEvent.disableClickPropagation(btn);
    btn.addEventListener('click', () => GPS.locateMe());
    return btn;
  }
});
new LocateControl({ position: 'topright' }).addTo(map);

// ── Rider marker ─────────────────────────────────────────────────────────────
const riderIcon = L.divIcon({
  className: '',
  html: `<div style="width:20px;height:20px;background:#22c55e;border:3px solid white;border-radius:50%;box-shadow:0 0 0 4px rgba(34,197,94,0.3)"></div>`,
  iconSize: [20, 20], iconAnchor: [10, 10]
});
let riderMarker = L.marker(DEFAULT_CENTER, { icon: riderIcon, zIndexOffset: 1000 }).addTo(map);

// ── Zone marker layer ────────────────────────────────────────────────────────
const zoneLayer   = L.layerGroup().addTo(map);
const reportLayer = L.layerGroup().addTo(map);

const ZONE_ICONS   = { sharp_turn:'↩️', wet_road:'💧', blind_spot:'👁️', construction:'🚧', steep:'⛰️', debris:'🪨', pothole:'🕳️', general:'⚠️' };
const SEV_COLORS   = { high:'#ef4444', medium:'#f97316', low:'#eab308' };
const SEV_RADIUS   = { high: 80, medium: 60, low: 40 };

let allZones = [];
let alertedZones = new Set();
let currentAlertZone = null;

// ── Load zones from backend ──────────────────────────────────────────────────
let zonesPollInterval = null;

async function loadZones() {
  try {
    const fresh = await API.getZones();

    // Detect newly added zones and highlight them
    const existingIds = new Set(allZones.map(z => z.id));
    const newZones    = fresh.filter(z => !existingIds.has(z.id));

    allZones = fresh;
    renderZones(allZones);
    updateNearbyCount();
    renderZoneList();

    if (newZones.length) {
      Toast.show(`${newZones.length} new danger zone(s) added to map`);
    }
  } catch (e) {
    document.getElementById('danger-count-text').textContent = 'Could not load zones';
  }
}

// Poll backend every 30s for new zones (community reports appear in real time)
function startZonePolling() {
  if (zonesPollInterval) return;
  zonesPollInterval = setInterval(loadZones, 30000);
}

function stopZonePolling() {
  clearInterval(zonesPollInterval);
  zonesPollInterval = null;
}

function renderZones(zones) {
  zoneLayer.clearLayers();
  zones.forEach(z => {
    const color  = SEV_COLORS[z.severity] || '#f97316';
    const radius = SEV_RADIUS[z.severity] || 60;
    L.circle([z.lat, z.lng], { radius, color, fillColor: color, fillOpacity: 0.2, weight: 2 }).addTo(zoneLayer);
    const icon = L.divIcon({
      className: '',
      html: `<div style="background:${color};border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.5)">${ZONE_ICONS[z.type]||'⚠️'}</div>`,
      iconSize: [32, 32], iconAnchor: [16, 16]
    });
    L.marker([z.lat, z.lng], { icon }).addTo(zoneLayer)
     .bindPopup(`<div style="font-weight:bold;margin-bottom:4px">${z.title}</div><div style="font-size:12px;color:#94a3b8">${z.desc}</div><div style="font-size:11px;color:#64748b;margin-top:4px">Reports: ${z.reportCount || 1}</div>`);
  });
}

function renderZoneList() {
  const el = document.getElementById('zone-list-items');
  if (!allZones.length) { el.innerHTML = '<div class="text-slate-500 text-sm text-center py-4">No zones loaded</div>'; return; }
  el.innerHTML = allZones.map(z => {
    const c = z.severity==='high' ? 'text-red-400 bg-red-500/10 border-red-500/30'
            : z.severity==='medium' ? 'text-orange-400 bg-orange-500/10 border-orange-500/30'
            : 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30';
    return `<div class="flex items-start gap-3 p-3 rounded-xl border ${c} cursor-pointer" onclick="focusZone(${z.lat},${z.lng})">
      <span class="text-xl">${ZONE_ICONS[z.type]||'⚠️'}</span>
      <div class="flex-1">
        <div class="font-semibold text-sm text-white">${z.title}</div>
        <div class="text-xs text-slate-400 mt-0.5">${z.desc}</div>
      </div>
      <span class="text-xs font-medium capitalize px-2 py-0.5 rounded-full border ${c} flex-shrink-0">${z.severity}</span>
    </div>`;
  }).join('');
}

function focusZone(lat, lng) {
  map.flyTo([lat, lng], 17, { duration: 0.8 });
  Panels.closeAll();
}

// ── Proximity check ───────────────────────────────────────────────────────────
function checkProximity(lat, lng) {
  const alertDist = Settings.get().alertDistance;
  allZones.forEach(z => {
    if (alertedZones.has(z.id)) return;
    const d = haversine(lat, lng, z.lat, z.lng);
    if (d <= alertDist) {
      alertedZones.add(z.id);
      currentAlertZone = z;
      Alert.show(z);
      setTimeout(() => alertedZones.delete(z.id), 60000); // re-alert after 60s
    }
  });
}

// ── Haversine ─────────────────────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── 주변 위험구역 카운트 업데이트 (반경 500m) ──────────────────────────────
function updateNearbyCount() {
  const NEARBY_RADIUS = 500;
  const pos = GPS.lastPos;
  const el = document.getElementById('danger-count-text');
  if (!pos) {
    el.textContent = allZones.length ? `${allZones.length} Danger Zones` : 'No Zones';
    return;
  }
  const count = allZones.filter(z => haversine(pos.lat, pos.lng, z.lat, z.lng) <= NEARBY_RADIUS).length;
  el.textContent = `${count} Danger Zones Nearby`;
}

// ── 경고음 (Web Audio API, 3회 비프) ───────────────────────────────────────
function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.3, 0.6].forEach(delay => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0, ctx.currentTime + delay);
      gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + delay + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.25);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.3);
    });
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// GPS Module — Step 2: Real GPS + accuracy circle + simulation mode
// ═══════════════════════════════════════════════════════════════════════════
const GPS = {
  watchId:        null,
  lastPos:        null,
  active:         false,
  accuracyCircle: null,
  speedBuffer:    [],
  _gpsLocked:     false,
  _hasPanned:     false,
  _prevPos:       null,

  // 앱 시작 시 자동 위치 추적 시작 (라이딩과 무관)
  startTracking() {
    if (this.active) return;
    this.active     = true;
    this._gpsLocked = false;
    this._hasPanned = false;

    if (!navigator.geolocation) {
      this.active = false;
      this._setGpsUI('off');
      Toast.show('이 브라우저는 GPS를 지원하지 않거나 보안 연결(HTTPS)이 필요합니다.');
      return;
    }

    this._setGpsUI('acquiring');
    this.watchId = navigator.geolocation.watchPosition(
      pos => {
        if (!this._gpsLocked) {
          this._gpsLocked = true;
          this._setGpsUI('on');
          Toast.show('GPS 연결됨 ✓');
        }
        this.onPosition(pos);
      },
      err => {
        this._setGpsUI('off');
        this.active = false;
        if (this.watchId !== null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
        if (err.code === 1) {
          Toast.show('위치 권한 없음 — 기기 설정에서 위치 권한을 허용하거나 Demo Mode를 켜세요');
        } else if (err.code === 2) {
          Toast.show('위치 신호 없음 — 5초 후 재시도합니다');
          setTimeout(() => this.startTracking(), 5000);
        } else if (err.code === 3) {
          Toast.show('위치 조회 시간 초과 — 재시도 중...');
          setTimeout(() => this.startTracking(), 3000);
        } else {
          Toast.show(`GPS 오류 (${err.message || '알 수 없음'}) — Demo Mode를 켜보세요`);
        }
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
    );
  },

  // 위치 추적 완전 정지
  stopTracking() {
    if (this.watchId !== null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    if (this.accuracyCircle)   { this.accuracyCircle.remove(); this.accuracyCircle = null; }
    this.active      = false;
    this.lastPos     = null;
    this.speedBuffer = [];
    this._gpsLocked  = false;
    this._hasPanned  = false;
    this._prevPos    = null;
    this._setGpsUI('off');
  },

  // 현재 위치로 지도 이동 (GPS 꺼져 있으면 재시작)
  locateMe() {
    if (this.lastPos) {
      map.panTo([this.lastPos.lat, this.lastPos.lng], { animate: true, duration: 0.5 });
    } else if (!this.active) {
      Toast.show('GPS 재시작 중...');
      this.startTracking();
    } else {
      Toast.show('위치 신호를 기다리는 중입니다...');
    }
  },

  onPosition(pos) {
    const { latitude: lat, longitude: lng, speed, accuracy } = pos.coords;
    const kmh = speed != null ? Math.round(speed * 3.6) : null;
    this._applyPosition(lat, lng, kmh, accuracy);
  },

  _applyPosition(lat, lng, rawKmh, accuracy) {
    riderMarker.setLatLng([lat, lng]);
    this.lastPos = { lat, lng };
    updateNearbyCount();

    // Accuracy circle
    if (accuracy != null && accuracy < 200) {
      if (!this.accuracyCircle) {
        this.accuracyCircle = L.circle([lat, lng], {
          radius: accuracy, color:'#3b82f6', fillColor:'#3b82f6',
          fillOpacity: 0.08, weight: 1, dashArray: '4'
        }).addTo(map);
      } else {
        this.accuracyCircle.setLatLng([lat, lng]);
        this.accuracyCircle.setRadius(accuracy);
      }
    }

    // 지도 항상 따라가기: 첫 fix 또는 라이딩 중
    if (!this._hasPanned || Ride.active) {
      this._hasPanned = true;
      map.panTo([lat, lng], { animate: true, duration: 0.3 });
    }

    if (!Ride.active) return;

    // Distance
    if (this._prevPos) {
      const d = haversine(this._prevPos.lat, this._prevPos.lng, lat, lng);
      if (d < 500) Ride.addDistance(d);
    }
    this._prevPos = { lat, lng };

    // Speed smoothing
    if (rawKmh != null) {
      this.speedBuffer.push(rawKmh);
      if (this.speedBuffer.length > 4) this.speedBuffer.shift();
      const smoothed = Math.round(this.speedBuffer.reduce((a,b)=>a+b,0) / this.speedBuffer.length);
      Ride.updateSpeed(smoothed);
      const limit = parseInt(Settings.get().speedLimit);
      if (limit > 0 && smoothed > limit) Alert.showSpeedWarning(smoothed, limit);
    }

    checkProximity(lat, lng);
  },

  _setGpsUI(state) {
    const dot   = document.getElementById('gps-dot');
    const label = document.getElementById('gps-label');
    const badge = document.getElementById('gps-badge');
    if (state === 'on') {
      dot.className   = 'w-2 h-2 bg-green-400 rounded-full animate-pulse';
      label.textContent = 'GPS ON';
      label.className = 'text-green-400 text-xs font-medium';
      badge.className = 'flex items-center gap-1.5 bg-green-500/20 border border-green-500/40 rounded-full px-3 py-1';
    } else if (state === 'acquiring') {
      dot.className   = 'w-2 h-2 bg-blue-400 rounded-full animate-ping';
      label.textContent = 'Searching...';
      label.className = 'text-blue-400 text-xs font-medium';
      badge.className = 'flex items-center gap-1.5 bg-blue-500/20 border border-blue-500/40 rounded-full px-3 py-1';
    } else {
      dot.className   = 'w-2 h-2 bg-slate-400 rounded-full';
      label.textContent = 'GPS';
      label.className = 'text-slate-400 text-xs font-medium';
      badge.className = 'flex items-center gap-1.5 bg-slate-700/80 border border-slate-600 rounded-full px-3 py-1';
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Ride Module
// ═══════════════════════════════════════════════════════════════════════════
const Ride = {
  active: false,
  elapsed: 0,
  distance: 0,
  speedHistory: [],
  maxSpeed: 0,
  passedZones: [],
  routeCoords: [],
  timer: null,

  toggle() {
    this.active ? this.stop() : this.start();
  },

  start() {
    this.active = true;
    this.elapsed = 0; this.distance = 0; this.speedHistory = []; this.maxSpeed = 0;
    this.passedZones = []; this.routeCoords = [];
    alertedZones.clear();

    const btn = document.getElementById('ride-btn');
    btn.textContent = 'Stop Ride';
    btn.classList.replace('bg-green-500','bg-red-500');
    btn.classList.replace('hover:bg-green-400','hover:bg-red-400');

    // GPS는 앱 시작 시 이미 추적 중 — 없으면 재시작
    if (!GPS.active) GPS.startTracking();
    GPS._prevPos = null; // 거리 계산 초기화

    this.timer = setInterval(() => this._tick(), 1000);
    startZonePolling();
    Toast.show('라이딩 시작! 안전하게 달려요 🚴');
  },

  async stop() {
    this.active = false;
    clearInterval(this.timer);
    // GPS 추적은 계속 유지 (위치 표시용)
    stopZonePolling();

    const btn = document.getElementById('ride-btn');
    btn.textContent = 'Start Ride';
    btn.classList.replace('bg-red-500','bg-green-500');
    btn.classList.replace('hover:bg-red-400','hover:bg-green-400');

    document.getElementById('speed-val').textContent = '0';

    // Save ride to backend
    if (this.elapsed > 5) {
      const avg = this.speedHistory.length ? Math.round(this.speedHistory.reduce((a,b)=>a+b,0)/this.speedHistory.length) : 0;
      try {
        await API.saveRide({
          distance: this.distance / 1000,
          duration: this.elapsed,
          avgSpeed: avg,
          maxSpeed: this.maxSpeed,
          dangerZonesPassed: this.passedZones,
          route: this.routeCoords.slice(0, 200)
        });
        Toast.show(`Ride saved! ${(this.distance/1000).toFixed(2)} km`);
      } catch (e) {
        Toast.show('Could not save ride.');
      }
    }
  },

  _tick() {
    this.elapsed++;
    const m = Math.floor(this.elapsed/60).toString().padStart(2,'0');
    const s = (this.elapsed%60).toString().padStart(2,'0');
    document.getElementById('time-val').textContent = `${m}:${s}`;
  },

  addDistance(meters) {
    this.distance += meters;
    document.getElementById('dist-val').textContent = (this.distance/1000).toFixed(2);
  },

  updateSpeed(kmh) {
    this.speedHistory.push(kmh);
    if (kmh > this.maxSpeed) this.maxSpeed = kmh;
    document.getElementById('speed-val').textContent = kmh;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Alert Module
// ═══════════════════════════════════════════════════════════════════════════
let alertTimeout;
const Alert = {
  show(zone) {
    if (!Settings.get().alertsEnabled) return;
    document.getElementById('alert-title').textContent = `⚠️ ${zone.title} Ahead!`;
    document.getElementById('alert-desc').textContent  = zone.desc;
    document.getElementById('alert-banner').classList.add('show');
    document.getElementById('alert-clear-btn').classList.remove('hidden');
    clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => this.dismiss(), 7000);
    if (Ride.active) Ride.passedZones.push(zone.id);
    playAlertSound();
    if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
  },

  showSpeedWarning(speed, limit) {
    document.getElementById('alert-title').textContent = `🚨 Speed Warning!`;
    document.getElementById('alert-desc').textContent  = `You're going ${speed} km/h — limit is ${limit} km/h. Slow down!`;
    document.getElementById('alert-banner').classList.add('show');
    document.getElementById('alert-clear-btn').classList.add('hidden');
    clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => this.dismiss(), 4000);
    if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]);
  },

  dismiss() {
    document.getElementById('alert-banner').classList.remove('show');
    document.getElementById('alert-clear-btn').classList.add('hidden');
    currentAlertZone = null;
  },

  focusOnMap() {
    if (currentAlertZone) { map.flyTo([currentAlertZone.lat, currentAlertZone.lng], 17); this.dismiss(); }
  },

  requestClear() {
    if (currentAlertZone) ClearZone.show(currentAlertZone);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ClearZone Module — 위험구역 해제 신청
// ═══════════════════════════════════════════════════════════════════════════
const ClearZone = {
  targetZone: null,

  show(zone) {
    this.targetZone = zone;
    document.getElementById('clear-zone-name').textContent = `"${zone.title}" 구역`;
    document.getElementById('clear-zone-modal').classList.remove('hidden');
  },

  cancel() {
    document.getElementById('clear-zone-modal').classList.add('hidden');
    this.targetZone = null;
  },

  async confirm() {
    if (!this.targetZone) return;
    const zoneId = this.targetZone.id;
    this.cancel();
    try {
      await API.clearZone(zoneId);
      allZones = allZones.filter(z => z.id !== zoneId);
      alertedZones.delete(zoneId);
      renderZones(allZones);
      renderZoneList();
      updateNearbyCount();
      Toast.show('위험 구역 해제 신청 완료 ✓ 감사합니다!');
    } catch(e) {
      Toast.show('해제 신청 중 오류가 발생했습니다');
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Report Module
// ═══════════════════════════════════════════════════════════════════════════
const Report = {
  selectedType: null,
  selectedSev: 'medium',

  async submit() {
    if (!this.selectedType) { Toast.show('Please select a hazard type'); return; }
    const pos = GPS.lastPos || { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] };
    const desc = document.getElementById('report-desc').value.trim();

    try {
      const result = await API.reportHazard({
        lat: pos.lat, lng: pos.lng,
        type: this.selectedType,
        severity: this.selectedSev,
        desc
      });

      // Add new zone to map if created
      if (result.action === 'created') {
        allZones.push(result.zone);
        renderZones(allZones);
        renderZoneList();
        document.getElementById('danger-count-text').textContent = `${allZones.length} Danger Zones Nearby`;
      } else {
        // update reportCount
        const z = allZones.find(z => z.id === result.zone.id);
        if (z) { z.reportCount = result.zone.reportCount; renderZones(allZones); }
      }

      // Show dot on map for report
      const rIcon = L.divIcon({
        className:'',
        html:`<div style="background:#f97316;border-radius:50%;width:18px;height:18px;border:2px solid white;opacity:0.9"></div>`,
        iconSize:[18,18], iconAnchor:[9,9]
      });
      L.marker([pos.lat, pos.lng], { icon: rIcon }).addTo(reportLayer)
       .bindPopup(`<div style="font-size:12px;color:#94a3b8">Your report: ${result.zone.title}</div>`);

      Panels.closeAll();
      Toast.show('Report submitted! Thank you 🙏');
      document.getElementById('report-desc').value = '';
      this.selectedType = null; this.selectedSev = 'medium';
      document.querySelectorAll('#report-type-grid .type-btn').forEach(b => b.classList.remove('selected'));
      document.querySelectorAll('#report-severity-grid .type-btn').forEach(b => { b.classList.toggle('selected', b.dataset.sev === 'medium'); });
    } catch (e) {
      Toast.show('Failed to submit. Check connection.');
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Settings Module
// ═══════════════════════════════════════════════════════════════════════════
const Settings = {
  defaults: { alertsEnabled: true, alertDistance: 200, speedLimit: 25, autoShare: false },

  get() {
    try { return { ...this.defaults, ...JSON.parse(localStorage.getItem('smartrider_settings') || '{}') }; }
    catch { return this.defaults; }
  },

  load() {
    const s = this.get();
    document.getElementById('set-alerts').checked = s.alertsEnabled;
    document.getElementById('set-distance').value = s.alertDistance;
    document.getElementById('set-speed-limit').value = s.speedLimit;
    document.getElementById('set-share').checked = s.autoShare;
  },

  save() {
    const s = {
      alertsEnabled: document.getElementById('set-alerts').checked,
      alertDistance: parseInt(document.getElementById('set-distance').value),
      speedLimit:    parseInt(document.getElementById('set-speed-limit').value),
      autoShare:     document.getElementById('set-share').checked
    };
    localStorage.setItem('smartrider_settings', JSON.stringify(s));
    Panels.closeAll();
    Toast.show('설정 저장됨 ✓');
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Panels Module
// ═══════════════════════════════════════════════════════════════════════════
const Panels = {
  _open(id) {
    this.closeAll();
    document.getElementById(id).classList.add('open');
    document.getElementById('panel-overlay').classList.add('open');
  },
  closeAll() {
    ['zone-list-panel','report-panel','settings-panel','history-panel','auth-panel'].forEach(id => {
      document.getElementById(id).classList.remove('open');
    });
    document.getElementById('panel-overlay').classList.remove('open');
  },
  openZoneList()  { this._open('zone-list-panel'); },
  openReport()    {
    // show current location in report panel
    const pos = GPS.lastPos;
    document.getElementById('report-location-text').textContent =
      pos ? `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : 'Current location will be used';
    this._open('report-panel');
  },
  openSettings()  { Settings.load(); this._open('settings-panel'); },
  openHistory()   { History.load(); this._open('history-panel'); }
};

// ═══════════════════════════════════════════════════════════════════════════
// History Module
// ═══════════════════════════════════════════════════════════════════════════
const History = {
  async load() {
    const el = document.getElementById('history-list');
    el.innerHTML = '<div class="text-slate-500 text-sm text-center py-4">Loading...</div>';
    try {
      const rides = await API.getRides();
      if (!rides.length) {
        el.innerHTML = '<div class="text-slate-500 text-sm text-center py-8">No rides yet.<br>Start your first ride!</div>';
        return;
      }
      el.innerHTML = rides.map(r => {
        const date = new Date(r.createdAt).toLocaleDateString('ko-KR', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        const dur  = `${Math.floor(r.duration/60)}m ${r.duration%60}s`;
        return `<div class="ride-card">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-slate-400">${date}</span>
            <span class="text-xs bg-slate-700 px-2 py-0.5 rounded-full">${r.dangerZonesPassed?.length || 0} zones passed</span>
          </div>
          <div class="grid grid-cols-3 gap-2 text-center">
            <div><div class="text-lg font-black text-blue-400">${parseFloat(r.distance).toFixed(2)}</div><div class="text-xs text-slate-500">km</div></div>
            <div><div class="text-lg font-black text-purple-400">${dur}</div><div class="text-xs text-slate-500">time</div></div>
            <div><div class="text-lg font-black text-green-400">${r.avgSpeed}</div><div class="text-xs text-slate-500">avg km/h</div></div>
          </div>
        </div>`;
      }).join('');
    } catch (e) {
      el.innerHTML = '<div class="text-red-400 text-sm text-center py-4">Could not load history</div>';
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Toast Module
// ═══════════════════════════════════════════════════════════════════════════
let toastTimer;
const Toast = {
  show(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Event Wiring
// ═══════════════════════════════════════════════════════════════════════════

// Report type buttons
document.querySelectorAll('#report-type-grid .type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#report-type-grid .type-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    Report.selectedType = btn.dataset.type;
  });
});

// Severity buttons
document.querySelectorAll('#report-severity-grid .type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#report-severity-grid .type-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    Report.selectedSev = btn.dataset.sev;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Auth Module — Step 7
// ═══════════════════════════════════════════════════════════════════════════
const Auth = {
  user: null,

  init() {
    const token = localStorage.getItem('sr_token');
    if (!token) return;
    API.getMe(token).then(u => {
      if (u.id) { this.user = u; this._updateUI(); }
      else localStorage.removeItem('sr_token');
    }).catch(() => {});
  },

  openPanel() {
    if (this.user) { this._showProfile(); return; }
    Panels._open('auth-panel');
  },

  switchTab(tab) {
    const isLogin = tab === 'login';
    document.getElementById('form-login').classList.toggle('hidden', !isLogin);
    document.getElementById('form-signup').classList.toggle('hidden', isLogin);
    document.getElementById('tab-login').className  = `flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${isLogin  ? 'bg-slate-700 text-white' : 'text-slate-400'}`;
    document.getElementById('tab-signup').className = `flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${!isLogin ? 'bg-slate-700 text-white' : 'text-slate-400'}`;
  },

  async login() {
    const email = document.getElementById('login-email').value.trim();
    const pw    = document.getElementById('login-pw').value;
    if (!email || !pw) { Toast.show('Please fill in all fields'); return; }
    try {
      const res = await API.login(email, pw);
      if (res.error) { Toast.show(res.error); return; }
      this._onSuccess(res);
    } catch { Toast.show('Connection error'); }
  },

  async signup() {
    const name  = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const pw    = document.getElementById('signup-pw').value;
    if (!name || !email || !pw) { Toast.show('Please fill in all fields'); return; }
    if (pw.length < 6) { Toast.show('Password must be at least 6 characters'); return; }
    try {
      const res = await API.signup(email, pw, name);
      if (res.error) { Toast.show(res.error); return; }
      this._onSuccess(res);
    } catch { Toast.show('Connection error'); }
  },

  _onSuccess(res) {
    this.user = res;
    localStorage.setItem('sr_token', res.token);
    this._updateUI();
    Panels.closeAll();
    Toast.show(`Welcome, ${res.name}! 🚴`);
  },

  logout() {
    this.user = null;
    localStorage.removeItem('sr_token');
    this._updateUI();
    Toast.show('Logged out');
  },

  _updateUI() {
    const btn = document.getElementById('auth-btn');
    if (this.user) {
      btn.innerHTML = `<div class="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center text-xs font-bold text-white">${this.user.name[0].toUpperCase()}</div>`;
    } else {
      btn.innerHTML = `<svg class="w-4 h-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>`;
    }
  },

  _showProfile() {
    const u = this.user;
    if (confirm(`Logged in as:\n${u.name} (${u.email})\n\nLog out?`)) this.logout();
  }
};

// ── Init ─────────────────────────────────────────────────────────────────────
loadZones();
Settings.load();
Auth.init();
GPS.startTracking(); // 앱 시작 시 자동으로 현재 위치 추적 시작
