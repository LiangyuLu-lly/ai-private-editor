import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clampRedactionRectangles,
  isUprightForRedaction,
  readImageDimensions,
  readJpegOrientation,
  renderRedactedPng,
  type ImageDimensions,
} from "../src/scanner/image-redaction.js";
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, scanImage } from "../src/scanner/image.js";
import type { LocalOcrEngine } from "../src/scanner/ocr.js";
import type { LocalImageFile } from "../src/scanner/types.js";

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function imageFile(bytes: Uint8Array): LocalImageFile {
  return {
    name: "synthetic.png",
    size: bytes.byteLength,
    type: "image/png",
    arrayBuffer: async () => asArrayBuffer(bytes),
    blob: new Blob([asArrayBuffer(bytes)], { type: "image/png" }),
  };
}

// 最小 JPEG：SOI + 可选 APP1/Exif（仅含 Orientation 项）+ SOF0 + EOI。
// 只需能被字节解析器读取，不要求可解码。
function jpegBytes(width: number, height: number, orientation?: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];

  if (orientation !== undefined) {
    const payload = [
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x01,
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
      (orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ];
    const length = payload.length + 2;
    parts.push(0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload);
  }

  parts.push(
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  );
  return new Uint8Array(parts);
}

function jpegFile(bytes: Uint8Array): LocalImageFile {
  return {
    name: "synthetic.jpg",
    size: bytes.byteLength,
    type: "image/jpeg",
    arrayBuffer: async () => asArrayBuffer(bytes),
    blob: new Blob([asArrayBuffer(bytes)], { type: "image/jpeg" }),
  };
}

function engine(words: Parameters<LocalOcrEngine["recognize"]>[0] extends Blob ? Awaited<ReturnType<LocalOcrEngine["recognize"]>> : never): LocalOcrEngine {
  return {
    recognize: vi.fn(async () => words),
    terminate: vi.fn(async () => undefined),
  };
}

describe("local image scanning", () => {
  it("reads PNG dimensions before invoking OCR", () => {
    expect(readImageDimensions(asArrayBuffer(pngBytes(640, 480)))).toEqual({ width: 640, height: 480 });
  });

  it("expands and clamps OCR redaction rectangles at image edges", () => {
    expect(clampRedactionRectangles([{ x: 1, y: 2, width: 15, height: 10 }], { width: 20, height: 16 })).toEqual([
      { x: 0, y: 0, width: 19, height: 15 },
    ]);
  });

  it("creates a safe redacted image only for a recognized sensitive OCR result", async () => {
    const render = vi.fn(async () => new Blob(["safe"], { type: "image/png" }));
    const result = await scanImage(
      imageFile(pngBytes(300, 100)),
      engine([{ text: "13800138000", confidence: 96, bbox: { x0: 20, y0: 15, x1: 180, y1: 42 } }]),
      {},
      render,
    );

    expect(result).toMatchObject({
      status: "sensitive",
      coverage: "complete",
      findings: [{ kind: "phone", count: 1 }],
      dimensions: { width: 300, height: 100 },
    });
    expect(result.redactedImage?.type).toBe("image/png");
    expect(render).toHaveBeenCalledOnce();
  });

  it("never reports low-confidence OCR as clean", async () => {
    const result = await scanImage(
      imageFile(pngBytes(300, 100)),
      engine([{ text: "无关内容", confidence: 24, bbox: { x0: 20, y0: 15, x1: 180, y1: 42 } }]),
    );

    expect(result).toMatchObject({ status: "partial", coverage: "partial", summary: { reason: "ocr_low_confidence" } });
    expect(result.redactedImage).toBeUndefined();
  });

  it("does not produce an image derivative for a confirmation-only semantic candidate", async () => {
    const render = vi.fn(async () => new Blob(["safe"], { type: "image/png" }));
    const result = await scanImage(
      imageFile(pngBytes(300, 100)),
      engine([{ text: "张三", confidence: 96, bbox: { x0: 20, y0: 15, x1: 70, y1: 42 } }]),
      {
        detectionProfile: "balanced",
        semanticReviewProvider: {
          review: () => [{ kind: "person_name", start: 0, end: 2, score: 0.9, requiresConfirmation: true }],
        },
      },
      render,
    );

    expect(result).toMatchObject({ status: "partial", summary: { reason: "review_required" }, requiresReview: true });
    expect(result.redactedImage).toBeUndefined();
    expect(render).not.toHaveBeenCalled();
  });

  it("rejects an oversized image before OCR", async () => {
    const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS + 1));
    const ocr = engine([]);
    const result = await scanImage(imageFile(pngBytes(side, side)), ocr);

    expect(result).toMatchObject({ status: "unscannable", summary: { reason: "image_limit" } });
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it("rejects a pathological single-axis image before OCR", async () => {
    const bytes = pngBytes(MAX_IMAGE_DIMENSION + 1, 1);
    const ocr = engine([]);
    const result = await scanImage(imageFile(bytes), ocr);

    expect(result).toMatchObject({ status: "unscannable", summary: { reason: "image_limit" } });
    expect(ocr.recognize).not.toHaveBeenCalled();
  });
});

