// ═══════════════════════════════════════════════════════════════════════════
// Safe Ride — Service Worker v14
// v14: TTS 오디오 캐싱 | 알림 iOS 강화 | sendSwMessage ready-only 대응
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'safe-ride-v14';
const PRECACHE   = ['/icons/icon-192.png', '/icons/icon-512.png', '/assets/silent.wav'];

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
// ● event.waitUntil: showNotification 완료 전 SW 조기 종료 방지 (iOS·Android 공통)
// ● iOS 16.4+ 홈화면 추가 PWA: showNotification이 잠금화면 배너를 즉시 표시
// ● silent:false 강제 — iOS가 무음 처리하지 않도록
self.addEventListener('message', event => {
  const data = event.data;
  if (!data) return;

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

  // ── TTS 오디오: 캐시 우선 → 없으면 네트워크 후 캐시 저장 (7일 재사용) ──
  // 화면 꺼짐 후 음성 재생 시 네트워크 없이도 즉시 재생 가능
  if (url.pathname === '/api/tts') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const response = await fetch(event.request);
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        } catch {
          return new Response('', { status: 503, statusText: 'TTS offline' });
        }
      })
    );
    return;
  }

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
