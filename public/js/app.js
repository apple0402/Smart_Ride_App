// ═══════════════════════════════════════════════════════════════════════════
// Safe Ride — app.js
// ═══════════════════════════════════════════════════════════════════════════

// ── 상수 ─────────────────────────────────────────────────────────────────────
// 하드코딩 위치 완전 제거 — GPS 수신 전 지도 초기 뷰만을 위한 중립 좌표 (서울 시청)
const INITIAL_VIEW = [37.5665, 126.9780];

// ── Map 초기화 (leaflet-rotate 지원, 줌 컨트롤 제거) ─────────────────────────
const mapOptions = { zoomControl: false, attributionControl: false };
if (L.Map.prototype.setBearing) Object.assign(mapOptions, { rotate: true, bearing: 0 });
const map = L.map('map', mapOptions).setView(INITIAL_VIEW, 15);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
// 줌 버튼, 내 위치 버튼 모두 제거 — GPS 자동 추적으로 대체

// ── 라이더 마커 ────────────────────────────────────────────────────────────────
const riderIcon = L.divIcon({
  className: '',
  html: `<div style="width:22px;height:22px;background:#22c55e;border:3px solid white;border-radius:50%;box-shadow:0 0 0 5px rgba(34,197,94,0.35)"></div>`,
  iconSize: [22, 22], iconAnchor: [11, 11]
});
// GPS 수신 전에는 마커를 지도에 올리지 않음 — null 로 대기, onPosition 첫 호출 시 생성
let riderMarker = null;

// ── 레이어 그룹 ──────────────────────────────────────────────────────────────
const zoneLayer   = L.layerGroup().addTo(map);
const reportLayer = L.layerGroup().addTo(map);

// ── 위험 유형 아이콘 ──────────────────────────────────────────────────────────
const ZONE_ICONS = {
  pothole:      '🕳️',
  slippery:     '🧼',
  construction: '🚧',
  other:        '⚠️',
  wet_road: '💧', sharp_turn: '↩️', blind_spot: '👁️', steep: '⛰️', debris: '🪨', general: '⚠️'
};

const ZONE_KOREAN = {
  pothole:      '포트홀 / 크랙',
  slippery:     '맨홀 / 미끄러움',
  construction: '도로 / 보도 공사',
  other:        '기타 위험'
};

const ZONE_TTS = {
  pothole:      '도로 파손, 단차 충격 주의!!',
  slippery:     '맨홀 미끄럼 주의!!',
  construction: '공사 중!! 서행 하세요!!'
};

// ── 플랫폼 감지 ─────────────────────────────────────────────────────────────
const Platform = {
  isIOS:     /iPad|iPhone|iPod/.test(navigator.userAgent),
  isAndroid: /Android/.test(navigator.userAgent)
};

const SEV_COLORS  = { high: '#ef4444', medium: '#f97316', low: '#eab308' };
const SEV_RADIUS  = { high: 80, medium: 60, low: 40 };

let allZones          = [];
let alertedZones      = new Set();
let enteredZones      = new Map(); // zoneId -> entryTimestamp (진입 확정된 구역)
const EXIT_HYSTERESIS = 20;        // GPS 오차 보정 — 이탈은 alertDist + 20m 초과 시 확정
let currentAlertZone  = null;
let zonesPollInterval = null;
let _alertTimeout     = null;

