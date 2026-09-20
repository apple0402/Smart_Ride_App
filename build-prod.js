// 정식 배포용 산출물을 dist/public 에 만든다: public/ 전체를 복사한 뒤 JS만 압축 + console.* 제거.
// 개발용 public/ 원본은 절대 건드리지 않는다 — 네이티브 싱크(cap:sync)는 그대로 public/ 을 사용한다.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, 'public');
const OUT = path.join(__dirname, 'dist', 'public');

// 개인정보 처리방침 URL 미설정 경고 — 빈 값으로 배포되면 설정 화면 링크가 동작하지 않는다.
// (배포를 강제로 막으려면 아래 process.exit(1) 주석을 해제하세요.)
{
  const appJsSrc = fs.readFileSync(path.join(SRC, 'js', 'app.js'), 'utf8');
  if (/const\s+PRIVACY_POLICY_URL\s*=\s*(['"])\s*\1/.test(appJsSrc)) {
    console.warn('\n⚠️  [build-prod] PRIVACY_POLICY_URL 이 비어 있습니다 — 개인정보 처리방침 링크가 동작하지 않습니다.');
    console.warn('    public/js/app.js 의 PRIVACY_POLICY_URL 을 실제 주소로 채운 뒤 다시 빌드하세요.\n');
    // process.exit(1);
  }
}

fs.rmSync(path.join(__dirname, 'dist'), { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });

function walkJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkJsFiles(full));
    else if (entry.name.endsWith('.js')) results.push(full);
  }
  return results;
}

const jsFiles = walkJsFiles(OUT);
for (const file of jsFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const result = esbuild.transformSync(src, {
    minify: true,
    drop: ['console', 'debugger'],
    target: 'es2017',
    loader: 'js'
  });
  fs.writeFileSync(file, result.code);
}

console.log(`[build-prod] ${jsFiles.length}개 JS 파일 압축 완료 → ${path.relative(__dirname, OUT)}`);
