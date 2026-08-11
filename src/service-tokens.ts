import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexTaskError, usageError } from "./errors.js";
import { atomicWrite, withFileLock } from "./fs-utils.js";
import { appPaths } from "./paths.js";

export type ServiceTokenScope = "text" | "image";

interface StoredServiceToken {
  name: string;
  tokenHash: string;
  allow: ServiceTokenScope[];
  createdAt: string;
}

interface ServiceTokenRegistry {
  version: 1;
  tokens: StoredServiceToken[];
}

export interface ListedServiceToken {
  name: string;
  allow: ServiceTokenScope[];
  createdAt: string;
}

export interface CreatedServiceToken extends ListedServiceToken {
  status: "created";
  token: string;
}

export function serviceTokenRegistryPath(): string {
  return join(appPaths().configDir, "service", "tokens.json");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readRegistry(path = serviceTokenRegistryPath()): ServiceTokenRegistry {
  if (!existsSync(path)) return { version: 1, tokens: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ServiceTokenRegistry>;
    if (value.version !== 1 || !Array.isArray(value.tokens)) throw new Error("unsupported registry format");
    return { version: 1, tokens: value.tokens };
  } catch (error) {
    throw new CodexTaskError("INVALID_TOKEN_REGISTRY", `Could not parse ${path}`, {
      exitCode: 2,
      cause: error,
    });
  }
}

function writeRegistry(path: string, registry: ServiceTokenRegistry): void {
  atomicWrite(path, `${JSON.stringify(registry, null, 2)}\n`, 0o600);
}

function validateName(name: string): string {
  const normalized = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(normalized)) {
    throw usageError("token name must be 1-64 letters, numbers, dots, underscores, or hyphens");
  }
  return normalized;
}

export function parseServiceTokenScopes(value: string): ServiceTokenScope[] {
  const requested = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (requested.length === 0 || requested.some((item) => item !== "text" && item !== "image")) {
    throw usageError("--allow must be text, image, or text,image");
  }
  return (["text", "image"] as const).filter((scope) => requested.includes(scope));
}

export async function createServiceToken(name: string, allow: ServiceTokenScope[]): Promise<CreatedServiceToken> {
  const normalizedName = validateName(name);
  const path = serviceTokenRegistryPath();
  return withFileLock(`${path}.lock`, async () => {
    const registry = readRegistry(path);
    if (registry.tokens.some((item) => item.name === normalizedName)) {
      throw usageError(`token name already exists: ${normalizedName}`);
    }
    const token = `ctt_${randomBytes(32).toString("base64url")}`;
    const createdAt = new Date().toISOString();
    registry.tokens.push({
      name: normalizedName,
      tokenHash: tokenHash(token),
      allow: [...allow],
      createdAt,
    });
    writeRegistry(path, registry);
    return { status: "created", name: normalizedName, allow: [...allow], createdAt, token };
  });
}

export function listServiceTokens(): ListedServiceToken[] {
  return readRegistry().tokens.map(({ name, allow, createdAt }) => ({ name, allow: [...allow], createdAt }));
}

export async function revokeServiceToken(name: string): Promise<void> {
  const normalizedName = validateName(name);
  const path = serviceTokenRegistryPath();
  await withFileLock(`${path}.lock`, async () => {
    const registry = readRegistry(path);
    const remaining = registry.tokens.filter((item) => item.name !== normalizedName);
    if (remaining.length === registry.tokens.length) throw usageError(`token name not found: ${normalizedName}`);
    writeRegistry(path, { version: 1, tokens: remaining });
  });
}

export function scopesForServiceToken(token: string, path = serviceTokenRegistryPath()): Set<ServiceTokenScope> | undefined {
  const supplied = Buffer.from(tokenHash(token), "hex");
  for (const item of readRegistry(path).tokens) {
    const expected = Buffer.from(item.tokenHash, "hex");
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return new Set(item.allow);
  }
  return undefined;
}
