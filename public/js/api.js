// API 통신 모듈 — 모든 fetch 호출은 여기서 관리
const API_BASE = window.location.origin + '/api';

const API = {
  async getZones() {
    const r = await fetch(`${API_BASE}/zones`);
    return r.json();
  },

  async getNearbyZones(lat, lng, radius = 500) {
    const r = await fetch(`${API_BASE}/zones/nearby?lat=${lat}&lng=${lng}&radius=${radius}`);
    return r.json();
  },

  async reportHazard(data) {
    const r = await fetch(`${API_BASE}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return r.json();
  },

  async saveRide(data) {
    const r = await fetch(`${API_BASE}/rides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return r.json();
  },

  async getRides() {
    const r = await fetch(`${API_BASE}/rides`);
    return r.json();
  },

  async signup(email, password, name) {
    const r = await fetch(`${API_BASE}/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    });
    return r.json();
  },

  async login(email, password) {
    const r = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    return r.json();
  },

  async getMe(token) {
    const r = await fetch(`${API_BASE}/auth/me`, { headers: { 'Authorization': `Bearer ${token}` } });
    return r.json();
  },

  async clearZone(zoneId) {
    const r = await fetch(`${API_BASE}/zones/${zoneId}`, { method: 'DELETE' });
    return r.json();
  }
};