// ── 주소 캐시 (Nominatim 역지오코딩) ─────────────────────────────────────────
const _addrCache = {};
async function getAddress(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (_addrCache[key]) return _addrCache[key];
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=ko&zoom=16`,
      { headers: { 'User-Agent': 'SafeRideApp/1.0' } }
    );
    const j = await r.json();
    const addr = j.address;
    const parts = [
      addr?.road || addr?.path || addr?.cycleway || addr?.footway,
      addr?.suburb || addr?.neighbourhood || addr?.quarter || addr?.village,
      addr?.city_district || addr?.district || addr?.county,
      addr?.city || addr?.town
    ].filter(Boolean);
    const result = parts.slice(0, 3).join(', ') || j.display_name?.split(',').slice(0, 3).join(',') || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    _addrCache[key] = result;
    return result;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

// ── HTML 이스케이프 (XSS 방지) ───────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 날짜 포맷 ─────────────────────────────────────────────────────────────────
function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// VoiceAlert — AudioContext 기반 TTS 음성 안내
//
// [iOS 잠금화면 speechSynthesis 완전 차단 문제 해결]
// 기존: window.speechSynthesis → iOS 화면 잠금 시 강제 정지
// 변경: /api/tts 서버 프록시로 MP3 프리페치 → AudioBuffer 디코딩 →
//       SilentAudioLoop의 AudioContext에서 직접 재생
//       ∴ 화면이 꺼져도 오디오 세션이 살아있으면 100% 재생 보장
//
// 재생 우선순위:
//   1순위: 디코딩된 AudioBuffer → AudioContext.createBufferSource (화면 꺼짐 OK)
//   2순위: raw ArrayBuffer 온디맨드 디코딩 (프리페치 실패 시)
//   3순위: window.speechSynthesis (화면 켜짐 + Android 폴백)
// ═══════════════════════════════════════════════════════════════════════════
const VoiceAlert = {
  // 위험 유형별 TTS 문구 (ZONE_TTS와 통합)
  MESSAGES: {
    pothole:      '도로 파손, 단차 충격 주의!!',
    slippery:     '맨홀 미끄럼 주의!!',
    construction: '공사 중!! 서행 하세요!!',
    other:        '위험 구역 주의하세요'
  },
  _raw:     {},   // type → ArrayBuffer (미디코딩 원본)
  _decoded: {},   // type → AudioBuffer (재생 준비 완료)

  getZoneMessage(zone) {
    if (zone.type === 'other') return zone.desc || zone.title || this.MESSAGES.other;
    return this.MESSAGES[zone.type] || `${ZONE_KOREAN[zone.type] || zone.title} 주의하세요`;
  },

  // 앱 시작 즉시 호출: AudioContext 없이도 raw MP3 데이터 프리페치
  async prefetch() {
    await Promise.allSettled(
      Object.entries(this.MESSAGES).map(async ([type, text]) => {
        if (this._raw[type]) return;
        try {
          const res = await fetch(`/api/tts?text=${encodeURIComponent(text)}`);
          if (res.ok) this._raw[type] = await res.arrayBuffer();
        } catch {}
      })
    );
    // 프리페치 완료 후 AudioContext가 이미 있으면 바로 디코딩
    this.decodeAll().catch(() => {});
  },

  // SilentAudioLoop.unlock() 후 호출: raw → AudioBuffer 디코딩
  async decodeAll() {
    const ctx = SilentAudioLoop.getContext();
    if (!ctx || ctx.state === 'closed') return;
    await Promise.allSettled(
      Object.entries(this._raw).map(async ([type, raw]) => {
        if (this._decoded[type]) return;
        try {
          // slice(0): decodeAudioData가 ArrayBuffer를 소비하므로 복사본 사용
          this._decoded[type] = await ctx.decodeAudioData(raw.slice(0));
        } catch {}
      })
    );
  },

  // 위험 감지 시 호출 — startDelay: 비프음 완료 후 음성 시작 (초)
  async play(zoneType, text, startDelay = 0) {
    if (!Settings.get().ttsEnabled) return;

    let ctx = SilentAudioLoop.getContext();
    if (!ctx || ctx.state === 'closed') {
      // AudioContext 없음 → speechSynthesis 폴백 (화면 켜짐 상태에서만)
      this._speechFallback(text);
      return;
    }
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    // 1순위: 디코딩된 AudioBuffer 재생 (화면 꺼짐 포함 100% 동작)
    let buffer = this._decoded[zoneType];

    // 2순위: raw 데이터가 있으면 온디맨드 디코딩
    if (!buffer && this._raw[zoneType]) {
      try {
        buffer = await ctx.decodeAudioData(this._raw[zoneType].slice(0));
        this._decoded[zoneType] = buffer;
      } catch {}
    }

    if (buffer) {
      const src  = ctx.createBufferSource();
      const gain = ctx.createGain();
      src.buffer = buffer;
      src.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.value = 1.5; // 비프음보다 음성이 선명하게
      src.start(ctx.currentTime + 0.05 + startDelay);
      return;
    }

    // 3순위: TTS 버퍼 없음 → speechSynthesis 폴백
    this._speechFallback(text);
  },

  _speechFallback(text) {
    // iOS 잠금 시 speechSynthesis 차단 → 화면 켜짐 상태·Android에서만 실행
    if (document.hidden && Platform.isIOS) return;
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    setTimeout(() => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR'; u.rate = 0.9; u.volume = 1.0;
      const kor = window.speechSynthesis.getVoices().find(v => v.lang.startsWith('ko'));
      if (kor) u.voice = kor;
      window.speechSynthesis.speak(u);
    }, 150);
  }
};

// 하위 호환 TTS 래퍼 (기존 호출부 변경 최소화)
const TTS = {
  speak(text)       { VoiceAlert._speechFallback(text); },
  getZoneMessage(z) { return VoiceAlert.getZoneMessage(z); }
};

// ═══════════════════════════════════════════════════════════════════════════
// Wake Lock 모듈 — 화면 켜짐 유지
// ═══════════════════════════════════════════════════════════════════════════
const WakeLock = {
  _lock: null,
  async request() {
    if (!('wakeLock' in navigator)) return;
    try {
      this._lock = await navigator.wakeLock.request('screen');
      this._lock.addEventListener('release', () => {
        if (Ride.active) setTimeout(() => this.request(), 1000);
      });
    } catch (e) {}
  },
  release() {
    if (this._lock) { this._lock.release(); this._lock = null; }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// iOS Silent Audio Loop — Web Audio API 전용 (HTML5 Audio 완전 제거)
//
// [변경 이유]
//  HTML5 <audio> 태그로 WAV 재생 시 iOS가 앱을 '음악 앱'으로 인식:
//    - 잠금화면·알림창에 미디어 플레이어 위젯(재생/일시정지 버튼) 표시
//    - 다이나믹 아일랜드·상태바에 오디오 재생 중 아이콘 상주
//    - 타 음악 앱(멜론, 유튜브 뮤직 등)의 오디오 세션 강제 중단
//
// [대체 구현]
//  - Web Audio API 극소음(-100dB) 노이즈 루프: 오디오 세션 살아있는 동안 iOS JS·GPS 유지
//  - navigator.audioSession.type = 'ambient' (iOS 16.4+): 타 앱 음악과 공존(믹싱)
//  - navigator.mediaSession 메타데이터 null 강제 설정: 잠금화면 위젯 억제
//  - setMode('transient'): 위험 경고 시 배경 음악 덕킹, 경고 후 'ambient' 복귀
// ═══════════════════════════════════════════════════════════════════════════
const SilentAudioLoop = {
  _ctx:       null,
  _src:       null,
  _unlocked:  false,
  _mode:      'ambient',
  _keepAlive: null,

  async unlock() {
    if (this._unlocked) { this.resume(); return; }

    // 잠금화면 미디어 플레이어 위젯 전면 억제
    this._suppressMediaSession();

    // iOS 오디오 세션: ambient = 타 앱 음악과 공존, 방해 없음
    this._applyAudioSession('ambient');

    // Web Audio API 극소음 루프 — 오디오 세션 활성 상태 유지 (백그라운드 GPS·JS 동작 보장)
    try {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      const sr  = this._ctx.sampleRate;
      const len = sr * 3; // 3초 버퍼 반복
      const buf = this._ctx.createBuffer(1, len, sr);
      const d   = buf.getChannelData(0);
      // -100dB 극소음 (완전 무음 0 이면 iOS가 세션 비활성으로 판단)
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.00001;

      const gain = this._ctx.createGain();
      gain.gain.value = 1;
      gain.connect(this._ctx.destination);

      this._src        = this._ctx.createBufferSource();
      this._src.buffer = buf;
      this._src.loop   = true;
      this._src.connect(gain);

      if (this._ctx.state === 'suspended') await this._ctx.resume();
      this._src.start(0);
    } catch(e) {}

    this._unlocked = true;
    // 5초마다 ctx 상태 점검 — 백그라운드에서 suspended 로 떨어지면 즉시 재개
    this._startKeepAlive();
    // AudioContext 준비 완료 → 프리페치된 TTS raw 버퍼를 AudioBuffer로 디코딩
    setTimeout(() => VoiceAlert.decodeAll().catch(() => {}), 200);
  },

  _startKeepAlive() {
    // iOS WebKit 전용: 화면 꺼짐 후 AudioContext가 suspended 로 떨어지는 현상 방어
    // Android Chrome은 Web Audio API가 백그라운드에서도 안정적으로 동작 → 인터벌 불필요
    if (!Platform.isIOS) return;
    clearInterval(this._keepAlive);
    this._keepAlive = setInterval(() => {
      if (!this._ctx) return;
      if (this._ctx.state === 'suspended') {
        this._ctx.resume().catch(() => {});
        this._suppressMediaSession();
      }
    }, 5000);
  },

  stopKeepAlive() {
    clearInterval(this._keepAlive);
    this._keepAlive = null;
  },

  resume() {
    if (this._ctx?.state === 'suspended') this._ctx.resume().catch(() => {});
    this._suppressMediaSession();
    this._applyAudioSession(this._mode);
  },

  // 경고음·TTS 재생 시 'transient'(배경 음악 덕킹), 경고 종료 후 'ambient'(복귀)
  setMode(mode) {
    this._mode = mode;
    this._applyAudioSession(mode);
  },

  _applyAudioSession(type) {
    if (navigator.audioSession) {
      try { navigator.audioSession.type = type; } catch(e) {}
    }
  },

  _suppressMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata     = null;
    navigator.mediaSession.playbackState = 'none';
    ['play','pause','stop','seekbackward','seekforward','previoustrack','nexttrack'].forEach(a => {
      try { navigator.mediaSession.setActionHandler(a, null); } catch(e) {}
    });
  },

  getContext() { return this._ctx; }
};

// ═══════════════════════════════════════════════════════════════════════════
// HazardAudio — 위험 유형별 구별 가능한 경고음 합성
// Web Audio API 로 직접 합성 → 오디오 세션 활성 상태에서 화면 꺼짐에도 100% 동작
// 오디오 세션 모드 전환(덕킹)은 Alert.show / Alert.dismiss 에서 일괄 관리
// ═══════════════════════════════════════════════════════════════════════════
const HazardAudio = {
  // [주파수Hz, 지속ms] — 0Hz는 무음 간격
  PATTERNS: {
    pothole:      [[880,180],[0,80],[880,180],[0,80],[1174,380]], // 위험!위험!경보!
    slippery:     [[660,280],[0,120],[440,460]],                  // 미끄-러움↘
    construction: [[550,130],[0,60],[550,130],[0,60],[550,130]], // 공사중·공사중
    other:        [[770,220],[0,100],[770,440]],                  // 일반 경고
  },

  play(zoneType) {
    let ctx = SilentAudioLoop.getContext();
    if (!ctx || ctx.state === 'closed') {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { return; }
    }
    // Android Chrome 포그라운드 복귀 시 ctx 가 suspended 상태일 수 있음 → 먼저 resume
    if (ctx.state === 'suspended') {
      ctx.resume()
        .then(() => { SilentAudioLoop.resume(); this._schedule(ctx, zoneType); })
        .catch(() => {});
      return;
    }
    SilentAudioLoop.resume();
    this._schedule(ctx, zoneType);
  },

  _schedule(ctx, zoneType) {
    const pattern = this.PATTERNS[zoneType] || this.PATTERNS.other;
    let t = ctx.currentTime + 0.04;

    pattern.forEach(([freq, durMs]) => {
      const dur = durMs / 1000;
      if (freq === 0) { t += dur; return; }
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.5, t + 0.025);
      gain.gain.setValueAtTime(0.5, t + dur - 0.025);
      gain.gain.linearRampToValueAtTime(0, t + dur);
      osc.start(t);
      osc.stop(t + dur);
      t += dur;
    });
  }
};

// 하위 호환 래퍼 (기존 playAlertSound 호출 코드가 있을 경우를 위해 유지)
function playAlertSound() { HazardAudio.play('other'); }

// ── Service Worker 메시지 공통 발행 헬퍼 ────────────────────────────────────
// [iOS 잠금화면 알림 누락 버그 수정]
// 기존: controller.postMessage 우선 사용
//   → iOS 잠금 시 controller 참조가 끊기거나 SW가 메모리 압박으로 종료되면 유실
// 변경: 항상 navigator.serviceWorker.ready 경유
//   → ready는 SW가 종료됐다 재시작해도 활성 SW 참조를 안정적으로 반환
//   → 2초 타임아웃: SW 등록 이상 시 무한 대기 방지
async function sendSwMessage(data) {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error('SW ready timeout')), 2000))
    ]);
    if (reg?.active) reg.active.postMessage(data);
  } catch {}
}

// 위험 구역 진입 알림
async function sendSwAlert(zone) {
  return sendSwMessage({
    type:     'DANGER_ZONE_ALERT',
    title:    '⚠️ Safe Ride 위험 구역 감지!',
    body:     `${ZONE_ICONS[zone.type]||'⚠️'} ${ZONE_KOREAN[zone.type]||zone.title} 50m 전입니다. 서행하세요!`,
    icon:     '/icons/icon-192.png',
    zoneType: zone.type
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 구역 로드 & 렌더링
// ═══════════════════════════════════════════════════════════════════════════
async function loadZones() {
  try {
    const fresh = await API.getZones();
    const existingIds = new Set(allZones.map(z => z.id));
    const newZones    = fresh.filter(z => !existingIds.has(z.id));
    allZones = fresh;
    renderZones(allZones);
    updateNearbyCount();
    ZoneList.render();
    if (newZones.length) Toast.show(`새 위험 구역 ${newZones.length}개가 지도에 추가됐습니다`);
  } catch (e) {
    document.getElementById('danger-count-text').textContent = '구역 불러오기 실패';
  }
}

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
    L.circle([z.lat, z.lng], { radius, color, fillColor: color, fillOpacity: 0.18, weight: 2 }).addTo(zoneLayer);

    const icon = L.divIcon({
      className: '',
      html: `<div style="background:${color};border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:15px;border:2px solid white;box-shadow:0 2px 10px rgba(0,0,0,0.6)">${ZONE_ICONS[z.type] || '⚠️'}</div>`,
      iconSize: [34, 34], iconAnchor: [17, 17]
    });

    // 마커 클릭 시 상세 팝업 (주소는 비동기 로딩)
    const marker = L.marker([z.lat, z.lng], { icon }).addTo(zoneLayer);
    const popupDiv = document.createElement('div');
    popupDiv.style.cssText = 'min-width:200px;max-width:260px;font-size:13px;line-height:1.6';
    popupDiv.innerHTML = `
      <div style="font-weight:800;font-size:15px;margin-bottom:6px">${ZONE_ICONS[z.type]||'⚠️'} ${ZONE_KOREAN[z.type] || z.title}</div>
      <div style="color:#94a3b8;margin-bottom:3px;font-size:11px">📍 <span id="popup-addr-${z.id}">주소 조회 중…</span></div>
      <div style="color:#64748b;font-size:11px;margin-bottom:3px">📅 ${formatDate(z.createdAt)}</div>
      <div style="color:#86efac;font-size:11px;margin-bottom:6px">✅ 이젠 안전해요 (${z.safeVotes||0} / 3명 완료)</div>
      <div style="color:#f97316;font-size:11px">신고 수: ${z.reportCount || 1}</div>
    `;
    marker.bindPopup(popupDiv, { maxWidth: 280 });
    marker.on('popupopen', () => {
      getAddress(z.lat, z.lng).then(addr => {
        const el = document.getElementById(`popup-addr-${z.id}`);
        if (el) el.textContent = addr;
      });
    });
  });
}

// ── 주변 위험구역 카운트 ────────────────────────────────────────────────────
function updateNearbyCount() {
  const pos = GPS.lastPos;
  const el  = document.getElementById('danger-count-text');
  if (!pos) {
    el.textContent = allZones.length ? `전체 ${allZones.length}개` : '구역 없음';
    return;
  }
  const count = allZones.filter(z => haversine(pos.lat, pos.lng, z.lat, z.lng) <= 500).length;
  el.textContent = `주변 ${count}개 위험`;
}

// ── Haversine 거리 계산 ───────────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── 근접 감지 + 구역 진입/이탈 추적 (히스테리시스 적용) ─────────────────────
// enteredZones Map 구조: zoneId → entryTimestamp
// 진입 기준: alertDist 이하 / 이탈 확정: alertDist + EXIT_HYSTERESIS 초과
// GPS 오차(20~40m)로 인한 경계 진동 시 이탈이 오발되지 않도록 20m 버퍼 적용
function checkProximity(lat, lng) {
  const settings  = Settings.get();
  const alertDist = settings.alertDistance;
  const exitDist  = alertDist + EXIT_HYSTERESIS; // 이탈 확정 경계 (오차 보정)

  allZones.forEach(z => {
    const d          = haversine(lat, lng, z.lat, z.lng);
    const wasEntered = enteredZones.has(z.id);
    const isInside   = d <= alertDist;
    const isOutside  = d > exitDist; // 히스테리시스 통과 시만 이탈 확정

    if (isInside && !wasEntered) {
      // ── 진입 확정 ──
      enteredZones.set(z.id, Date.now());
      if (!alertedZones.has(z.id)) {
        alertedZones.add(z.id);
        currentAlertZone = z;
        // SW 잠금화면 알림: alertsEnabled·화면 상태 무관하게 항상 선발송
        sendSwAlert(z);
        // UI·오디오·TTS 경고는 alertsEnabled 설정 준수
        if (settings.alertsEnabled) Alert.show(z);
        setTimeout(() => alertedZones.delete(z.id), 60000);
      }
    } else if (isOutside && wasEntered) {
      // ── 이탈 확정 (히스테리시스 통과) ──
      enteredZones.delete(z.id);

      // 백그라운드(화면 잠금) 상태 시 SW 알림으로 이탈 통보 (iOS·Android 공통 ready fallback)
      if (document.hidden) {
        sendSwMessage({
          type:  'DANGER_ZONE_EXIT',
          title: '✅ 위험구역 통과',
          body:  `[${ZONE_KOREAN[z.type] || z.title}] 구역을 지나왔습니다. 안전 여부를 알려주세요!`,
          icon:  '/icons/icon-192.png'
        });
      }

      // 투표 팝업: 라이딩 중이면 alertsEnabled 설정과 무관하게 무조건 표시
      if (Ride.active) {
        const alreadyVoted = Auth.user
          ? (Array.isArray(z.safeVoterIds) && z.safeVoterIds.includes(Auth.user.id))
          : false;
        if (!alreadyVoted) VotePopup.show(z);
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GPS 디버그 패널 — 야외 테스트용: 좌측 하단에 실시간 좌표·상태 출력
// ═══════════════════════════════════════════════════════════════════════════
const GpsDebug = {
  _el: null,

  init() { this._el = document.getElementById('gps-debug'); },

  update(state, lat, lng, accuracy, msg) {
    if (!this._el) return;
    const t = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let text;
    if (state === 'on' && lat != null) {
      text = `✅ ${lat.toFixed(5)},\n   ${lng.toFixed(5)}\n정확도 ${accuracy != null ? Math.round(accuracy) + 'm' : '?'}\n${t}`;
    } else if (state === 'acquiring') {
      text = `🔵 GPS 탐색 중...\n${t}`;
    } else if (state === 'trigger') {
      text = `🟡 트리거 수신\n${lat != null ? lat.toFixed(5) + ', ' + lng.toFixed(5) : '?'}\n${t}`;
    } else if (state === 'retry' || state === 'watchdog') {
      text = `🔄 ${msg || '재시도'}\n${t}`;
    } else if (state === 'error') {
      text = `❌ ${msg || 'GPS 오류'}\n${t}`;
    } else {
      text = `⚫ GPS 꺼짐\n${t}`;
    }
    this._el.textContent = text;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GPS 모듈 — iOS PWA 전용 폴백 + 강제 트리거 + 워치독 포함
// ═══════════════════════════════════════════════════════════════════════════
const GPS = {
  watchId:        null,
  lastPos:        null,
  active:         false,
  autoCenter:     true,
  accuracyCircle: null,
  speedBuffer:    [],
  _gpsLocked:     false,
  _hasPanned:     false,
  _prevPos:       null,
  _lastHeading:   null,
  _retryCount:    0,       // 연속 재시도 횟수 (5회 초과 시 권한 안내로 전환)
  _watchdogTimer: null,    // 응답 없음 감시 타이머

  // ── iOS PWA 전용: 시스템에 "GPS 필수 앱" 신호를 먼저 쏘는 강제 트리거 ───────
  // 앱 마운트 직후 짧은 타임아웃으로 getCurrentPosition을 한 번 선제 호출.
  // WebKit이 위치 서비스 스택을 미리 깨워두어 이후 watchPosition 성공률이 높아짐.
  _iosGpsTrigger() {
    if (!navigator.geolocation) return;
    GpsDebug.update('acquiring');
    navigator.geolocation.getCurrentPosition(
      pos => {
        GpsDebug.update('trigger', pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
        if (!this._gpsLocked) this.onPosition(pos);
      },
      err => {
        GpsDebug.update('error', null, null, null, `트리거 실패 code${err.code}`);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  },

  startTracking() {
    if (this.active) return;
    this.active      = true;
    this._gpsLocked  = false;
    this._hasPanned  = false;

    if (!navigator.geolocation) {
      this.active = false;
      this._setGpsUI('off');
      GpsDebug.update('error', null, null, null, 'Geolocation 미지원');
      Toast.show('이 브라우저는 GPS를 지원하지 않습니다.');
      return;
    }
    this._setGpsUI('acquiring');
    GpsDebug.update('acquiring');

    // Step 1: iOS WebKit GPS 스택 강제 웜업 트리거
    this._iosGpsTrigger();

    // Step 2: 12초 워치독 — 응답 없으면 자동 리셋 후 재시도
    clearTimeout(this._watchdogTimer);
    this._watchdogTimer = setTimeout(() => {
      if (!this._gpsLocked) {
        GpsDebug.update('watchdog', null, null, null, `응답없음→재시도(${this._retryCount + 1})`);
        this._resetAndRetry('watchdog');
      }
    }, 12000);

    // Step 3: watchPosition — maximumAge:0 으로 캐시 위치 완전 차단
    this.watchId = navigator.geolocation.watchPosition(
      pos => {
        clearTimeout(this._watchdogTimer);
        this._retryCount = 0;
        if (!this._gpsLocked) {
          this._gpsLocked = true;
          this._setGpsUI('on');
          Toast.show('GPS 연결됨 ✓');
        }
        GpsDebug.update('on', pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
        this.onPosition(pos);
      },
      err => {
        clearTimeout(this._watchdogTimer);
        GpsDebug.update('error', null, null, null, `ERR code${err.code}`);
        this._handleError(err);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  },

  // ── 에러 핸들러 — 코드별 재시도 전략 ────────────────────────────────────────
  _handleError(err) {
    this._setGpsUI('off');
    this.active = false;
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    const isIosPwa = navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;

    if (err.code === 1) {
      // PERMISSION_DENIED — 재시도 무의미, 사용자 안내
      Toast.show(isIosPwa
        ? '위치 권한 없음 — 설정 → Safari → 위치 → 허용'
        : '위치 권한 없음 — 브라우저 설정에서 허용해 주세요');
    } else if (err.code === 2) {
      // POSITION_UNAVAILABLE — iOS PWA에서 빈번, 점진 대기 후 재시도
      this._retryCount++;
      const delay = Math.min(2000 * this._retryCount, 10000);
      Toast.show(`위치 신호 없음 — ${delay / 1000}초 후 재시도 (${this._retryCount}회)`);
      setTimeout(() => this._resetAndRetry('pos_unavail'), delay);
    } else {
      // TIMEOUT
      this._retryCount++;
      const delay = Math.min(2000 * this._retryCount, 8000);
      Toast.show(`GPS 응답 없음 — ${delay / 1000}초 후 재시도`);
      setTimeout(() => this._resetAndRetry('timeout'), delay);
    }
  },

  // ── 완전 초기화 후 재시도 ────────────────────────────────────────────────────
  _resetAndRetry(reason) {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    clearTimeout(this._watchdogTimer);
    this.active     = false;
    this._gpsLocked = false;
    GpsDebug.update('retry', null, null, null, `재시도 (${reason})`);
    this.startTracking();
  },

  stopTracking() {
    clearTimeout(this._watchdogTimer);
    if (this.watchId !== null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    if (this.accuracyCircle)   { this.accuracyCircle.remove(); this.accuracyCircle = null; }
    this.active      = false;
    this.lastPos     = null;
    this.speedBuffer = [];
    this._gpsLocked  = false;
    this._hasPanned  = false;
    this._prevPos    = null;
    this._retryCount = 0;
    this._setGpsUI('off');
    GpsDebug.update('off');
  },

  onPosition(pos) {
    const { latitude: lat, longitude: lng, speed, accuracy, heading } = pos.coords;
    const kmh = speed != null ? Math.round(speed * 3.6) : null;
    this._lastHeading = (heading != null && !isNaN(heading)) ? heading : this._lastHeading;
    this._applyPosition(lat, lng, kmh, accuracy);
  },

  _applyPosition(lat, lng, rawKmh, accuracy) {
    // GPS 첫 수신 시 마커 생성 (하드코딩 기본 위치 없음)
    if (!riderMarker) {
      riderMarker = L.marker([lat, lng], { icon: riderIcon, zIndexOffset: 1000 }).addTo(map);
    } else {
      riderMarker.setLatLng([lat, lng]);
    }
    this.lastPos = { lat, lng };
    updateNearbyCount();

    // 정확도 원
    if (accuracy != null && accuracy < 200) {
      if (!this.accuracyCircle) {
        this.accuracyCircle = L.circle([lat, lng], {
          radius: accuracy, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.07, weight: 1, dashArray: '4'
        }).addTo(map);
      } else {
        this.accuracyCircle.setLatLng([lat, lng]);
        this.accuracyCircle.setRadius(accuracy);
      }
    }

    // 자동 중심 이동 — autoCenter 활성 상태일 때만 이동
    if (this.autoCenter && (!this._hasPanned || Ride.active)) {
      this._hasPanned = true;
      map.panTo([lat, lng], { animate: true, duration: 0.3 });
    }

    // '내 위치' 버튼 가시성 업데이트
    LocBtn.updateVisibility();

    // 항상 근접 감지 (라이딩 여부와 무관하게 경고 동작)
    checkProximity(lat, lng);

    // 헤드업 지도 회전 (라이딩 중, 속도 > 2km/h일 때)
    if (Ride.active && rawKmh != null && rawKmh > 2 && this._lastHeading != null) {
      if (map.setBearing) map.setBearing(this._lastHeading);
    }

    if (!Ride.active) return;

    // 거리 계산
    if (this._prevPos) {
      const d = haversine(this._prevPos.lat, this._prevPos.lng, lat, lng);
      if (d < 500) Ride.addDistance(d);
    }
    this._prevPos = { lat, lng };

    // 속도 스무딩
    if (rawKmh != null) {
      this.speedBuffer.push(rawKmh);
      if (this.speedBuffer.length > 4) this.speedBuffer.shift();
      const smoothed = Math.round(this.speedBuffer.reduce((a, b) => a + b, 0) / this.speedBuffer.length);
      Ride.updateSpeed(smoothed);
      const limit = parseInt(Settings.get().speedLimit);
      if (limit > 0 && smoothed > limit) Alert.showSpeedWarning(smoothed, limit);
    }

    // 라이딩 중 경로 기록
    if (Ride.routeCoords.length < 200) Ride.routeCoords.push([lat, lng]);
  },

  _setGpsUI(state) {
    const dot   = document.getElementById('gps-dot');
    const badge = document.getElementById('gps-badge');
    if (state === 'on') {
      dot.className   = 'w-3 h-3 bg-green-400 rounded-full animate-pulse';
      badge.className = 'flex items-center justify-center w-7 h-7 bg-green-500/20 border border-green-500/50 rounded-full';
      badge.title     = 'GPS 활성';
    } else if (state === 'acquiring') {
      dot.className   = 'w-3 h-3 bg-blue-400 rounded-full animate-ping';
      badge.className = 'flex items-center justify-center w-7 h-7 bg-blue-500/20 border border-blue-500/50 rounded-full';
      badge.title     = 'GPS 탐색 중';
    } else {
      dot.className   = 'w-3 h-3 bg-slate-500 rounded-full';
      badge.className = 'flex items-center justify-center w-7 h-7 bg-slate-700/80 border border-slate-600 rounded-full';
      badge.title     = 'GPS 꺼짐';
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Ride 모듈 — 백그라운드 안전 타이머 (절대 시간 기반)
// ═══════════════════════════════════════════════════════════════════════════
const Ride = {
  active:       false,
  elapsed:      0,
  distance:     0,
  speedHistory: [],
  maxSpeed:     0,
  passedZones:  [],
  routeCoords:  [],
  timer:        null,
  _startTime:   null,      // 라이딩 시작 절대 시간
  _bgSaveTime:  null,      // 백그라운드 진입 시각

  toggle() { this.active ? this.stop() : this.start(); },

  start() {
    this.active = true;
    this.elapsed = 0; this.distance = 0; this.speedHistory = []; this.maxSpeed = 0;
    this.passedZones = []; this.routeCoords = [];
    this._startTime = Date.now();
    alertedZones.clear(); enteredZones.clear();

    const btn = document.getElementById('ride-btn');
    btn.textContent = '라이딩 종료';
    btn.classList.replace('bg-green-500', 'bg-red-500');
    btn.classList.replace('hover:bg-green-400', 'hover:bg-red-400');

    if (!GPS.active) GPS.startTracking();
    GPS._prevPos = null;

    this.timer = setInterval(() => this._tick(), 1000);
    startZonePolling();
    WakeLock.request();

    // 라이딩 시작 = 사용자 제스처 → iOS 오디오 세션 즉시 언락
    // 이 시점부터 화면이 꺼져도 오디오 세션이 유지되어 GPS·스크립트 동작 보장
    SilentAudioLoop.unlock();

    // TTS 음성 파일 프리페치 + 디코딩 (라이딩 중 화면 꺼짐에도 즉시 재생 가능)
    setTimeout(() => VoiceAlert.prefetch(), 300);

    // 알림 권한 요청 — iOS 16.4+: 잠금화면 배너 표시에 필수
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    Toast.show('라이딩 시작! 안전하게 달려요 🚴');
  },

  async stop() {
    this.active = false;
    clearInterval(this.timer);
    stopZonePolling();
    WakeLock.release();

    // 지도 베어링 리셋 (북쪽 위)
    if (map.setBearing) map.setBearing(0);

    const btn = document.getElementById('ride-btn');
    btn.textContent = '라이딩 시작';
    btn.classList.replace('bg-red-500', 'bg-green-500');
    btn.classList.replace('hover:bg-red-400', 'hover:bg-green-400');
    document.getElementById('speed-val').textContent = '0';

    // 라이딩 저장 (5초 이상)
    if (this.elapsed > 5) {
      const avg = this.speedHistory.length
        ? Math.round(this.speedHistory.reduce((a, b) => a + b, 0) / this.speedHistory.length)
        : 0;
      try {
        await API.saveRide({
          distance: this.distance / 1000, duration: this.elapsed,
          avgSpeed: avg, maxSpeed: this.maxSpeed,
          dangerZonesPassed: this.passedZones, route: this.routeCoords.slice(0, 200)
        });
        // 주행 거리 포인트 (+5pt/10km)
        const distKm = this.distance / 1000;
        const ptFromDist = Math.floor(distKm / 10) * 5;
        if (ptFromDist > 0 && Auth.user) {
          API.addSafetyPoints(ptFromDist, 0, distKm).catch(() => {});
        }
        Toast.show(`라이딩 저장 완료! ${(this.distance/1000).toFixed(2)} km`);
      } catch (e) {
        Toast.show('라이딩 저장 실패 (로그인 확인)');
      }
    }
  },

  _tick() {
    // 절대 시간 기반으로 경과 시간 계산 (백그라운드 슬립 보정)
    if (this._startTime) this.elapsed = Math.floor((Date.now() - this._startTime) / 1000);
    this._updateTimeDisplay();
  },

  _updateTimeDisplay() {
    const m = Math.floor(this.elapsed / 60).toString().padStart(2, '0');
    const s = (this.elapsed % 60).toString().padStart(2, '0');
    document.getElementById('time-val').textContent = `${m}:${s}`;
  },

  addDistance(meters) {
    this.distance += meters;
    document.getElementById('dist-val').textContent = (this.distance / 1000).toFixed(2);
  },

  updateSpeed(kmh) {
    this.speedHistory.push(kmh);
    if (kmh > this.maxSpeed) this.maxSpeed = kmh;
    document.getElementById('speed-val').textContent = kmh;
  }
};

// 백그라운드 전환 시 타이머 처리 + iOS PWA GPS 재시작 + 오디오 세션 재개
document.addEventListener('visibilitychange', () => {
  // 화면 켜짐·꺼짐 전환 모두에서 즉시 재개 — 백그라운드 진입 시 suspended 방지
  SilentAudioLoop.resume();

  if (!document.hidden) {
    // iOS PWA: 백그라운드에서 watchPosition이 소멸한 경우 재시작
    if (!GPS.active) setTimeout(() => GPS.startTracking(), 600);
  }

  if (!Ride.active) return;
  if (document.hidden) {
    clearInterval(Ride.timer);
    Ride._bgSaveTime = Date.now();
  } else {
    Ride.timer = setInterval(() => Ride._tick(), 1000);
    Ride._tick();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Alert 모듈 — 최소 UI, 5초 자동 소멸, TTS + 진동 + 음향 동시
//
// 오디오 덕킹 흐름:
//   show() → audioSession 'transient' 전환 (배경 음악 자동 감소)
//            HazardAudio 경고음 + TTS 음성이 메인 오디오로 선명하게 출력
//   dismiss() → audioSession 'ambient' 복귀 (배경 음악 원래 볼륨으로 자동 복구)
// ═══════════════════════════════════════════════════════════════════════════
const Alert = {
  show(zone) {
    if (!Settings.get().alertsEnabled) return;

    const ttsMsg = TTS.getZoneMessage(zone);
    document.getElementById('alert-title').textContent = `${ZONE_ICONS[zone.type]||'⚠️'} ${ZONE_KOREAN[zone.type] || zone.title}`;
    document.getElementById('alert-desc').textContent  = ttsMsg;

    const banner = document.getElementById('alert-banner');
    banner.classList.remove('fade-out');
    banner.classList.add('show');

    clearTimeout(_alertTimeout);
    _alertTimeout = setTimeout(() => this.dismiss(), 5000);

    if (Ride.active) Ride.passedZones.push(zone.id);

    // 강화 진동 — 화면 꺼짐 상태에서도 navigator.vibrate 는 동작
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 800]);

    // 배경 음악 덕킹 시작: ambient → transient (타 앱 음악 볼륨 자동 감소)
    SilentAudioLoop.setMode('transient');

    // 위험 유형별 경고음 (Web Audio API — 오디오 세션 활성 시 화면 꺼짐에도 동작)
    HazardAudio.play(zone.type);

    // 음성 안내 — AudioContext 기반(VoiceAlert) 우선: 화면 꺼짐에도 동작
    // 비프음 완료(~0.85초) 후 음성 시작 → 비프 + 목소리 명확히 구분
    VoiceAlert.play(zone.type, ttsMsg, 0.85);

    // SW 알림은 checkProximity 진입 시 이미 발송됨 — Alert.show 에서 중복 호출 제거
  },

  showSpeedWarning(speed, limit) {
    document.getElementById('alert-title').textContent = '🚨 속도 초과!';
    document.getElementById('alert-desc').textContent  = `현재 ${speed} km/h — 제한 ${limit} km/h. 속도를 줄여주세요.`;
    const banner = document.getElementById('alert-banner');
    banner.classList.remove('fade-out');
    banner.classList.add('show');
    clearTimeout(_alertTimeout);
    _alertTimeout = setTimeout(() => this.dismiss(), 4000);
    if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]);
  },

  dismiss() {
    const banner = document.getElementById('alert-banner');
    banner.classList.add('fade-out');
    setTimeout(() => { banner.classList.remove('show', 'fade-out'); }, 400);
    currentAlertZone = null;

    // 배경 음악 덕킹 해제: transient → ambient (타 앱 음악 볼륨 원래대로 자동 복구)
    SilentAudioLoop.setMode('ambient');
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 집단지성 투표 팝업 모듈
// ═══════════════════════════════════════════════════════════════════════════
const VotePopup = {
  _zone: null,
  _timer: null,

  show(zone) {
    this._zone = zone;
    const korean = ZONE_KOREAN[zone.type] || zone.title;
    document.getElementById('vote-question').textContent = `방금 지나온 [${korean}] 안전해졌나요?`;
    document.getElementById('vote-zone-name').textContent = zone.title || korean;
    document.getElementById('vote-popup').classList.add('open');

    // 30초 후 자동 닫기
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.close(), 30000);
  },

  async vote(type) {
    clearTimeout(this._timer);
    const zone = this._zone;
    this.close();
    if (!zone) return;

    if (type === 'safe') {
      if (!Auth.user) { Toast.show('투표는 로그인이 필요합니다'); return; }
      try {
        const result = await API.voteZoneSafe(zone.id);
        if (result.cleared) {
          allZones = allZones.filter(z => z.id !== zone.id);
          alertedZones.delete(zone.id);
          zonesInside.delete(zone.id);
          renderZones(allZones);
          ZoneList.render();
          updateNearbyCount();
          Toast.show('✅ 3명 완료 — 위험 구역이 자동 해제되었습니다!');
        } else {
          const z = allZones.find(z => z.id === zone.id);
          if (z) { z.safeVotes = result.zone.safeVotes; z.safeVoterIds = result.zone.safeVoterIds; }
          Toast.show(`안전 투표 완료 (${result.zone.safeVotes}/3)`);
        }
        // 안전 투표 포인트
        API.addSafetyPoints(5).catch(() => {});
      } catch (e) {
        Toast.show(e.message || '투표 처리 중 오류');
      }
    } else {
      Toast.show('위험 정보가 유지됩니다. 안전에 주의하세요.');
    }
  },

  close() {
    document.getElementById('vote-popup').classList.remove('open');
    this._zone = null;
    clearTimeout(this._timer);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 위험 구역 목록 모듈 (심각도 필터)
// ═══════════════════════════════════════════════════════════════════════════
const ZoneList = {
  _current: 'all',

  filter(severity) {
    this._current = severity;
    // 필터 버튼 스타일 업데이트
    document.querySelectorAll('#zone-filters .filter-btn').forEach(btn => {
      const f = btn.dataset.filter;
      btn.className = `filter-btn ${f === severity ? `active-${severity}` : 'inactive'}`;
    });
    this.render();
  },

  render() {
    const el = document.getElementById('zone-list-items');
    const total = document.getElementById('zone-total-count');
    total.textContent = `총 ${allZones.length}개`;

    const filtered = this._current === 'all'
      ? allZones
      : allZones.filter(z => z.severity === this._current);

    if (!filtered.length) {
      el.innerHTML = `<div class="text-slate-500 text-sm text-center py-6">해당 조건의 위험 구역이 없습니다</div>`;
      return;
    }
    el.innerHTML = filtered.map(z => {
      const c = z.severity === 'high'   ? 'text-red-400 bg-red-500/10 border-red-500/30'
              : z.severity === 'medium' ? 'text-orange-400 bg-orange-500/10 border-orange-500/30'
              : 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30';
      const sevLabel = z.severity === 'high' ? '위험' : z.severity === 'medium' ? '주의' : '경계';
      return `<div class="flex items-start gap-3 p-3 rounded-xl border ${c} cursor-pointer" onclick="focusZone(${z.lat},${z.lng})">
        <span class="text-2xl">${ZONE_ICONS[z.type]||'⚠️'}</span>
        <div class="flex-1">
          <div class="font-semibold text-sm text-white">${escHtml(ZONE_KOREAN[z.type] || z.title)}</div>
          <div class="text-xs text-slate-400 mt-0.5">${escHtml(z.desc)}</div>
          <div class="text-xs text-slate-500 mt-0.5">신고 ${z.reportCount||1}건 · 안전투표 ${z.safeVotes||0}/3</div>
        </div>
        <span class="text-xs font-bold px-2 py-0.5 rounded-full border ${c} flex-shrink-0">${escHtml(sevLabel)}</span>
      </div>`;
    }).join('');
  }
};

function focusZone(lat, lng) {
  map.flyTo([lat, lng], 17, { duration: 0.8 });
  Panels.closeAll();
}

// ═══════════════════════════════════════════════════════════════════════════
// Report 모듈
// ═══════════════════════════════════════════════════════════════════════════
const Report = {
  selectedType: null,
  selectedSev:  'medium',

  async submit() {
    if (!this.selectedType) { Toast.show('위험 유형을 선택해 주세요'); return; }
    if (!Auth.user) {
      Toast.show('신고하려면 로그인이 필요합니다');
      Panels.closeAll();
      setTimeout(() => Auth.openPanel(), 300);
      return;
    }
    if (!GPS.lastPos) {
      Toast.show('GPS 위치를 확인 중입니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    const pos  = GPS.lastPos;
    const desc = document.getElementById('report-desc').value.trim();

    const btn = document.getElementById('report-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = '제출 중...'; }

    try {
      const result = await API.reportHazard({
        lat: pos.lat, lng: pos.lng,
        type: this.selectedType, severity: this.selectedSev, desc
      });

      if (result.action === 'created') {
        allZones.push(result.zone);
        renderZones(allZones);
        ZoneList.render();
        document.getElementById('danger-count-text').textContent = `주변 ${allZones.length}개 위험`;
      } else {
        const z = allZones.find(z => z.id === result.zone.id);
        if (z) { z.reportCount = result.zone.reportCount; renderZones(allZones); }
      }

      const rIcon = L.divIcon({
        className: '',
        html: `<div style="background:#f97316;border-radius:50%;width:16px;height:16px;border:2px solid white;opacity:0.9"></div>`,
        iconSize: [16, 16], iconAnchor: [8, 8]
      });
      L.marker([pos.lat, pos.lng], { icon: rIcon }).addTo(reportLayer)
       .bindPopup(`<div style="font-size:12px">${ZONE_ICONS[this.selectedType]||'⚠️'} ${ZONE_KOREAN[this.selectedType] || '위험'}</div>`);

      // 신고 포인트 +10
      API.addSafetyPoints(10, 1, 0).catch(() => {});

      Panels.closeAll();
      Toast.show('신고 제출 완료! 감사합니다 🙏');
      document.getElementById('report-desc').value = '';
      this.selectedType = null; this.selectedSev = 'medium';
      document.querySelectorAll('#report-type-grid .type-btn').forEach(b => b.classList.remove('selected'));
      document.querySelectorAll('#report-severity-grid .type-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.sev === 'medium');
      });
    } catch (e) {
      Toast.show('신고 제출 실패. 연결 상태를 확인해 주세요.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '신고 제출'; }
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Settings 모듈 (기본값: 50m, TTS 활성)
// ═══════════════════════════════════════════════════════════════════════════
const Settings = {
  defaults: { alertsEnabled: true, alertDistance: 50, speedLimit: 25, ttsEnabled: true },

  get() {
    try { return { ...this.defaults, ...JSON.parse(localStorage.getItem('saferide_settings') || '{}') }; }
    catch { return this.defaults; }
  },

  load() {
    const s = this.get();
    document.getElementById('set-alerts').checked   = s.alertsEnabled;
    document.getElementById('set-distance').value   = s.alertDistance;
    document.getElementById('set-speed-limit').value = s.speedLimit;
    document.getElementById('set-tts').checked      = s.ttsEnabled;
  },

  save() {
    const s = {
      alertsEnabled: document.getElementById('set-alerts').checked,
      alertDistance: parseInt(document.getElementById('set-distance').value),
      speedLimit:    parseInt(document.getElementById('set-speed-limit').value),
      ttsEnabled:    document.getElementById('set-tts').checked
    };
    localStorage.setItem('saferide_settings', JSON.stringify(s));
    Panels.closeAll();
    Toast.show('설정 저장됨 ✓');
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Panels 모듈
// ═══════════════════════════════════════════════════════════════════════════
const Panels = {
  _open(id) {
    this.closeAll();
    document.getElementById(id).classList.add('open');
    document.getElementById('panel-overlay').classList.add('open');
  },
  closeAll() {
    ['zone-list-panel','report-panel','settings-panel','history-panel','auth-panel','profile-panel']
      .forEach(id => document.getElementById(id).classList.remove('open'));
    document.getElementById('panel-overlay').classList.remove('open');
  },
  openZoneList()  { ZoneList.render(); this._open('zone-list-panel'); },
  openReport()    { this._open('report-panel'); },
  openSettings()  { Settings.load(); this._open('settings-panel'); },
  openHistory()   { History.load(); this._open('history-panel'); },
  openProfile()   { Profile.open(); this._open('profile-panel'); }
};

// ═══════════════════════════════════════════════════════════════════════════
// 레벨 시스템
// ═══════════════════════════════════════════════════════════════════════════
const LEVELS = [
  { level:1, name:'새싹 라이더',  emoji:'🌱', min:0,   max:49  },
  { level:2, name:'일반 라이더',  emoji:'🚲', min:50,  max:149 },
  { level:3, name:'안전 라이더',  emoji:'⚡', min:150, max:349 },
  { level:4, name:'도로 마스터',  emoji:'🏆', min:350, max:699 },
  { level:5, name:'안전 히어로',  emoji:'🌟', min:700, max:Infinity }
];

function getLevelInfo(points) {
  return LEVELS.find(l => points >= l.min && points <= l.max) || LEVELS[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// Profile 모듈
// ═══════════════════════════════════════════════════════════════════════════
const Profile = {
  async open() {
    if (!Auth.user) return;
    document.getElementById('profile-avatar').textContent = (Auth.user.name?.[0] || '?').toUpperCase();
    document.getElementById('profile-name').textContent   = Auth.user.name;
    document.getElementById('profile-email').textContent  = Auth.user.email;

    try {
      const profile = await API.getProfile();
      const pts     = profile?.safety_points || 0;
      const lv      = getLevelInfo(pts);
      const nextLv  = LEVELS.find(l => l.min > pts);

      document.getElementById('profile-points').textContent    = pts;
      document.getElementById('profile-level-emoji').textContent = lv.emoji;
      document.getElementById('profile-level-name').textContent  = lv.name;
      document.getElementById('profile-level-num').textContent   = `Lv.${lv.level}`;
      document.getElementById('profile-reports').textContent     = profile?.total_reports || 0;
      document.getElementById('profile-distance').textContent    = (profile?.total_distance || 0).toFixed(1);

      // 레벨 진행 바
      if (nextLv) {
        const progress = ((pts - lv.min) / (nextLv.min - lv.min)) * 100;
        document.getElementById('profile-level-bar').style.width  = `${Math.min(progress, 100)}%`;
        document.getElementById('profile-next-level').textContent = `다음 레벨까지 ${nextLv.min - pts}pt`;
      } else {
        document.getElementById('profile-level-bar').style.width  = '100%';
        document.getElementById('profile-next-level').textContent = '최고 레벨 달성! 🌟';
      }
    } catch (e) {
      document.getElementById('profile-points').textContent = '?';
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// History 모듈
// ═══════════════════════════════════════════════════════════════════════════
const History = {
  async load() {
    const el = document.getElementById('history-list');
    el.innerHTML = '<div class="text-slate-500 text-sm text-center py-4">불러오는 중...</div>';
    try {
      const rides = await API.getRides();
      if (!rides.length) {
        el.innerHTML = '<div class="text-slate-500 text-sm text-center py-8">아직 기록이 없습니다.<br>첫 라이딩을 시작해 보세요!</div>';
        return;
      }
      el.innerHTML = rides.map(r => {
        const date = new Date(r.createdAt).toLocaleDateString('ko-KR', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
        const dur  = `${Math.floor(r.duration/60)}분 ${r.duration%60}초`;
        return `<div class="ride-card">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-slate-400">${date}</span>
            <span class="text-xs bg-slate-700 px-2 py-0.5 rounded-full">${r.dangerZonesPassed?.length||0}개 구역 통과</span>
          </div>
          <div class="grid grid-cols-3 gap-2 text-center">
            <div><div class="text-lg font-black text-blue-400">${parseFloat(r.distance).toFixed(2)}</div><div class="text-xs text-slate-500">km</div></div>
            <div><div class="text-lg font-black text-purple-400">${dur}</div><div class="text-xs text-slate-500">시간</div></div>
            <div><div class="text-lg font-black text-green-400">${r.avgSpeed}</div><div class="text-xs text-slate-500">평균 km/h</div></div>
          </div>
        </div>`;
      }).join('');
    } catch (e) {
      el.innerHTML = '<div class="text-red-400 text-sm text-center py-4">기록 불러오기 실패</div>';
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// LocBtn — '내 위치' 플로팅 버튼 (Strava 방식 자유 탐색)
// ═══════════════════════════════════════════════════════════════════════════
const LocBtn = {
  _el: null,

  init() {
    this._el = document.getElementById('loc-btn');
  },

  flyToMe() {
    if (!GPS.lastPos) { Toast.show('GPS 위치를 확인 중입니다.'); return; }
    GPS.autoCenter = true;
    // 프로그래매틱 이동 — movestart에서 autoCenter를 끄지 않도록 플래그
    map._locBtnMove = true;
    map.flyTo([GPS.lastPos.lat, GPS.lastPos.lng], map.getZoom(), { animate: true, duration: 0.6 });
    this._setActive(false);
  },

  // GPS 위치가 뷰포트 밖이거나 사용자 탐색 중일 때 버튼 강조
  updateVisibility() {
    if (!GPS.lastPos) return;
    if (!GPS.autoCenter) { this._setActive(true); return; }
    const inView = map.getBounds().contains([GPS.lastPos.lat, GPS.lastPos.lng]);
    this._setActive(!inView);
  },

  _setActive(on) {
    this._el?.classList.toggle('loc-active', on);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Toast 모듈
// ═══════════════════════════════════════════════════════════════════════════
let _toastTimer;
const Toast = {
  show(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 이메일 인증 성공 모달
// ═══════════════════════════════════════════════════════════════════════════
const VerificationModal = {
  show() {
    const modal = document.getElementById('verification-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  },
  close() {
    const modal = document.getElementById('verification-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    // URL 해시 정리
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Auth 모듈 — 회원가입 최적화 + 이메일 인증 처리
// ═══════════════════════════════════════════════════════════════════════════
const Auth = {
  user: null,

  async init() {
    // 이메일 인증 링크 감지
    const hash       = window.location.hash;
    const hashParams = new URLSearchParams(hash.slice(1));
    const urlParams  = new URLSearchParams(window.location.search);
    const type       = hashParams.get('type') || urlParams.get('type');
    const code       = urlParams.get('code');

    // PKCE 코드 교환
    if (code) {
      try { await sb.auth.exchangeCodeForSession(code); } catch (e) {}
    }

    const { data: { session } } = await sb.auth.getSession();
    if (session?.user) this._setUser(session.user);

    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        this._setUser(session?.user || null);
        // 이메일 인증 완료 감지
        if ((type === 'signup' || type === 'email' || code) && event === 'SIGNED_IN') {
          setTimeout(() => VerificationModal.show(), 600);
        }
      } else if (event === 'SIGNED_OUT') {
        this._setUser(null);
      }
    });
  },

  _setUser(user) {
    if (user) {
      this.user = {
        id:    user.id,
        email: user.email,
        name:  user.user_metadata?.name || user.email.split('@')[0]
      };
    } else {
      this.user = null;
    }
    this._updateUI();
  },

  openPanel() {
    if (this.user) { Panels.openProfile(); return; }
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
    if (!email || !pw) { Toast.show('이메일과 비밀번호를 입력하세요'); return; }

    const btn = document.getElementById('login-btn');
    if (btn) { btn.disabled = true; btn.textContent = '로그인 중...'; }
    try {
      const res = await API.login(email, pw);
      if (res.error) { Toast.show(res.error); return; }
      Panels.closeAll();
      Toast.show(`환영합니다, ${res.name}! 🚴`);
    } catch { Toast.show('연결 오류가 발생했습니다'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '로그인'; } }
  },

  async signup() {
    const name  = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const pw    = document.getElementById('signup-pw').value;
    if (!name || !email || !pw) { Toast.show('모든 항목을 입력하세요'); return; }
    if (pw.length < 6) { Toast.show('비밀번호는 6자 이상이어야 합니다'); return; }

    const btn = document.getElementById('signup-btn');
    if (btn) { btn.disabled = true; btn.textContent = '처리 중...'; }
    try {
      const res = await API.signup(email, pw, name);
      if (res.error) { Toast.show(res.error); return; }
      Panels.closeAll();
      Toast.show('가입 완료! 인증 이메일을 확인해 주세요 📧');
    } catch { Toast.show('연결 오류가 발생했습니다'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '회원가입'; } }
  },

  async logout() {
    await API.logout();
    Panels.closeAll();
    Toast.show('로그아웃 완료');
  },

  _updateUI() {
    const btn = document.getElementById('auth-btn');
    if (this.user) {
      btn.innerHTML = `<div class="w-7 h-7 bg-green-500 rounded-full flex items-center justify-center text-xs font-black text-white">${(this.user.name?.[0] || '?').toUpperCase()}</div>`;
      btn.title = '내 프로필';
    } else {
      btn.innerHTML = `<svg class="w-4 h-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>`;
      btn.title = '로그인';
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 이벤트 바인딩
// ═══════════════════════════════════════════════════════════════════════════

// 위험 유형 선택
document.querySelectorAll('#report-type-grid .type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#report-type-grid .type-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    Report.selectedType = btn.dataset.type;
  });
});

