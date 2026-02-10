const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
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

// ── CRC32 (needed for PNG chunks) ────────────────────────────────────────────

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Minimal PNG generation ───────────────────────────────────────────────────

function createPngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBytes, data]);
  const crcValue = Buffer.alloc(4);
  crcValue.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([length, typeBytes, data, crcValue]);
}

function generatePng(size, r, g, b) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk: width, height, bit depth (8), color type (2 = RGB)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);   // width
  ihdrData.writeUInt32BE(size, 4);   // height
  ihdrData[8] = 8;                   // bit depth
  ihdrData[9] = 2;                   // color type: RGB
  ihdrData[10] = 0;                  // compression
  ihdrData[11] = 0;                  // filter
  ihdrData[12] = 0;                  // interlace
  const ihdr = createPngChunk('IHDR', ihdrData);

  // Raw image data: each row has a filter byte (0) followed by RGB pixels
  const rowSize = 1 + size * 3;
  const rawData = Buffer.alloc(rowSize * size);
  for (let y = 0; y < size; y++) {
    const offset = y * rowSize;
    rawData[offset] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const px = offset + 1 + x * 3;
      rawData[px] = r;
      rawData[px + 1] = g;
      rawData[px + 2] = b;
    }
  }

  // Compress with zlib deflate
  const compressed = zlib.deflateSync(rawData);
  const idat = createPngChunk('IDAT', compressed);

  // IEND chunk
  const iend = createPngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
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

// 4. Generate placeholder PNG icons if they don't already exist
const iconDir = path.join(DIST, 'icons');
ensureDir(iconDir);
const sizes = [16, 48, 128];
const BLUE = { r: 0x25, g: 0x63, b: 0xeb }; // #2563EB

for (const size of sizes) {
  const iconPath = path.join(iconDir, `icon${size}.png`);
  if (!fs.existsSync(iconPath)) {
    const png = generatePng(size, BLUE.r, BLUE.g, BLUE.b);
    fs.writeFileSync(iconPath, png);
    console.log(`  Generated icon${size}.png`);
  }
}

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
