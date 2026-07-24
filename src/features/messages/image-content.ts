import type { Page } from "playwright-core";

export type SupportedImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export type ImageByteMetadata = {
  mimeType: SupportedImageMime | null;
  width: number | null;
  height: number | null;
  animated: boolean;
  frameCount: number | null;
};

export function synchronizeVisualMetadata<T extends {
  width: number | null;
  height: number | null;
  animated: boolean;
}>(visual: T, rendered: {
  width: number | null;
  height: number | null;
  animated: boolean | null;
}): T {
  return {
    ...visual,
    width: rendered.width,
    height: rendered.height,
    animated: rendered.animated === true,
  };
}

function positiveDimension(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export function sniffImageMime(bytes: Uint8Array): SupportedImageMime | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && ascii(bytes, 1, 3) === "PNG"
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && /GIF8[79]a/.test(ascii(bytes, 0, 6))) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function gifMetadata(bytes: Uint8Array): Omit<ImageByteMetadata, "mimeType"> {
  if (bytes.length < 13) {
    return { width: null, height: null, animated: false, frameCount: null };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = positiveDimension(view.getUint16(6, true));
  const height = positiveDimension(view.getUint16(8, true));
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * (2 ** ((bytes[10] & 0x07) + 1));
  let frames = 0;
  const skipSubBlocks = (): void => {
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (size === 0) break;
      offset += size;
    }
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      offset += 1;
      skipSubBlocks();
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) break;
    frames += 1;
    const packed = bytes[offset + 8];
    offset += 9;
    if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
    offset += 1;
    skipSubBlocks();
  }
  return { width, height, animated: frames > 1, frameCount: frames || null };
}

function pngMetadata(bytes: Uint8Array): Omit<ImageByteMetadata, "mimeType"> {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") {
    return { width: null, height: null, animated: false, frameCount: 1 };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: positiveDimension(view.getUint32(16, false)),
    height: positiveDimension(view.getUint32(20, false)),
    animated: false,
    frameCount: 1,
  };
}

function jpegMetadata(bytes: Uint8Array): Omit<ImageByteMetadata, "mimeType"> {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
      .includes(marker)) {
      return {
        width: positiveDimension((bytes[offset + 5] << 8) | bytes[offset + 6]),
        height: positiveDimension((bytes[offset + 3] << 8) | bytes[offset + 4]),
        animated: false,
        frameCount: 1,
      };
    }
    offset += length;
  }
  return { width: null, height: null, animated: false, frameCount: 1 };
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpMetadata(bytes: Uint8Array): Omit<ImageByteMetadata, "mimeType"> {
  if (bytes.length < 30) {
    return { width: null, height: null, animated: false, frameCount: 1 };
  }
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return {
      width: positiveDimension(uint24le(bytes, 24) + 1),
      height: positiveDimension(uint24le(bytes, 27) + 1),
      animated: Boolean(bytes[20] & 0x02),
      frameCount: Boolean(bytes[20] & 0x02) ? null : 1,
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return {
      width: positiveDimension((bytes[26] | (bytes[27] << 8)) & 0x3fff),
      height: positiveDimension((bytes[28] | (bytes[29] << 8)) & 0x3fff),
      animated: false,
      frameCount: 1,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return {
      width: positiveDimension((bits & 0x3fff) + 1),
      height: positiveDimension(((bits >>> 14) & 0x3fff) + 1),
      animated: false,
      frameCount: 1,
    };
  }
  return { width: null, height: null, animated: false, frameCount: 1 };
}

export function inspectImageBytes(bytes: Uint8Array): ImageByteMetadata {
  const mimeType = sniffImageMime(bytes);
  const metadata = mimeType === "image/gif"
    ? gifMetadata(bytes)
    : mimeType === "image/png"
      ? pngMetadata(bytes)
      : mimeType === "image/jpeg"
        ? jpegMetadata(bytes)
        : mimeType === "image/webp"
          ? webpMetadata(bytes)
          : { width: null, height: null, animated: false, frameCount: null };
  return { mimeType, ...metadata };
}

export async function decodeFirstFrameAsPng(
  page: Page,
  bytes: Uint8Array,
  mimeType: SupportedImageMime,
): Promise<{ data: Buffer; width: number; height: number } | null> {
  const encoded = Buffer.from(bytes).toString("base64");
  const result = await page.evaluate(async ({ encodedBytes, sourceMime }) => {
    const binary = atob(encodedBytes);
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
    const blob = new Blob([data], { type: sourceMime });
    let drawable: CanvasImageSource | null = null;
    let closeDrawable: (() => void) | null = null;
    const Decoder = (globalThis as unknown as {
      ImageDecoder?: new (input: { data: ArrayBuffer; type: string }) => {
        decode(options: { frameIndex: number; completeFramesOnly: boolean }): Promise<{
          image: CanvasImageSource & { displayWidth?: number; displayHeight?: number; close?: () => void };
        }>;
        close(): void;
      };
    }).ImageDecoder;
    let decoder: InstanceType<NonNullable<typeof Decoder>> | null = null;
    try {
      if (Decoder) {
        try {
          decoder = new Decoder({ data: data.buffer, type: sourceMime });
          const decoded = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
          drawable = decoded.image;
          closeDrawable = () => decoded.image.close?.();
        } catch {
          decoder?.close();
          decoder = null;
        }
      }
      if (!drawable) {
        const bitmap = await createImageBitmap(blob);
        drawable = bitmap;
        closeDrawable = () => bitmap.close();
      }
      const source = drawable as CanvasImageSource & {
        displayWidth?: number;
        displayHeight?: number;
        width?: number;
        height?: number;
      };
      const width = Number(source.displayWidth ?? source.width ?? 0);
      const height = Number(source.displayHeight ?? source.height ?? 0);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(drawable, 0, 0, width, height);
      return { dataUrl: canvas.toDataURL("image/png"), width, height };
    } finally {
      closeDrawable?.();
      decoder?.close();
    }
  }, { encodedBytes: encoded, sourceMime: mimeType }).catch(() => null);
  if (!result?.dataUrl?.startsWith("data:image/png;base64,")) return null;
  return {
    data: Buffer.from(result.dataUrl.slice("data:image/png;base64,".length), "base64"),
    width: result.width,
    height: result.height,
  };
}