// 심각도 선택
document.querySelectorAll('#report-severity-grid .type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#report-severity-grid .type-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    Report.selectedSev = btn.dataset.sev;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 앱 초기화
// ═══════════════════════════════════════════════════════════════════════════

// ── [강제 초기화] GPS 관련 캐시 키 원천 삭제 — iOS PWA 고착 방지 ─────────────
const _GPS_CACHE_KEYS = ['saferide_gps_cache', 'saferide_last_pos', 'saferide_location'];
_GPS_CACHE_KEYS.forEach(k => {
  try { localStorage.removeItem(k); } catch(e) {}
  try { sessionStorage.removeItem(k); } catch(e) {}
});

// ═══════════════════════════════════════════════════════════════════════════
// GPS 강제 리셋 — 버튼으로 호출: 캐시 파괴 → SW 재등록 → 강제 리로드
// ═══════════════════════════════════════════════════════════════════════════
async function gpsForceReset() {
  Toast.show('GPS 강제 리셋 중... 잠시 후 재시작됩니다');

  // GPS 추적 정지
  if (GPS.watchId !== null) {
    navigator.geolocation.clearWatch(GPS.watchId);
    GPS.watchId = null;
  }
  GPS.active      = false;
  GPS._gpsLocked  = false;
  GPS.lastPos     = null;
  GPS._setGpsUI('acquiring');

  // 모든 CacheStorage 전면 삭제
  if ('caches' in window) {
    try {
      const cacheKeys = await window.caches.keys();
      await Promise.all(cacheKeys.map(k => window.caches.delete(k)));
    } catch(e) {}
  }

  // GPS 관련 로컬/세션 스토리지 삭제
  _GPS_CACHE_KEYS.forEach(k => {
    try { localStorage.removeItem(k); } catch(e) {}
    try { sessionStorage.removeItem(k); } catch(e) {}
  });

  // 서비스 워커 전체 해제 → 최신 버전으로 재설치
  if ('serviceWorker' in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    } catch(e) {}
  }

  // 완전 강제 리로드 (캐시 무시)
  setTimeout(() => window.location.reload(true), 700);
}

