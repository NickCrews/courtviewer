const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const DIST = path.join(__dirname, 'dist');
const RELEASE_DIR = path.join(__dirname, 'release');

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Build steps ──────────────────────────────────────────────────────────────

console.log('Building Alaska Court Viewer extension...');

// 1. Copy manifest.json to dist/
copyFile(
  path.join(__dirname, 'manifest.json'),
  path.join(DIST, 'manifest.json')
);
console.log('  Copied manifest.json');

// 2. Copy popup HTML and CSS to dist/popup/
copyFile(
  path.join(__dirname, 'src', 'popup', 'popup.html'),
  path.join(DIST, 'popup', 'popup.html')
);
copyFile(
  path.join(__dirname, 'src', 'popup', 'popup.css'),
  path.join(DIST, 'popup', 'popup.css')
);
console.log('  Copied popup assets');

// 3. Copy assets/ to dist/assets/
copyDirRecursive(
  path.join(__dirname, 'assets'),
  path.join(DIST, 'assets')
);
console.log('  Copied assets');

console.log('Build complete.');

// ── Bundle for Chrome Web Store ──────────────────────────────────────────

function bundleForRelease() {
  ensureDir(RELEASE_DIR);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const version = pkgJson.version;
  const zipPath = path.join(RELEASE_DIR, `alaska-court-viewer-${version}.zip`);

  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      console.log(`Extension bundled: ${zipPath} (${archive.pointer()} bytes)`);
      resolve();
    });
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(DIST + '/', false);
    archive.finalize();
  });
}

if (process.argv[2] === 'bundle') {
  bundleForRelease().catch(err => {
    console.error('Bundle failed:', err);
    process.exit(1);
  });
}
