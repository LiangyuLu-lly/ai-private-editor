// 生成扩展图标。图标是品牌资产，这里只提供可用的占位设计：
// 深靛蓝圆底 + 白色挂锁，表示"本地保护"。替换正式设计时重跑本脚本即可。
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "src", "assets", "icons");
const SIZES = [16, 32, 48, 128];
const BACKGROUND = [30, 41, 82];
const FOREGROUND = [255, 255, 255];
const SUPERSAMPLE = 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const output = Buffer.alloc(body.length + 8);
  output.writeUInt32BE(data.length, 0);
  body.copy(output, 4);
  output.writeUInt32BE(crc32(body), body.length + 4);
  return output;
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function insideDisc(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  return dx * dx + dy * dy <= 0.25;
}

function insideLock(x, y) {
  // 锁体
  if (x >= 0.29 && x <= 0.71 && y >= 0.50 && y <= 0.80) {
    return true;
  }
  // 锁梁：上半圆环。外径必须小于锁体半宽，否则会在肩部露出两个突出的角。
  const dx = x - 0.5;
  const dy = y - 0.50;
  if (dy > 0) {
    return false;
  }
  const radius = Math.sqrt(dx * dx + dy * dy);
  return radius >= 0.115 && radius <= 0.19;
}

function insideKeyhole(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.61;
  if (dx * dx + dy * dy <= 0.0475 * 0.0475) {
    return true;
  }
  return Math.abs(dx) <= 0.023 && y >= 0.61 && y <= 0.73;
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let discHits = 0;
      let lockHits = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = (x * SUPERSAMPLE + sx + 0.5) * step;
          const py = (y * SUPERSAMPLE + sy + 0.5) * step;
          if (insideDisc(px, py)) {
            discHits += 1;
            if (insideLock(px, py) && !insideKeyhole(px, py)) {
              lockHits += 1;
            }
          }
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const alpha = discHits / samples;
      const lockRatio = discHits === 0 ? 0 : lockHits / discHits;
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(
          BACKGROUND[channel] * (1 - lockRatio) + FOREGROUND[channel] * lockRatio,
        );
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, pixels);
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  SIZES.map(async (size) => {
    const target = resolve(outputDirectory, `icon-${size}.png`);
    await writeFile(target, renderIcon(size));
    console.log(`wrote ${target}`);
  }),
);