// Service Worker 등록 — updateViaCache:'none' 으로 구버전 SW 캐시 차단 (iOS·Android 공통)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then(reg => {
      // SW 등록 완료 즉시 알림 권한 상태 확인
      // iOS 16.4+ 홈화면 추가 PWA: 권한 granted 이면 잠금화면 배너 즉시 사용 가능
      if ('Notification' in window && Notification.permission === 'default') {
        // 첫 터치(사용자 제스처) 이후에 요청 → iOS 정책 준수
        const _reqOnce = () => {
          Notification.requestPermission().catch(() => {});
          document.removeEventListener('touchstart', _reqOnce, true);
          document.removeEventListener('click',      _reqOnce, true);
        };
        document.addEventListener('touchstart', _reqOnce, { once: true, capture: true, passive: true });
        document.addEventListener('click',      _reqOnce, { once: true, capture: true, passive: true });
      }
    })
    .catch(() => {});

  // TTS 음성 파일 조기 프리페치 — 앱 로드 3초 후 백그라운드 fetch 시작
  // AudioContext 없이 raw MP3 데이터만 확보 → 라이딩 시작 즉시 재생 가능
  setTimeout(() => VoiceAlert.prefetch(), 3000);
}

// ── 지도 인터랙션 감지 — 사용자가 드래그/핀치하면 autoCenter 일시 정지 ──────
map.on('movestart', e => {
  // originalEvent 있으면 사용자 제스처, 없으면 flyTo 등 프로그래매틱 이동
  if (e.originalEvent && !map._locBtnMove) {
    GPS.autoCenter = false;
    LocBtn.updateVisibility();
  }
  map._locBtnMove = false;
});

loadZones();
Settings.load();
Auth.init();
LocBtn.init();
GpsDebug.init();
GPS.startTracking();

// ── iOS 오디오 세션 선제 언락 + TTS 디코딩 ──────────────────────────────────
// 앱 최초 터치(사용자 제스처) 시 AudioContext 언락 → 이후 화면 잠금에 대비
// unlock() 내부에서 VoiceAlert.decodeAll() 이 자동 호출되어 음성 재생 준비 완료
// 라이딩 시작 버튼에서도 다시 호출 → 이중 보장
const _onFirstGesture = () => SilentAudioLoop.unlock();
document.addEventListener('touchstart', _onFirstGesture, { once: true, capture: true, passive: true });
document.addEventListener('click',      _onFirstGesture, { once: true, capture: true, passive: true });
