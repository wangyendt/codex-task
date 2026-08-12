import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexTaskError, usageError } from "./errors.js";

export interface ServiceSetupOptions {
  host: string;
  port: number;
  maxConcurrency: number;
  proxy?: string | boolean | undefined;
}

function serviceProxySetting(proxy: string | boolean | undefined): string {
  if (proxy === false) return "direct";
  if (proxy === undefined || proxy === true) return "auto";
  const value = proxy.trim();
  if (!value) throw usageError("proxy URL must not be empty");
  if (["auto", "direct", "none", "off"].includes(value.toLowerCase())) return value.toLowerCase();
  try {
    const protocol = new URL(value).protocol;
    if (!["http:", "https:", "socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(protocol)) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw usageError("proxy must be auto, direct, or an HTTP/HTTPS/SOCKS URL");
  }
  return value;
}

export function runServiceSetup(options: ServiceSetupOptions): void {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_TASK_SERVICE_HOST: options.host,
    CODEX_TASK_SERVICE_PORT: String(options.port),
    CODEX_TASK_SERVICE_CONCURRENCY: String(options.maxConcurrency),
    CODEX_TASK_SERVICE_PROXY: serviceProxySetting(options.proxy),
    CODEX_TASK_SKIP_GLOBAL_INSTALL: "1",
  };

  const serviceDirectory = fileURLToPath(new URL("../scripts/service/", import.meta.url));
  const command = process.platform === "win32" ? "powershell.exe" : "bash";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${serviceDirectory}Install-Windows.ps1`]
    : [`${serviceDirectory}install.sh`];
  const result = spawnSync(command, args, { env: environment, stdio: "inherit" });
  if (result.error) {
    throw new CodexTaskError("SETUP_FAILED", `Could not start the ${process.platform} service installer`, {
      exitCode: 1,
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new CodexTaskError("SETUP_FAILED", `Service installer exited with status ${result.status ?? "unknown"}`, {
      exitCode: 1,
    });
  }
}
