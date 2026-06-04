// ═══════════════════════════════════════════════════════════════════════════
// SmartRider — app.js  (Step 1: Backend-connected foundation)
// ═══════════════════════════════════════════════════════════════════════════

// ── Map init ────────────────────────────────────────────────────────────────
const DEFAULT_CENTER = [37.5265, 126.9390];
const map = L.map('map', { zoomControl: false, attributionControl: false })
             .setView(DEFAULT_CENTER, 14);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);

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
    document.getElementById('danger-count-text').textContent = `${allZones.length} Danger Zones Nearby`;
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

// ═══════════════════════════════════════════════════════════════════════════
// GPS Module — Step 2: Real GPS + accuracy circle + simulation mode
// ═══════════════════════════════════════════════════════════════════════════
const GPS = {
  watchId:       null,
  lastPos:       null,
  active:        false,
  accuracyCircle: null,
  speedBuffer:   [],     // rolling window for speed smoothing
  simInterval:   null,
  simIdx:        0,

  // Demo route coords for simulation (when real GPS unavailable)
  simRoute: [
    [37.5200,126.9300],[37.5212,126.9315],[37.5224,126.9330],[37.5236,126.9345],
    [37.5248,126.9355],[37.5258,126.9368],[37.5265,126.9380],[37.5272,126.9395],
    [37.5282,126.9408],[37.5293,126.9422],[37.5302,126.9435],[37.5312,126.9448],
    [37.5320,126.9462],[37.5310,126.9390],[37.5295,126.9375],[37.5280,126.9360],
    [37.5265,126.9350],[37.5250,126.9340],[37.5236,126.9330]
  ],

  start() {
    this.active = true;
    this._setGpsUI('on');

    if (navigator.geolocation) {
      // Try real GPS first
      navigator.geolocation.getCurrentPosition(
        pos => {
          this.watchId = navigator.geolocation.watchPosition(
            p => this.onPosition(p),
            err => { this._startSim(); },
            { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 }
          );
        },
        () => this._startSim(),
        { enableHighAccuracy: true, timeout: 5000 }
      );
    } else {
      this._startSim();
    }
  },

  _startSim() {
    Toast.show('GPS unavailable — Demo mode 🎮');
    this._setGpsUI('sim');
    this.simIdx = 0;
    this.simInterval = setInterval(() => {
      const [lat, lng] = this.simRoute[this.simIdx % this.simRoute.length];
      const fakeSpeed  = Math.round(15 + Math.sin(this.simIdx * 0.5) * 6); // 9-21 km/h wave
      this._applyPosition(lat, lng, fakeSpeed, 10);
      this.simIdx++;
    }, 1500);
  },

  stop() {
    if (this.watchId !== null)  { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    if (this.simInterval !== null) { clearInterval(this.simInterval); this.simInterval = null; }
    if (this.accuracyCircle)    { this.accuracyCircle.remove(); this.accuracyCircle = null; }
    this.active  = false;
    this.lastPos = null;
    this.speedBuffer = [];
    this._setGpsUI('off');
  },

  onPosition(pos) {
    const { latitude: lat, longitude: lng, speed, accuracy } = pos.coords;
    const kmh = speed != null ? Math.round(speed * 3.6) : null;
    this._applyPosition(lat, lng, kmh, accuracy);
  },

  _applyPosition(lat, lng, rawKmh, accuracy) {
    riderMarker.setLatLng([lat, lng]);
    this.lastPos = { lat, lng };

    // Accuracy circle on map
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

    if (!Ride.active) return;

    map.panTo([lat, lng], { animate: true, duration: 0.5 });

    // Distance
    if (this._prevPos) {
      const d = haversine(this._prevPos.lat, this._prevPos.lng, lat, lng);
      if (d < 500) Ride.addDistance(d); // ignore GPS jumps > 500m
    }
    this._prevPos = { lat, lng };

    // Speed smoothing (rolling avg of last 4 readings)
    if (rawKmh != null) {
      this.speedBuffer.push(rawKmh);
      if (this.speedBuffer.length > 4) this.speedBuffer.shift();
      const smoothed = Math.round(this.speedBuffer.reduce((a,b)=>a+b,0) / this.speedBuffer.length);
      Ride.updateSpeed(smoothed);
      const limit = parseInt(Settings.get().speedLimit);
      if (limit > 0 && smoothed > limit) Alert.showSpeedWarning(smoothed, limit);
    }

    // Danger proximity check
    checkProximity(lat, lng);
  },

  _prevPos: null,

  onError(err) {
    console.warn('GPS error:', err.message);
    Toast.show('GPS signal lost. Retrying...');
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
    } else if (state === 'sim') {
      dot.className   = 'w-2 h-2 bg-yellow-400 rounded-full animate-pulse';
      label.textContent = 'DEMO';
      label.className = 'text-yellow-400 text-xs font-medium';
      badge.className = 'flex items-center gap-1.5 bg-yellow-500/20 border border-yellow-500/40 rounded-full px-3 py-1';
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

    GPS.start();
    this.timer = setInterval(() => this._tick(), 1000);
    startZonePolling();
    Toast.show('Ride started! Stay safe. 🚴');
  },

  async stop() {
    this.active = false;
    clearInterval(this.timer);
    GPS.stop();
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
    clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => this.dismiss(), 7000);
    if (Ride.active) Ride.passedZones.push(zone.id);
  },

  showSpeedWarning(speed, limit) {
    document.getElementById('alert-title').textContent = `🚨 Speed Warning!`;
    document.getElementById('alert-desc').textContent  = `You're going ${speed} km/h — limit is ${limit} km/h. Slow down!`;
    document.getElementById('alert-banner').classList.add('show');
    clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => this.dismiss(), 4000);
  },

  dismiss() {
    document.getElementById('alert-banner').classList.remove('show');
    currentAlertZone = null;
  },

  focusOnMap() {
    if (currentAlertZone) { map.flyTo([currentAlertZone.lat, currentAlertZone.lng], 17); this.dismiss(); }
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
      alertsEnabled:  document.getElementById('set-alerts').checked,
      alertDistance:  parseInt(document.getElementById('set-distance').value),
      speedLimit:     parseInt(document.getElementById('set-speed-limit').value),
      autoShare:      document.getElementById('set-share').checked
    };
    localStorage.setItem('smartrider_settings', JSON.stringify(s));
    Panels.closeAll();
    Toast.show('Settings saved ✓');
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
