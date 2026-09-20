// 真实浏览器回归：验证图片打码的坐标系行为。
// 用 node:test + playwright-core 驱动本机已安装的 Chrome/Edge，不下载浏览器。
// 运行：npm run test:browser
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));

const BROWSER_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const executablePath = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));

async function bundleHarness() {
  const result = await build({
    entryPoints: [resolve(here, "harness.ts")],
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    write: false,
    legalComments: "none",
  });
  return result.outputFiles[0].text;
}

// 在页面里合成一张真实可解码的 JPEG，并按需插入 EXIF Orientation 标签。
// 用 canvas 产出基准 JPEG，再在 SOI 之后插入 APP1/Exif 段，避免依赖外部二进制 fixture。
const JPEG_FACTORY = `
window.__makeJpeg = async function (width, height, orientation) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#000000";
  context.fillRect(0, 0, Math.max(1, Math.floor(width / 4)), height);
  const base = await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.92));
  const baseBytes = new Uint8Array(await base.arrayBuffer());
  if (orientation === undefined) {
    return new Blob([baseBytes], { type: "image/jpeg" });
  }
  const payload = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4d, 0x4d,
    0x00, 0x2a,
    0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12,
    0x00, 0x03,
    0x00, 0x00, 0x00, 0x01,
    (orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  const segmentLength = payload.length + 2;
  const segment = [0xff, 0xe1, (segmentLength >> 8) & 0xff, segmentLength & 0xff].concat(payload);
  const out = new Uint8Array(baseBytes.length + segment.length);
  out.set(baseBytes.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(baseBytes.subarray(2), 2 + segment.length);
  return new Blob([out], { type: "image/jpeg" });
};
`;

describe("image redaction geometry in a real browser", {
  skip: executablePath === undefined
    ? "未找到本机 Chrome/Edge，跳过真实浏览器回归"
    : false,
}, () => {
  let browser;
  let page;

  before(async () => {
    const harness = await bundleHarness();
    browser = await chromium.launch({ executablePath, args: ["--disable-gpu"] });
    page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><title>redaction harness</title>');
    await page.addScriptTag({ content: harness });
    await page.addScriptTag({ content: JPEG_FACTORY });
  });

  after(async () => {
    await browser?.close();
  });

  // 这条测试记录的是平台事实，也是修复方案的依据：浏览器一定会应用 EXIF 方向，
  // 且没有任何 imageOrientation 取值能关掉它。若将来某版浏览器恢复了 "none" 的
  // 规范语义，此测试会失败并提示可以简化防护策略。
  it("documents that the browser always applies EXIF orientation", async () => {
    const result = await page.evaluate(async () => {
      const blob = await window.__makeJpeg(300, 100, 6);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const declared = window.__privacyHarness.readImageDimensions(bytes.buffer);
      const decode = async (options) => {
        const bitmap = options === undefined
          ? await createImageBitmap(blob)
          : await createImageBitmap(blob, options);
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
      };
      const image = new Image();
      const url = URL.createObjectURL(blob);
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
      URL.revokeObjectURL(url);

      return {
        declared,
        defaultDecode: await decode(undefined),
        noneDecode: await decode({ imageOrientation: "none" }),
        fromImageDecode: await decode({ imageOrientation: "from-image" }),
        naturalSize: { width: image.naturalWidth, height: image.naturalHeight },
      };
    });

    // 文件头 SOF 声明的几何不受 EXIF 影响；OCR 词框与上限校验都在这个坐标系里。
    assert.deepEqual(result.declared, { width: 300, height: 100 });
    // 实证原缺陷：解码后宽高互换。旧代码把已旋转的位图拉伸进 300x100 画布，黑框必然错位。
    assert.deepEqual(result.defaultDecode, { width: 100, height: 300 });
    // 实证 imageOrientation 关不掉定向，所以修复不能建立在这个选项上。
    assert.deepEqual(result.noneDecode, { width: 100, height: 300 });
    assert.deepEqual(result.fromImageDecode, { width: 100, height: 300 });
    assert.deepEqual(result.naturalSize, { width: 100, height: 300 });
  });

  it("classifies every non-upright orientation as unsafe to redact", async () => {
    const result = await page.evaluate(async () => {
      const output = {};
      for (const orientation of [undefined, 1, 2, 3, 4, 5, 6, 7, 8]) {
        const blob = await window.__makeJpeg(300, 100, orientation);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        output[String(orientation)] = {
          orientation: window.__privacyHarness.readJpegOrientation(bytes.buffer),
          upright: window.__privacyHarness.isUprightForRedaction(bytes.buffer),
        };
      }
      return output;
    });

    // 对 canvas 产出的真实 JPEG 也能正确定位 APP1/Exif 段。
    assert.equal(result.undefined.orientation, null);
    assert.equal(result.undefined.upright, true);
    assert.equal(result["1"].orientation, 1);
    assert.equal(result["1"].upright, true);

    // 2/3/4 解码后宽高不变，仅凭尺寸校验无法发现，必须靠方向标记本身拦截。
    for (const orientation of [2, 3, 4, 5, 6, 7, 8]) {
      const entry = result[String(orientation)];
      assert.equal(entry.orientation, orientation, `orientation ${orientation} 解析错误`);
      assert.equal(entry.upright, false, `orientation ${orientation} 应判为不可打码`);
    }
  });

  it("redacts an upright photo at the expected pixels", async () => {
    const result = await page.evaluate(async () => {
      const blob = await window.__makeJpeg(300, 100, undefined);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const declared = window.__privacyHarness.readImageDimensions(bytes.buffer);
      const derivative = await window.__privacyHarness.renderRedactedPng(
        blob,
        [{ x: 20, y: 15, width: 160, height: 27 }],
        declared,
      );
      const derivativeBytes = new Uint8Array(await derivative.arrayBuffer());
      const bitmap = await createImageBitmap(derivative);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const inside = context.getImageData(100, 28, 1, 1).data;
      const outside = context.getImageData(260, 85, 1, 1).data;
      bitmap.close();
      return {
        type: derivative.type,
        dimensions: window.__privacyHarness.readImageDimensions(derivativeBytes.buffer),
        inside: [inside[0], inside[1], inside[2], inside[3]],
        outside: [outside[0], outside[1], outside[2], outside[3]],
      };
    });

    assert.equal(result.type, "image/png");
    // 副本保持声明坐标系，未被旋转或压扁。
    assert.deepEqual(result.dimensions, { width: 300, height: 100 });
    // 遮挡区是实心不透明的 #111111，证明黑框打在了正确像素上。
    assert.deepEqual(result.inside, [17, 17, 17, 255]);
    // 框外仍是原图内容（这一区域是白底），说明没有整幅覆盖。
    assert.deepEqual(result.outside, [255, 255, 255, 255]);
  });

  // 第二道防线：即使前置的方向检查被绕过，渲染内部的几何校验仍须拦住宽高互换的图。
  it("rejects a derivative when decoded geometry disagrees with the declared header", async () => {
    const message = await page.evaluate(async () => {
      const blob = await window.__makeJpeg(300, 100, 6);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const declared = window.__privacyHarness.readImageDimensions(bytes.buffer);
      try {
        await window.__privacyHarness.renderRedactedPng(
          blob,
          [{ x: 0, y: 0, width: 10, height: 10 }],
          declared,
        );
        return null;
      } catch (error) {
        return String(error?.message ?? error);
      }
    });

    assert.ok(message !== null, "expected renderRedactedPng to reject");
    assert.match(message, /does not match the declared/);
  });
});
