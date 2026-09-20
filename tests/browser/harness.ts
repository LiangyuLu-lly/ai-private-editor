// 真实浏览器回归专用桩。
//
// jsdom 既没有真实的 createImageBitmap，也没有可用的 canvas 像素管线，
// 因此 EXIF 方向、解码几何与实际遮挡像素这三类行为在 vitest 里无法验证——
// 这正是打码坐标错位缺陷能躲过全部单元测试的原因。
// 这个文件把相关函数暴露到全局，供 tests/browser/*.test.mjs 在真实 Chromium 中调用。
import {
  isUprightForRedaction,
  readImageDimensions,
  readJpegOrientation,
  renderRedactedPng,
} from "../../src/scanner/image-redaction.js";

Object.assign(globalThis, {
  __privacyHarness: {
    isUprightForRedaction,
    readImageDimensions,
    readJpegOrientation,
    renderRedactedPng,
  },
});
