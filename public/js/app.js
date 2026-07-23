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
let _alertTimeout     = null; // 경고 배너 자동 소멸 타이머 (구역 이탈/속도 초과 공용)
const _voteTimers     = new Map(); // zoneId -> timeoutId — 구역별 이탈→투표 팝업 표시 시퀀스.
                                    // 반드시 zoneId로 분리 관리할 것: 전역 변수 하나로 공유하면
                                    // 다른 구역을 연이어 이탈할 때 앞선 구역의 타이머가 clearTimeout으로
                                    // 취소되어 투표창이 아예 뜨지 않는(증발) 버그가 발생함.

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
// NativeTTS — @capacitor-community/text-to-speech 브릿지
// iOS: AVSpeechSynthesizer → 잠금화면·백그라운드에서도 네이티브 음성 안내 동작
// 폴백: Capacitor 없는 환경(웹 브라우저)에서는 speechSynthesis 사용
// ═══════════════════════════════════════════════════════════════════════════
const NativeTTS = {
  MESSAGES: {
    pothole:      '도로 파손, 단차 충격 주의!!',
    slippery:     '맨홀 미끄럼 주의!!',
    construction: '공사 중!! 서행 하세요!!',
    other:        '위험 구역 주의하세요'
  },

  getZoneMessage(zone) {
    if (zone.type === 'other') return zone.desc || zone.title || this.MESSAGES.other;
    return this.MESSAGES[zone.type] || `${ZONE_KOREAN[zone.type] || zone.title} 주의하세요`;
  },

  async speak(text, startDelay = 0) {
    if (!Settings.get().ttsEnabled) return;
    const doSpeak = async () => {
      if (window.CapBridge?.TextToSpeech) {
        try {
          await window.CapBridge.TextToSpeech.speak({ text, lang: 'ko-KR', rate: 0.9, volume: 1.0 });
          return;
        } catch (e) {}
      }
      // 웹 폴백 — 잠금화면에서는 iOS가 차단하므로 화면 켜짐 상태에서만 실행
      if (document.hidden && Platform.isIOS) return;
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR'; u.rate = 0.9; u.volume = 1.0;
      const kor = window.speechSynthesis.getVoices().find(v => v.lang.startsWith('ko'));
      if (kor) u.voice = kor;
      window.speechSynthesis.speak(u);
    };
    if (startDelay > 0) setTimeout(doSpeak, startDelay * 1000);
    else await doSpeak();
  }
};

