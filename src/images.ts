import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { appPaths } from "./paths.js";
import { atomicWrite, ensureDir } from "./fs-utils.js";
import { usageError } from "./errors.js";
import type { Artifact, ImageOptions } from "./types.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;

export interface ValidatedImageOptions {
  count: number;
  concurrency: number;
  size: string;
  quality: "auto" | "low" | "medium" | "high";
  background: "auto" | "opaque" | "transparent";
  imagePaths: string[];
  overwrite: boolean;
}

export function validateImageOptions(options: ImageOptions): ValidatedImageOptions {
  const count = options.count ?? 1;
  const concurrency = options.concurrency ?? 1;
  const size = options.size ?? "auto";
  const quality = options.quality ?? "auto";
  const background = options.background ?? "auto";
  const imagePaths = options.imagePaths ?? [];

  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw usageError("count must be an integer from 1 to 10");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) {
    throw usageError("concurrency must be an integer from 1 to 3");
  }
  if (imagePaths.length > 5) throw usageError("at most 5 reference images are supported");
  if (!/^(auto|[1-9]\d{0,3}x[1-9]\d{0,3})$/.test(size)) {
    throw usageError("size must be auto or WIDTHxHEIGHT");
  }
  if (size !== "auto") {
    const [width, height] = size.split("x").map(Number);
    if (!width || !height || Math.max(width, height) > 3840) {
      throw usageError("image width and height must be at most 3840");
    }
  }

  let totalBytes = 0;
  for (const path of imagePaths) {
    if (!existsSync(path)) throw usageError(`reference image does not exist: ${path}`);
    const extension = extname(path).toLowerCase();
    if (!MIME_BY_EXTENSION[extension]) {
      throw usageError(`unsupported image type for ${path}; use png, jpg, jpeg, webp, or gif`);
    }
    const bytes = statSync(path).size;
    if (bytes > MAX_IMAGE_BYTES) throw usageError(`reference image exceeds 20 MiB: ${path}`);
    totalBytes += bytes;
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw usageError("reference images exceed the 50 MiB total limit");
  }

  return {
    count,
    concurrency,
    size,
    quality,
    background,
    imagePaths: imagePaths.map((path) => resolve(path)),
    overwrite: options.overwrite ?? false,
  };
}

export function imageMimeType(path: string): string {
  const mime = MIME_BY_EXTENSION[extname(path).toLowerCase()];
  if (!mime) throw usageError(`unsupported image type: ${path}`);
  return mime;
}

export function outputPathForImage(
  taskId: string,
  output: string | undefined,
  index: number,
  count: number,
): { path: string; temporary: boolean } {
  if (!output) {
    return { path: join(appPaths().tempDir, taskId, `image-${index + 1}.png`), temporary: true };
  }
  const absolute = resolve(output);
  const extension = extname(absolute).toLowerCase();
  if (extension === ".png") {
    if (count === 1) return { path: absolute, temporary: false };
    return {
      path: join(dirname(absolute), `${basename(absolute, extension)}-${index + 1}.png`),
      temporary: false,
    };
  }
  return { path: join(absolute, `image-${index + 1}.png`), temporary: false };
}

export function writePngArtifact(
  taskId: string,
  buffer: Buffer,
  output: string | undefined,
  index: number,
  count: number,
  overwrite: boolean,
): Artifact {
  const target = outputPathForImage(taskId, output, index, count);
  if (existsSync(target.path) && !overwrite) {
    throw usageError(`output already exists: ${target.path}; pass --overwrite to replace it`);
  }
  ensureDir(dirname(target.path));
  atomicWrite(target.path, buffer, 0o600);
  return {
    path: target.path,
    kind: "image",
    mimeType: "image/png",
    sizeBytes: buffer.byteLength,
    expiresAt: target.temporary ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined,
  };
}
