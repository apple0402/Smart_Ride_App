// ═══════════════════════════════════════════════════════════════════════════
// Safe Ride — Service Worker v17
// v17: playback 모드 완전 제거 | 미디어 위젯 박멸 | transient 덕킹만 사용
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'safe-ride-v17';
const PRECACHE   = ['/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── SW 백그라운드 구역 감지 상태 ────────────────────────────────────────────
let _swZones       = [];   // 앱에서 전달받은 위험 구역 목록
let _swAlertedsSet = new Set(); // 60초 중복 방지

const _SW_ZONE_ICONS   = { pothole: '🕳️', slippery: '🧼', construction: '🚧', other: '⚠️' };
const _SW_ZONE_KOREAN  = { pothole: '포트홀 / 크랙', slippery: '맨홀 / 미끄러움', construction: '도로 / 보도 공사', other: '기타 위험' };

function _swHaversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function _swCheckZones(lat, lng) {
  if (!_swZones.length) return;
  _swZones.forEach(z => {
    const d = _swHaversine(lat, lng, z.lat, z.lng);
    if (d <= 50 && !_swAlertedsSet.has(z.id)) {
      _swAlertedsSet.add(z.id);
      setTimeout(() => _swAlertedsSet.delete(z.id), 60000);
      self.registration.showNotification('⚠️ Safe Ride 위험 구역 감지!', {
        body:               `${_SW_ZONE_ICONS[z.type]||'⚠️'} ${_SW_ZONE_KOREAN[z.type]||z.title} 50m 전입니다. 서행하세요!`,
        icon:               '/icons/icon-192.png',
        badge:              '/icons/icon-192.png',
        vibrate:            [500, 200, 500, 200, 800],
        tag:                'danger-zone',
        renotify:           true,
        requireInteraction: true,
        silent:             false,
        timestamp:          Date.now(),
        data:               { url: '/', zoneType: z.type || 'other' }
      });
    }
  });
}

// ── 위험 알림 수신 → OS 잠금화면 알림 강제 발행 ─────────────────────────────
// ● event.waitUntil: showNotification 완료 전 SW 조기 종료 방지 (iOS·Android 공통)
// ● iOS 16.4+ 홈화면 추가 PWA: showNotification이 잠금화면 배너를 즉시 표시
// ● silent:false 강제 — iOS가 무음 처리하지 않도록
self.addEventListener('message', event => {
  const data = event.data;
  if (!data) return;

  // 앱에서 구역 데이터 수신 — SW 백그라운드 감지용 캐시
  if (data.type === 'ZONES_DATA') {
    _swZones = data.zones || [];
    return;
  }

  // 앱 백그라운드 시 GPS 좌표 수신 → SW에서 구역 직접 감지 (이중 보장)
  if (data.type === 'GPS_POSITION') {
    event.waitUntil(Promise.resolve(_swCheckZones(data.lat, data.lng)));
    return;
  }

  if (data.type === 'DANGER_ZONE_ALERT') {
    const { title, body, icon } = data;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon:               icon || '/icons/icon-192.png',
        badge:              '/icons/icon-192.png',
        vibrate:            [500, 200, 500, 200, 800],
        tag:                'danger-zone',
        renotify:           true,
        requireInteraction: true,
        silent:             false,
        timestamp:          Date.now(),
        data:               { url: '/', zoneType: data.zoneType || 'other' },
        // actions: Android Chrome 지원 / iOS Safari 무시 (에러 없음)
        actions: [
          { action: 'ack',  title: '확인' },
          { action: 'open', title: '앱 열기' }
        ]
      })
    );
  } else if (data.type === 'DANGER_ZONE_EXIT') {
    const { title, body, icon } = data;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon:               icon || '/icons/icon-192.png',
        badge:              '/icons/icon-192.png',
        vibrate:            [200, 100, 200],
        tag:                'danger-zone-exit',
        renotify:           true,
        requireInteraction: false,
        silent:             false,
        timestamp:          Date.now()
      })
    );
  }
});

// ── 알림 클릭 처리 ──────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'ack') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      if (clientList.length > 0) return clientList[0].focus();
      return clients.openWindow('/');
    })
  );
});

// ── 네트워크 / 캐시 전략 ────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 외부 CDN·API는 SW에서 처리하지 않음
  const externalHosts = ['supabase.co', 'nominatim.openstreetmap.org',
    'cartocdn.com', 'unpkg.com', 'cdn.jsdelivr.net', 'tailwindcss.com',
    'translate.google.com'];
  if (externalHosts.some(h => url.hostname.includes(h))) return;

  // JS · HTML · JSON(manifest) — 항상 네트워크 직접 요청 (캐시 금지)
  const noCache = url.pathname.endsWith('.js')
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('.json')
    || url.pathname === '/';

  if (noCache) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  // 아이콘·WAV — 캐시 우선, 없으면 네트워크
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