// 하위 호환 래퍼
const TTS = {
  speak(text)       { NativeTTS.speak(text); },
  getZoneMessage(z) { return NativeTTS.getZoneMessage(z); }
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
// NativeAudio — @capacitor-community/native-audio 브릿지
// iOS: AVAudioPlayer → 잠금화면·백그라운드에서도 네이티브 경고음 재생
// public/sounds/beep_*.wav 파일을 앱 시작 시 미리 로드 (preload)
// ═══════════════════════════════════════════════════════════════════════════
const NativeAudio = {
  _TYPES: ['pothole', 'slippery', 'construction', 'other'],
  _loaded: false,

  async preload() {
    if (!window.CapBridge?.NativeAudio) return;
    await Promise.allSettled(this._TYPES.map(type =>
      window.CapBridge.NativeAudio.preload({
        assetId:        `beep_${type}`,
        assetPath:      `sounds/beep_${type}.wav`,
        audioChannelNum: 1,
        isUrl:           false,
        volume:          1.0,
      })
    ));
    this._loaded = true;
  },

  async play(zoneType) {
    if (!window.CapBridge?.NativeAudio) return;
    const id = `beep_${this._TYPES.includes(zoneType) ? zoneType : 'other'}`;
    try { await window.CapBridge.NativeAudio.play({ assetId: id }); } catch (e) {}
  }
};

function playAlertSound() { NativeAudio.play('other'); }

// ── Service Worker 메시지 공통 발행 헬퍼 ────────────────────────────────────
// [iOS 잠금화면 알림 누락 버그 수정 v2]
// controller.postMessage()는 await 없는 동기 호출 → iOS 백그라운드 짧은 실행 창에서도 즉시 전달
// 기존 ready+2초 타임아웃은 iOS 백그라운드에서 Promise 미소태스크 지연으로 타임아웃 빈번 발생
// ● 빠른 경로(Fast path): navigator.serviceWorker.controller — Promise 없음, 즉시 동기 postMessage
// ● 느린 경로(Fallback): 최초 설치 직후 controller가 null인 경우에만 ready 경유 (타임아웃 5초)
async function sendSwMessage(data) {
  if (!('serviceWorker' in navigator)) return;
  try {
    // Fast path: controller는 SW 활성화 후 항상 유효 → await 없이 즉시 전달
    const ctrl = navigator.serviceWorker.controller;
    if (ctrl) { ctrl.postMessage(data); return; }
    // Fallback: 최초 설치 시만 실행 (controller가 아직 null인 경우)
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(), 5000))
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
    // SW 백그라운드 감지용: 구역 데이터를 Service Worker에 전달
    sendSwMessage({
      type:  'ZONES_DATA',
      zones: allZones.map(z => ({ id: z.id, lat: z.lat, lng: z.lng, type: z.type, title: z.title }))
    });
    // 네이티브 단에 최신 구역 데이터 항상 동기화 — Ride 시작 전에도 로드해 두어야
    // 화면 잠금 직후 Swift가 즉시 거리 계산을 시작할 수 있음
    if (Platform.isIOS && window.CapBridge?.BackgroundSafety) {
      const alertDist = Settings.get().alertDistance;
      window.CapBridge.BackgroundSafety.setZones({
        zones:    allZones.map(z => ({ id: z.id, lat: z.lat, lng: z.lng, type: z.type, alertDist })),
        alertDist
      }).catch(() => {});
    }
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

// ── GPS 좌표 차이로 진행 방향(베어링) 계산 ────────────────────────────────────
// 나침반/deviceorientation 의존 없이 이전·현재 GPS 좌표 사이의 방위각을 계산.
// 자전거 진동으로 인한 나침반 오차를 원천 차단 — 최소 1m 이동 시에만 갱신.
function gpsCoordBearing(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLng  = toRad(lng2 - lng1);
  const φ1    = toRad(lat1);
  const φ2    = toRad(lat2);
  const x     = Math.sin(dLng) * Math.cos(φ2);
  const y     = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

// ── 원형 평균(Circular Mean) — 헤딩 이동 평균 필터용 ─────────────────────────
// 일반 산술 평균 시 350°·10° 평균이 180°로 오계산되는 문제 해결 (사인·코사인 분해)
function circularMean(angles) {
  if (!angles.length) return 0;
  let sinSum = 0, cosSum = 0;
  for (const a of angles) {
    sinSum += Math.sin(a * Math.PI / 180);
    cosSum += Math.cos(a * Math.PI / 180);
  }
  return (Math.atan2(sinSum, cosSum) * 180 / Math.PI + 360) % 360;
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

      // 마커 통과 3초 후 경고 배너 소멸 → 소멸 1.5초 후 투표 팝업 표시
      clearTimeout(_alertTimeout);
      _alertTimeout = setTimeout(() => Alert.dismiss(), 3000);

      // 투표 팝업 예약은 구역별(zoneId) 타이머로 독립 관리 — 다른 구역의 진입/이탈이
      // 이 구역의 예약을 취소하지 않도록 함
      clearTimeout(_voteTimers.get(z.id));
      const voteTimerId = setTimeout(() => {
        _voteTimers.delete(z.id);
        // 투표 팝업: 라이딩 중이면 alertsEnabled 설정과 무관하게 무조건 표시
        if (Ride.active) {
          const alreadyVoted = Auth.user
            ? (Array.isArray(z.safeVoterIds) && z.safeVoterIds.includes(Auth.user.id))
            : false;
          if (!alreadyVoted) VotePopup.show(z);
        }
      }, 4500);
      _voteTimers.set(z.id, voteTimerId);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GPS 디버그 패널 — 야외 테스트용: 좌측 하단에 실시간 좌표·상태 출력
// ═══════════════════════════════════════════════════════════════════════════
const GpsDebug = {
  _el: null,

  init() { this._el = document.getElementById('gps-info-text'); },

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

    // GPS 미수신 시 SOS 버튼 반투명 처리 — 위치 없으면 전송 불가 상태를 시각적으로 표시
    const sosBtn = document.getElementById('sos-btn');
    if (sosBtn && !sosBtn.disabled) {
      const ready = (state === 'on' && lat != null);
      sosBtn.style.opacity = ready ? '1' : '0.45';
      sosBtn.style.filter  = ready ? '' : 'grayscale(0.4)';
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// SOS 모듈 — 원클릭 위급 상황 구조 요청
// Web Share API → 카카오톡·SMS·119 등으로 실시간 GPS 좌표 즉시 전파
// + Supabase emergency_logs 테이블에 사고 순간 위치 자동 저장 (관제 연동용)
// ═══════════════════════════════════════════════════════════════════════════
const SOS = {
  async trigger() {
    const pos = GPS.lastPos;
    if (!pos) {
      // GPS 미수신 — 진동으로 실패 피드백
      if (navigator.vibrate) navigator.vibrate([100, 60, 100]);
      Toast.show('GPS 위치 수신 전입니다. 잠시 후 다시 시도해 주세요.');
      return;
    }

    const btn = document.getElementById('sos-btn');
    if (btn) { btn.textContent = '🚨 전송 중...'; btn.disabled = true; btn.classList.add('sending'); }

    // SOS 터치 즉각 확인 진동 — 사고 충격 상황에서도 버튼이 눌렸음을 체감으로 확인
    if (navigator.vibrate) navigator.vibrate([200, 80, 200, 80, 600]);

    try {
      const address = await getAddress(pos.lat, pos.lng);
      const mapUrl  = `https://www.google.com/maps?q=${pos.lat},${pos.lng}`;
      const shareText = [
        '[Safe Ride 위급 상황 구조 요청]',
        '도움이 필요합니다! 현재 저의 실시간 위치 정보입니다.',
        `- 현재 주소: ${address}`,
        `- 상세 좌표: 위도 ${pos.lat.toFixed(5)}, 경도 ${pos.lng.toFixed(5)}`,
        `- 지도 링크: ${mapUrl}`
      ].join('\n');

      // DB 저장 — 공유와 병렬 실행, 실패해도 공유는 계속 진행
      API.logEmergency({ lat: pos.lat, lng: pos.lng, address }).catch(() => {});

      if (navigator.share) {
        await navigator.share({ title: '🚨 Safe Ride 위급 상황 구조 요청', text: shareText });
        // navigator.share가 resolve = 사용자가 전송 대상 선택 완료
        Toast.show('구조 요청 전송 완료! 위치 정보가 저장됐습니다.');
      } else {
        // 폴백: 클립보드 복사 (PC·Web Share 미지원 환경)
        await navigator.clipboard.writeText(shareText).catch(() => {});
        Toast.show('위치 정보가 클립보드에 복사됐습니다. 카카오톡·문자에 붙여넣기 후 전송하세요.');
      }
    } catch (e) {
      // AbortError = 사용자가 공유 시트에서 취소 → 정상 흐름, 에러 토스트 생략
      if (e?.name !== 'AbortError') {
        Toast.show('전송 실패 — 직접 119(긴급)에 연락하세요.');
      }
    } finally {
      if (btn) { btn.textContent = '🚨 SOS 구조 요청'; btn.disabled = false; btn.classList.remove('sending'); }
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GPS 모듈 — iOS PWA 전용 폴백 + 강제 트리거 + 워치독 포함
// ═══════════════════════════════════════════════════════════════════════════
const GPS = {
  watchId:           null,
  lastPos:           null,
  active:            false,
  autoCenter:        true,
  accuracyCircle:    null,
  speedBuffer:       [],
  _gpsLocked:        false,
  _hasPanned:        false,
  _prevPos:          null,
  _lastHeading:      null,
  _retryCount:       0,       // 연속 재시도 횟수 (5회 초과 시 권한 안내로 전환)
  _watchdogTimer:    null,    // 응답 없음 감시 타이머
  // ── 헤딩 스무딩 (이동 평균 + LERP 애니메이션) ──
  _headingBuffer:    [],      // 원형 이동 평균 버퍼 (최대 5개)
  _targetBearing:    0,       // 목표 방향각 (이동 평균 결과)
  _currentBearing:   0,       // 현재 표시 방향각 (LERP 중간값)
  _bearingAnimFrame: null,    // requestAnimationFrame 핸들

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
    // 베어링 애니메이션 정리
    if (this._bearingAnimFrame) { cancelAnimationFrame(this._bearingAnimFrame); this._bearingAnimFrame = null; }
    this._headingBuffer  = [];
    this._currentBearing = 0;
    this._targetBearing  = 0;
    this._setGpsUI('off');
    GpsDebug.update('off');
  },

  onPosition(pos) {
    const { latitude: lat, longitude: lng, speed, accuracy, heading } = pos.coords;
    const kmh = speed != null ? Math.round(speed * 3.6) : null;

    // GPS 좌표 차이 베어링을 우선 사용 (나침반 의존 제거 — 자전거 진동 오차 방지).
    // 직전 좌표가 있고 실제 이동(≥1m)이 발생했을 때만 갱신.
    if (this._prevPos) {
      const moved = haversine(this._prevPos.lat, this._prevPos.lng, lat, lng);
      if (moved >= 1) {
        this._lastHeading = gpsCoordBearing(this._prevPos.lat, this._prevPos.lng, lat, lng);
      }
    } else if (heading != null && !isNaN(heading)) {
      // 첫 수신 시에는 기기 heading을 초기값으로 사용
      this._lastHeading = heading;
    }

    // 화면 잠금 상태에서는 SW에도 좌표 전달 — SW 백그라운드 구역 감지 이중 보장
    if (document.hidden) {
      sendSwMessage({ type: 'GPS_POSITION', lat, lng });
    }
    this._applyPosition(lat, lng, kmh, accuracy);
  },

  _applyPosition(lat, lng, rawKmh, accuracy) {
    // GPS 첫 수신 시 마커 생성 (하드코딩 기본 위치 없음)
    if (!riderMarker) {
      riderMarker = L.marker([lat, lng], { icon: riderIcon, zIndexOffset: 10000 }).addTo(map);
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

    // 헤드업 지도 회전 — GPS 좌표 베어링 + 이동 평균 필터 + LERP 애니메이션
    // 시속 3km/h 이하(정지·정차)일 때는 베어링 갱신을 건너뛰어 마지막 회전각을 유지(Lock) — 제자리 회전 방지
    if (Ride.active && this._lastHeading != null && (rawKmh == null || rawKmh > 3)) {
      if (map.setBearing) {
        // 이동 평균 버퍼에 추가 (최근 5개로 원형 평균 — GPS 튐 완화)
        this._headingBuffer.push(this._lastHeading);
        if (this._headingBuffer.length > 5) this._headingBuffer.shift();
        this._targetBearing = circularMean(this._headingBuffer);
        this._startBearingAnim();
      }
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

  // ── 지도 베어링 LERP 애니메이션 (차량용 내비게이션 스타일 부드러운 회전) ────
  // requestAnimationFrame 루프로 _currentBearing → _targetBearing 를 매 프레임 12% 보간
  // 60fps 기준: 0.5초 이내에 목표 방향에 95% 수렴 — GPS 끊김 없이 물 흐르듯 회전
  _startBearingAnim() {
    if (this._bearingAnimFrame || !map.setBearing) return;
    const step = () => {
      // 최단 경로 회전: 180° 기준으로 시계/반시계 결정 (350°→10° 문제 해결)
      const diff = ((this._targetBearing - this._currentBearing + 540) % 360) - 180;
      if (Math.abs(diff) < 0.3) {
        this._currentBearing = this._targetBearing;
        map.setBearing(this._currentBearing);
        this._bearingAnimFrame = null;
        return;
      }
      // LERP factor 0.12: 빠른 응답 + 과도한 진동 억제 균형
      this._currentBearing = (this._currentBearing + diff * 0.12 + 360) % 360;
      map.setBearing(this._currentBearing);
      this._bearingAnimFrame = requestAnimationFrame(step);
    };
    this._bearingAnimFrame = requestAnimationFrame(step);
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

    // 네이티브 경고음 WAV 프리로드 (첫 경고 시 지연 없이 즉시 재생)
    NativeAudio.preload().catch(() => {});

    // 네이티브 백그라운드 위치 추적 시작 (iOS 화면 잠금 시 JS 정지 대응)
    if (Platform.isIOS && window.CapBridge?.BackgroundSafety) {
      const alertDist = Settings.get().alertDistance;
      window.CapBridge.BackgroundSafety.startBackgroundTracking({
        zones:    allZones.map(z => ({ id: z.id, lat: z.lat, lng: z.lng, type: z.type, alertDist })),
        alertDist,
        backgroundRequested:                  true,
        stale:                                false,
        distanceFilter:                       1,
        desiredAccuracy:                      2,
        pausesLocationUpdatesAutomatically:   false,
        showsBackgroundLocationIndicator:     true,
      }).catch(() => {});
    }

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

    // 네이티브 백그라운드 위치 추적 중단
    if (Platform.isIOS && window.CapBridge?.BackgroundSafety) {
      window.CapBridge.BackgroundSafety.stopBackgroundTracking({}).catch(() => {});
    }

    // 지도 베어링 리셋 (북쪽 위) + LERP 애니메이션 취소
    if (GPS._bearingAnimFrame) { cancelAnimationFrame(GPS._bearingAnimFrame); GPS._bearingAnimFrame = null; }
    GPS._headingBuffer = []; GPS._currentBearing = 0; GPS._targetBearing = 0;
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
        // 주행 거리 포인트 (+5pt/10km) + total_distance 갱신
        // distKm > 0 조건: 거리 누적은 포인트 여부와 무관하게 항상 업데이트
        // 버그 수정: ptFromDist > 0 조건이면 10km 미만 라이딩은 total_distance가 전혀 갱신 안 됨
        const distKm = this.distance / 1000;
        const ptFromDist = Math.floor(distKm / 10) * 5;
        if (distKm > 0 && Auth.user) {
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

// 백그라운드 전환 시 타이머 처리 + iOS GPS 재시작
document.addEventListener('visibilitychange', () => {
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
// Alert 모듈 — 최소 UI, 구역 이탈 3초 후 자동 소멸(checkProximity 제어), TTS + 진동 + 음향 동시
//
// 오디오 흐름:
//   show() → NativeAudio(AVAudioPlayer) 경고음 + NativeTTS(AVSpeechSynthesizer) 음성
//   dismiss() → 배너 제거
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

    // 배너 소멸은 고정 타이머가 아닌 구역 이탈(통과) 시점 기준 — checkProximity()의 3초/1.5초 흐름이 담당
    // 주의: 예약된 투표 팝업(_voteTimers)은 여기서 취소하지 않음 — 새 구역에 진입했다고
    // 방금 지나온 구역의 투표창 예약까지 함께 사라지면 안 되기 때문 (증발 버그 원인이었음)
    clearTimeout(_alertTimeout);

    if (Ride.active) Ride.passedZones.push(zone.id);

    // 강화 진동 — 화면 꺼짐 상태에서도 navigator.vibrate 는 동작
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 800]);

    // 오디오·TTS는 BackgroundSafetyPlugin(Swift)이 화면 잠금 여부 무관하게 직접 처리
    // — 포그라운드/백그라운드 이중 재생 방지를 위해 JS 레이어에서는 오디오 호출 제거
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
        // 잠금화면 Live Activity 투표 버튼이 Supabase에 직접 접근할 수 있도록 토큰을 네이티브 Keychain에 동기화
        if (session?.access_token && session.user) {
          window.CapBridge?.BackgroundSafety?.syncAuthSession({
            accessToken: session.access_token,
            userId: session.user.id
          }).catch(() => {});
        }
        // 이메일 인증 완료 감지
        if ((type === 'signup' || type === 'email' || code) && event === 'SIGNED_IN') {
          setTimeout(() => VerificationModal.show(), 600);
        }
      } else if (event === 'SIGNED_OUT') {
        this._setUser(null);
        window.CapBridge?.BackgroundSafety?.clearAuthSession().catch(() => {});
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

// iOS 네이티브 GPS 브릿지 — 화면 잠금/백그라운드 시(document.hidden) navigator.geolocation이 멈추므로
// 네이티브 CoreLocation이 받은 좌표+진행방향(course)을 대신 주입해 지도 헤드업 회전·마커 위치를 이어감.
// 포그라운드에서는 기존 navigator.geolocation watchPosition을 단일 소스로 유지해 거리 중복 집계 방지.
if (Platform.isIOS && window.CapBridge?.BackgroundSafety) {
  // 백그라운드 GPS → 지도·헤딩 업데이트 (화면 잠금 중 navigator.geolocation 정지 대응)
  window.CapBridge.BackgroundSafety.addListener('locationUpdate', data => {
    if (!document.hidden) return;
    GPS.onPosition({
      coords: {
        latitude: data.lat, longitude: data.lng,
        speed: data.speed ?? null, accuracy: data.accuracy ?? null,
        heading: data.course ?? null,
      }
    });
  });

  // Swift 네이티브가 구역 이탈 감지 → 포그라운드 복귀 시 VotePopup 표시
  // 화면 잠금 중 이탈이 발생한 경우, 알림 탭 외 경로로 앱이 복귀했을 때의 폴백
  window.CapBridge.BackgroundSafety.addListener('backgroundZoneExit', data => {
    if (!Ride.active) return;
    const { zoneId } = data;
    // 이미 JS checkProximity가 처리한 구역(enteredZones에서 제거된)은 중복 표시 방지
    if (enteredZones.has(zoneId)) return;
    const zone = allZones.find(z => z.id === zoneId);
    if (!zone) return;
    const alreadyVoted = Auth.user
      ? (Array.isArray(zone.safeVoterIds) && zone.safeVoterIds.includes(Auth.user.id))
      : false;
    if (!alreadyVoted) VotePopup.show(zone);
  });

}

