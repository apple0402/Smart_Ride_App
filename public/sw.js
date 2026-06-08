// ═══════════════════════════════════════════════════════════════════════════
// Safe Ride — Service Worker v11
// v11: requireInteraction 잠금화면 유지 + silent.wav 프리캐시 + 알림 액션
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'safe-ride-v11';
// silent.wav 프리캐시 포함 — SW 설치 즉시 오프라인에서도 무음 루프 사용 가능
const PRECACHE = ['/icons/icon-192.png', '/icons/icon-512.png', '/assets/silent.wav'];

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

// ── 위험 알림 수신 → OS 잠금화면 알림 강제 발행 ─────────────────────────────
self.addEventListener('message', event => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'DANGER_ZONE_ALERT') {
    const { title, body, icon } = data;
    self.registration.showNotification(title, {
      body,
      icon:               icon || '/icons/icon-192.png',
      badge:              '/icons/icon-192.png',
      // iOS는 vibrate 옵션 무시 — 진동은 메인 스레드 navigator.vibrate() 로 처리
      vibrate:            [500, 200, 500, 200, 800],
      tag:                'danger-zone',
      renotify:           true,
      // requireInteraction: true — 사용자가 직접 닫기 전까지 잠금화면에 상주
      requireInteraction: true,
      silent:             false,
      data:               { url: '/', zoneType: data.zoneType || 'other' },
      actions: [
        { action: 'ack',  title: '확인' },
        { action: 'open', title: '앱 열기' }
      ]
    });
  } else if (data.type === 'DANGER_ZONE_EXIT') {
    const { title, body, icon } = data;
    self.registration.showNotification(title, {
      body,
      icon:               icon || '/icons/icon-192.png',
      badge:              '/icons/icon-192.png',
      vibrate:            [200, 100, 200],
      tag:                'danger-zone-exit',
      renotify:           true,
      requireInteraction: false,
      silent:             false
    });
  }
});

// ── 알림 클릭 처리 ──────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'ack') return; // '확인' 클릭은 앱 전환 없이 닫기만
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      if (clientList.length > 0) return clientList[0].focus();
      return clients.openWindow('/');
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 외부 CDN·API는 SW에서 처리하지 않음
  const externalHosts = ['supabase.co', 'nominatim.openstreetmap.org',
    'cartocdn.com', 'unpkg.com', 'cdn.jsdelivr.net', 'tailwindcss.com'];
  if (externalHosts.some(h => url.hostname.includes(h))) return;

  // JS · HTML · JSON(manifest) — 항상 네트워크 직접 요청
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
