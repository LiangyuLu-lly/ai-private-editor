import type { OcrRedactionRectangle } from "./ocr.js";

export type ImageDimensions = {
  width: number;
  height: number;
};

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const REDACTION_PADDING = 3;

function hasBytes(bytes: Uint8Array, offset: number, values: readonly number[]): boolean {
  return values.every((value, index) => bytes[offset + index] === value);
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian = false): number {
  return littleEndian
    ? (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
    : ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32(bytes: Uint8Array, offset: number, littleEndian = false): number {
  const value = littleEndian
    ? (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)
    : ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
  return value >>> 0;
}

function validDimensions(width: number, height: number): ImageDimensions | null {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasBytes(bytes, 0, PNG_SIGNATURE) || !hasBytes(bytes, 12, [73, 72, 68, 82])) {
    return null;
  }
  return validDimensions(readUint32(bytes, 16), readUint32(bytes, 20));
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasBytes(bytes, 0, [255, 216])) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 255) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 255) {
      offset += 1;
    }
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 216 || marker === 217) {
      continue;
    }
    const length = readUint16(bytes, offset);
    if (length < 2 || offset + length > bytes.length) {
      return null;
    }
    if ((marker >= 192 && marker <= 195) || (marker >= 197 && marker <= 199) || (marker >= 201 && marker <= 203)) {
      return validDimensions(readUint16(bytes, offset + 5), readUint16(bytes, offset + 3));
    }
    offset += length;
  }
  return null;
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasBytes(bytes, 0, [82, 73, 70, 70]) || !hasBytes(bytes, 8, [87, 69, 66, 80])) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkLength = readUint32(bytes, offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + chunkLength > bytes.length) {
      return null;
    }
    if (hasBytes(bytes, offset, [86, 80, 56, 88]) && chunkLength >= 10) {
      return validDimensions(readUint24(bytes, dataOffset + 4) + 1, readUint24(bytes, dataOffset + 7) + 1);
    }
    if (hasBytes(bytes, offset, [86, 80, 56, 76]) && chunkLength >= 5 && bytes[dataOffset] === 47) {
      const first = bytes[dataOffset + 1] ?? 0;
      const second = bytes[dataOffset + 2] ?? 0;
      const third = bytes[dataOffset + 3] ?? 0;
      const fourth = bytes[dataOffset + 4] ?? 0;
      return validDimensions(
        1 + first + ((second & 63) << 8),
        1 + ((second >> 6) | (third << 2) | ((fourth & 15) << 10)),
      );
    }
    if (hasBytes(bytes, offset, [86, 80, 56, 32]) && chunkLength >= 10 && hasBytes(bytes, dataOffset + 3, [157, 1, 42])) {
      return validDimensions(
        readUint16(bytes, dataOffset + 6, true) & 0x3fff,
        readUint16(bytes, dataOffset + 8, true) & 0x3fff,
      );
    }
    offset = dataOffset + chunkLength + (chunkLength % 2);
  }
  return null;
}

export function readImageDimensions(arrayBuffer: ArrayBuffer): ImageDimensions | null {
  const bytes = new Uint8Array(arrayBuffer);
  return readPngDimensions(bytes) ?? readJpegDimensions(bytes) ?? readWebpDimensions(bytes);
}

const EXIF_ORIENTATION_TAG = 0x0112;

function readExifOrientation(bytes: Uint8Array, tiffStart: number, limit: number): number | null {
  if (tiffStart + 8 > limit) {
    return null;
  }
  const littleEndian = hasBytes(bytes, tiffStart, [0x49, 0x49]);
  if (!littleEndian && !hasBytes(bytes, tiffStart, [0x4d, 0x4d])) {
    return null;
  }
  if (readUint16(bytes, tiffStart + 2, littleEndian) !== 0x2a) {
    return null;
  }

  const directoryStart = tiffStart + readUint32(bytes, tiffStart + 4, littleEndian);
  if (directoryStart + 2 > limit) {
    return null;
  }

  const entryCount = readUint16(bytes, directoryStart, littleEndian);
  for (let index = 0; index < entryCount; index += 1) {
    const entry = directoryStart + 2 + index * 12;
    if (entry + 12 > limit) {
      return null;
    }
    if (readUint16(bytes, entry, littleEndian) === EXIF_ORIENTATION_TAG) {
      const value = readUint16(bytes, entry + 8, littleEndian);
      return value >= 1 && value <= 8 ? value : null;
    }
  }

  return null;
}

/**
 * 读取 JPEG 的 EXIF 方向标记，无标记返回 null。
 *
 * 浏览器解码 JPEG 时一定会应用该方向：实测 Chrome 152 下 createImageBitmap 的
 * imageOrientation 取 "none" / "from-image" / "flipY" 以及 <img>.naturalWidth
 * 全都得到定向后的几何，无法取得未定向位图。而 OCR 词框与 readImageDimensions
 * 处于文件头声明的未定向坐标系，两者不一致时遮挡会落在错误像素上。
 * 方向 2/3/4（镜像、180 度）更不改变宽高，无法靠尺寸校验发现。
 */
