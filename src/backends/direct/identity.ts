import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { arch, platform, release } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appPaths } from "../../paths.js";
import { atomicWrite } from "../../fs-utils.js";

export interface DirectIdentity {
  tls: DirectTlsProfile;
  installationId: string;
  codexVersion: string;
  osType: string;
  osVersion: string;
  arch: string;
}

export interface DirectTlsProfile {
  label: string;
  ja3: string;
  akamai: string;
}

/**
 * Explicit profiles supported by @ossiana/node-libcurl. `auto` is intentionally
 * avoided: its platform-dependent choice is rejected by ChatGPT's frontend on
 * some Linux hosts even when the same OAuth account and proxy work in Codex CLI.
 */
export const DIRECT_TLS_PROFILES: readonly DirectTlsProfile[] = [
  { label: "chrome131", ja3: "chrome131", akamai: "chrome119" },
  { label: "chrome133", ja3: "chrome133", akamai: "chrome119" },
  { label: "chrome150", ja3: "chrome150", akamai: "chrome119" },
];

export const DEFAULT_DIRECT_TLS_PROFILE: DirectTlsProfile = DIRECT_TLS_PROFILES.at(-1)!;

function pickTlsProfile(): DirectTlsProfile {
  return { ...DEFAULT_DIRECT_TLS_PROFILE };
}

function isTlsProfile(value: unknown): value is DirectTlsProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return typeof profile["label"] === "string" &&
    typeof profile["ja3"] === "string" && profile["ja3"] !== "auto" &&
    typeof profile["akamai"] === "string" && profile["akamai"] !== "auto";
}

/** Returns the persisted profile, or the profile a future Direct request will persist. */
export function inspectDirectTlsProfile(): DirectTlsProfile {
  const path = appPaths().identityPath;
  if (existsSync(path)) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { tls?: unknown };
      if (isTlsProfile(value.tls)) return value.tls;
    } catch {
      // Report the migration default without mutating invalid state.
    }
  }
  return { ...DEFAULT_DIRECT_TLS_PROFILE };
}

function detectCodexVersion(codexHome: string): string {
  try {
    const versionPath = join(codexHome, "version.json");
    if (existsSync(versionPath)) {
      const value = JSON.parse(readFileSync(versionPath, "utf8")) as Record<string, unknown>;
      if (typeof value["latest_version"] === "string") return value["latest_version"];
    }
  } catch {
    // Continue to the installed binary.
  }
  try {
    const output = execFileSync("codex", ["--version"], { timeout: 3000, encoding: "utf8" });
    return output.match(/\d+\.\d+\.\d+/)?.[0] ?? "0.147.0";
  } catch {
    return "0.147.0";
  }
}

function detectInstallationId(codexHome: string): string {
  try {
    const path = join(codexHome, "installation_id");
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    }
  } catch {
    // Use a private stable identity.
  }
  return randomUUID();
}

function platformInfo(): Pick<DirectIdentity, "osType" | "osVersion" | "arch"> {
  const architecture = arch() === "arm64" ? "aarch64" : arch() === "x64" ? "x86_64" : arch();
  if (platform() === "darwin") {
    try {
      const version = execFileSync("sw_vers", ["-productVersion"], { timeout: 2000, encoding: "utf8" }).trim();
      return { osType: "macOS", osVersion: version, arch: architecture };
    } catch {
      return { osType: "macOS", osVersion: release(), arch: architecture };
    }
  }
  if (platform() === "win32") return { osType: "Windows", osVersion: release(), arch: architecture };
  return { osType: "Linux", osVersion: release(), arch: architecture };
}

export function loadOrCreateIdentity(codexHome: string): DirectIdentity {
  const path = appPaths().identityPath;
  if (existsSync(path)) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<DirectIdentity>;
      if (value.installationId && value.codexVersion && value.osType && value.osVersion && value.arch) {
        if (isTlsProfile(value.tls)) return value as DirectIdentity;
        const migrated: DirectIdentity = { ...value as Omit<DirectIdentity, "tls">, tls: pickTlsProfile() };
        atomicWrite(path, JSON.stringify(migrated, null, 2), 0o600);
        return migrated;
      }
    } catch {
      // Replace invalid state.
    }
  }
  const identity: DirectIdentity = {
    tls: pickTlsProfile(),
    installationId: detectInstallationId(codexHome),
    codexVersion: detectCodexVersion(codexHome),
    ...platformInfo(),
  };
  atomicWrite(path, JSON.stringify(identity, null, 2), 0o600);
  return identity;
}

export function buildUserAgent(identity: DirectIdentity): string {
  return `codex_cli_rs/${identity.codexVersion} (${identity.osType} ${identity.osVersion}; ${identity.arch})`;
}

export function platformSandboxTag(): string {
  if (platform() === "darwin") return "seatbelt";
  if (platform() === "linux") return "seccomp";
  if (platform() === "win32") return "windows_sandbox";
  return "none";
}
