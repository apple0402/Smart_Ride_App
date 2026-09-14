// 정식 배포용 산출물을 dist/public 에 만든다: public/ 전체를 복사한 뒤 JS만 압축 + console.* 제거.
// 개발용 public/ 원본은 절대 건드리지 않는다 — 네이티브 싱크(cap:sync)는 그대로 public/ 을 사용한다.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, 'public');
const OUT = path.join(__dirname, 'dist', 'public');

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