export function readJpegOrientation(arrayBuffer: ArrayBuffer): number | null {
  const bytes = new Uint8Array(arrayBuffer);
  if (!hasBytes(bytes, 0, [0xff, 0xd8])) {
    return null;
  }

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    let markerOffset = offset + 1;
    while (bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    const marker = bytes[markerOffset] ?? 0;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset = markerOffset + 1;
      continue;
    }
    // 进入扫描数据或文件结束后不会再出现 APP1。
    if (marker === 0xda || marker === 0xd9) {
      return null;
    }
    const lengthOffset = markerOffset + 1;
    if (lengthOffset + 2 > bytes.length) {
      return null;
    }
    const length = readUint16(bytes, lengthOffset);
    const segmentEnd = lengthOffset + length;
    if (length < 2 || segmentEnd > bytes.length) {
      return null;
    }
    if (marker === 0xe1 && hasBytes(bytes, lengthOffset + 2, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00])) {
      return readExifOrientation(bytes, lengthOffset + 8, segmentEnd);
    }
    offset = segmentEnd;
  }

  return null;
}

/**
 * 图片是否处于可安全打码的正立方向。
 *
 * 仅覆盖 JPEG 的 EXIF 方向。PNG 的 eXIf 块与 WebP 的 EXIF 块理论上也能携带方向，
 * 浏览器支持不一致且实际极少出现；这两类若造成宽高互换，仍由 renderRedactedPng
 * 内的解码几何校验兜底，但镜像类方向无法检出。该边界已记录在 PRIVACY.md。
 */
export function isUprightForRedaction(arrayBuffer: ArrayBuffer): boolean {
  const orientation = readJpegOrientation(arrayBuffer);
  return orientation === null || orientation === 1;
}

export function clampRedactionRectangles(
  rectangles: readonly OcrRedactionRectangle[],
  dimensions: ImageDimensions,
  padding = REDACTION_PADDING,
): OcrRedactionRectangle[] {
  return rectangles.flatMap((rectangle) => {
    const left = Math.max(0, Math.floor(rectangle.x - padding));
    const top = Math.max(0, Math.floor(rectangle.y - padding));
    const right = Math.min(dimensions.width, Math.ceil(rectangle.x + rectangle.width + padding));
    const bottom = Math.min(dimensions.height, Math.ceil(rectangle.y + rectangle.height + padding));
    return right > left && bottom > top ? [{ x: left, y: top, width: right - left, height: bottom - top }] : [];
  });
}

const REDACTION_FILL = "#111111";

type RedactionContext = Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect">;

/**
 * OCR 词框与 readImageDimensions 的结果都处于文件头声明的未定向坐标系中。
 * 一旦解码后的实际几何与声明不符（EXIF 方向、伪造的头部宽高），遮挡矩形就会
 * 落在错误的像素上，产出一张看起来已打码、实际未遮住原文的副本。
 * 这种情况必须拒绝出图，而不是照常渲染。
 */
function assertDecodedGeometry(decoded: ImageDimensions, declared: ImageDimensions): void {
  if (decoded.width !== declared.width || decoded.height !== declared.height) {
    throw new Error(
      `Decoded image geometry ${decoded.width}x${decoded.height} does not match the declared ${declared.width}x${declared.height}; redaction rectangles cannot be trusted.`,
    );
  }
}

function paintRedaction(
  context: RedactionContext,
  rectangles: readonly OcrRedactionRectangle[],
  dimensions: ImageDimensions,
): void {
  context.fillStyle = REDACTION_FILL;
  for (const rectangle of clampRedactionRectangles(rectangles, dimensions)) {
    context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result === null) {
        reject(new Error("Unable to render redacted image"));
        return;
      }
      resolve(result);
    }, "image/png");
  });
}

async function loadImage(source: Blob): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(source);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to decode image"));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function renderRedactedPng(
  source: Blob,
  rectangles: readonly OcrRedactionRectangle[],
  dimensions: ImageDimensions,
): Promise<Blob> {
  if (typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function") {
    // 显式请求不做定向。但实测 Chrome 152 并不遵守该选项："none"、"from-image"、
    // "flipY" 与默认值都返回定向后的几何，无法取得未定向位图。因此不能依赖它：
    // 真正的防护是调用方的 isUprightForRedaction 前置检查，加上下面的解码几何校验。
    // 保留该选项，以便浏览器恢复规范语义后自动获得正确行为。
    const bitmap = await createImageBitmap(source, { imageOrientation: "none" });
    try {
      const decoded: ImageDimensions = { width: bitmap.width, height: bitmap.height };
      assertDecodedGeometry(decoded, dimensions);
      const canvas = new OffscreenCanvas(decoded.width, decoded.height);
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("Unable to create redaction canvas");
      }
      context.drawImage(bitmap, 0, 0);
      paintRedaction(context, rectangles, decoded);
      return await canvas.convertToBlob({ type: "image/png" });
    } finally {
      bitmap.close();
    }
  }

  const image = await loadImage(source);
  // <img> 解码无法关闭 EXIF 定向，naturalWidth/naturalHeight 已是定向后的尺寸；
  // 与声明尺寸不一致即说明坐标系不可信，此时拒绝产出副本。
  const decoded: ImageDimensions = { width: image.naturalWidth, height: image.naturalHeight };
  assertDecodedGeometry(decoded, dimensions);
  const canvas = document.createElement("canvas");
  canvas.width = decoded.width;
  canvas.height = decoded.height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Unable to create redaction canvas");
  }
  context.drawImage(image, 0, 0);
  paintRedaction(context, rectangles, decoded);
  return canvasBlob(canvas);
}