describe("redacted image geometry", () => {
  const originalOffscreenCanvas = Reflect.get(globalThis, "OffscreenCanvas");
  const originalCreateImageBitmap = Reflect.get(globalThis, "createImageBitmap");

  afterEach(() => {
    Reflect.set(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
    Reflect.set(globalThis, "createImageBitmap", originalCreateImageBitmap);
  });

  function stubCanvas(decoded: ImageDimensions): {
    canvasSizes: ImageDimensions[];
    fillRects: number[][];
    bitmapOptions: unknown[];
  } {
    const canvasSizes: ImageDimensions[] = [];
    const fillRects: number[][] = [];
    const bitmapOptions: unknown[] = [];

    Reflect.set(globalThis, "createImageBitmap", (_source: Blob, options?: unknown) => {
      bitmapOptions.push(options);
      return Promise.resolve({ width: decoded.width, height: decoded.height, close: () => undefined });
    });
    Reflect.set(
      globalThis,
      "OffscreenCanvas",
      class {
        constructor(public width: number, public height: number) {
          canvasSizes.push({ width, height });
        }

        getContext(): unknown {
          return {
            fillStyle: "",
            drawImage: () => undefined,
            fillRect: (...args: number[]) => {
              fillRects.push(args);
            },
          };
        }

        convertToBlob(): Promise<Blob> {
          return Promise.resolve(new Blob(["png"], { type: "image/png" }));
        }
      },
    );

    return { canvasSizes, fillRects, bitmapOptions };
  }

  it("decodes without EXIF orientation so boxes stay in the OCR coordinate space", async () => {
    const stub = stubCanvas({ width: 300, height: 100 });

    const blob = await renderRedactedPng(
      new Blob(["source"], { type: "image/jpeg" }),
      [{ x: 20, y: 15, width: 160, height: 27 }],
      { width: 300, height: 100 },
    );

    expect(stub.bitmapOptions).toEqual([{ imageOrientation: "none" }]);
    expect(stub.canvasSizes).toEqual([{ width: 300, height: 100 }]);
    expect(stub.fillRects).toHaveLength(1);
    expect(blob.type).toBe("image/png");
  });

  it("refuses a derivative when decoded geometry contradicts the declared header", async () => {
    // EXIF Orientation 6/8 的照片解码后宽高互换；此时词框坐标系不可信。
    const stub = stubCanvas({ width: 100, height: 300 });

    await expect(
      renderRedactedPng(
        new Blob(["source"], { type: "image/jpeg" }),
        [{ x: 20, y: 15, width: 160, height: 27 }],
        { width: 300, height: 100 },
      ),
    ).rejects.toThrow(/does not match the declared/);
    expect(stub.fillRects).toHaveLength(0);
  });

  it("keeps findings and marks the derivative unavailable when rendering fails", async () => {
    const render = vi.fn(async () => {
      throw new Error("Decoded image geometry 100x300 does not match the declared 300x100");
    });

    const result = await scanImage(
      imageFile(pngBytes(300, 100)),
      engine([{ text: "13800138000", confidence: 96, bbox: { x0: 20, y0: 15, x1: 180, y1: 42 } }]),
      {},
      render,
    );

    expect(result).toMatchObject({
      status: "partial",
      coverage: "partial",
      findings: [{ kind: "phone", count: 1 }],
      summary: { reason: "redaction_unavailable" },
    });
    expect(result.redactedImage).toBeUndefined();
    expect(render).toHaveBeenCalledOnce();
  });
});

describe("EXIF orientation gating for image redaction", () => {
  it("reads the orientation tag and treats only upright images as safe", () => {
    expect(readJpegOrientation(asArrayBuffer(jpegBytes(300, 100)))).toBeNull();
    expect(readJpegOrientation(asArrayBuffer(jpegBytes(300, 100, 1)))).toBe(1);
    expect(readJpegOrientation(asArrayBuffer(jpegBytes(300, 100, 6)))).toBe(6);
    expect(readJpegOrientation(asArrayBuffer(pngBytes(300, 100)))).toBeNull();

    expect(isUprightForRedaction(asArrayBuffer(jpegBytes(300, 100)))).toBe(true);
    expect(isUprightForRedaction(asArrayBuffer(jpegBytes(300, 100, 1)))).toBe(true);
    // 2/3/4 是镜像与 180 度旋转，解码后宽高不变，只能靠方向标记本身识别。
    for (const orientation of [2, 3, 4, 5, 6, 7, 8]) {
      expect(isUprightForRedaction(asArrayBuffer(jpegBytes(300, 100, orientation)))).toBe(false);
    }
  });

  it("keeps findings but skips the derivative for a non-upright photo", async () => {
    const render = vi.fn(async () => new Blob(["unsafe"], { type: "image/png" }));
    const result = await scanImage(
      jpegFile(jpegBytes(300, 100, 6)),
      engine([{ text: "13800138000", confidence: 96, bbox: { x0: 20, y0: 15, x1: 180, y1: 42 } }]),
      {},
      render,
    );

    expect(result).toMatchObject({
      status: "partial",
      coverage: "partial",
      findings: [{ kind: "phone", count: 1 }],
      summary: { reason: "redaction_unavailable" },
    });
    expect(result.redactedImage).toBeUndefined();
    // 连渲染都不该尝试：词框坐标系已不可信。
    expect(render).not.toHaveBeenCalled();
  });

  it("still produces a derivative for an upright JPEG", async () => {
    const render = vi.fn(async () => new Blob(["safe"], { type: "image/png" }));
    const result = await scanImage(
      jpegFile(jpegBytes(300, 100, 1)),
      engine([{ text: "13800138000", confidence: 96, bbox: { x0: 20, y0: 15, x1: 180, y1: 42 } }]),
      {},
      render,
    );

    expect(result).toMatchObject({ status: "sensitive", coverage: "complete" });
    expect(result.redactedImage?.type).toBe("image/png");
    expect(render).toHaveBeenCalledOnce();
  });
});
