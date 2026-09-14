// 빌드/배포 시점에 환경변수(CARTO_API_KEY, ALLOWED_ORIGINS)로 public/js/config.js를 생성한다.
// 결과 파일(public/js/config.js)은 실제 키를 담기 때문에 git에 커밋하지 않는다 — .gitignore 참고.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const cartoApiKey = process.env.CARTO_API_KEY || '';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const output = `// 자동 생성 파일 — 직접 수정하지 말 것 (node generate-config.js 로 재생성)
// CARTO_API_KEY는 아래 오리진 화이트리스트를 통과한 브라우저/네이티브 앱에만 내려간다.
// 단, 이건 최소 방어층일 뿐이다 — 실제 도용 차단은 CARTO 대시보드의 도메인 제한이 맡는다.
// (context-notes.md의 "CARTO API Key 방어" 절 참고)
(function () {
  var ALLOWED_ORIGINS = ${JSON.stringify(allowedOrigins)};
  var origin = (typeof location !== 'undefined') ? location.origin : '';
  var isNativeApp = (typeof location !== 'undefined') &&
    ['capacitor:', 'ionic:', 'file:'].indexOf(location.protocol) !== -1;
  var isAllowed = isNativeApp || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.indexOf(origin) !== -1;

  window.__SAFE_RIDE_ENV__ = {
    CARTO_API_KEY: isAllowed ? ${JSON.stringify(cartoApiKey)} : ''
  };
})();
`;

fs.writeFileSync(path.join(__dirname, 'public', 'js', 'config.js'), output);
console.log(
  `[generate-config] public/js/config.js 생성 완료 (허용 오리진: ${
    allowedOrigins.length ? allowedOrigins.join(', ') : '미설정 — 전체 허용'
  })`
);
