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
  temporary: boolean;
}

export function validateInputImages(paths: string[] | undefined): string[] {
  const imagePaths = (paths ?? []).map((path) => resolve(path));
  if (imagePaths.length > 5) throw usageError("at most 5 input images are supported");
  let totalBytes = 0;
  for (const path of imagePaths) {
    if (!existsSync(path)) throw usageError(`input image does not exist: ${path}`);
    const extension = extname(path).toLowerCase();
    if (!MIME_BY_EXTENSION[extension]) {
      throw usageError(`unsupported image type for ${path}; use png, jpg, jpeg, webp, or gif`);
    }
    const bytes = statSync(path).size;
    if (bytes > MAX_IMAGE_BYTES) throw usageError(`input image exceeds 20 MiB: ${path}`);
    totalBytes += bytes;
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw usageError("input images exceed the 50 MiB total limit");
  return imagePaths;
}

export function validateImageOptions(options: ImageOptions): ValidatedImageOptions {
  const count = options.count ?? 1;
  const concurrency = options.concurrency ?? 1;
  const size = options.size ?? "auto";
  const quality = options.quality ?? "auto";
  const background = options.background ?? "auto";
  const imagePaths = validateInputImages(options.imagePaths);
  const temporary = options.temporary ?? false;

  if (temporary && options.output) throw usageError("--temp cannot be combined with --output");

  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw usageError("count must be an integer from 1 to 10");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) {
    throw usageError("concurrency must be an integer from 1 to 3");
  }
  if (!/^(auto|[1-9]\d*x[1-9]\d*)$/.test(size)) {
    throw usageError("size must be auto or WIDTHxHEIGHT");
  }

  return {
    count,
    concurrency,
    size,
    quality,
    background,
    imagePaths,
    overwrite: options.overwrite ?? false,
    temporary,
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
  temporary = false,
): { path: string; temporary: boolean } {
  if (temporary) {
    return { path: join(appPaths().tempDir, taskId, `image-${index + 1}.png`), temporary: true };
  }
  const shortTaskId = taskId.slice(0, 8);
  const absolute = resolve(output ?? ".");
  const extension = extname(absolute).toLowerCase();
  if (extension === ".png") {
    if (count === 1) return { path: absolute, temporary: false };
    return {
      path: join(dirname(absolute), `${basename(absolute, extension)}-${index + 1}.png`),
      temporary: false,
    };
  }
  const suffix = count === 1 ? "" : `-${index + 1}`;
  return { path: join(absolute, `image-${shortTaskId}${suffix}.png`), temporary: false };
}

export function writePngArtifact(
  taskId: string,
  buffer: Buffer,
  output: string | undefined,
  index: number,
  count: number,
  overwrite: boolean,
  temporary = false,
): Artifact {
  const target = outputPathForImage(taskId, output, index, count, temporary);
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
