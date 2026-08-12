import { execFileSync } from "node:child_process";

export type ProxyPlatform = NodeJS.Platform;

export type ProxyCommandRunner = (file: string, args: readonly string[]) => string | undefined;

export interface ProxyResolutionOptions {
  configuredProxy?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: ProxyPlatform | undefined;
  runCommand?: ProxyCommandRunner | undefined;
}

const DIRECT_PROXY_VALUES = new Set(["direct", "none", "off"]);

function defaultRunCommand(file: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(file, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_500,
    }).trim();
  } catch {
    return undefined;
  }
}

function firstEnvironmentProxy(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ["ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function outputValue(output: string, key: string): string | undefined {
  const match = output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, "m"));
  return match?.[1]?.trim() || undefined;
}

function proxyAddress(scheme: "http" | "socks5h", host: string | undefined, port: string | undefined): string | undefined {
  if (!host || !port || !/^\d+$/.test(port)) return undefined;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${formattedHost}:${port}`;
}

export function proxyFromMacOsOutput(output: string): string | undefined {
  if (outputValue(output, "SOCKSEnable") === "1") {
    const socks = proxyAddress("socks5h", outputValue(output, "SOCKSProxy"), outputValue(output, "SOCKSPort"));
    if (socks) return socks;
  }
  for (const prefix of ["HTTPS", "HTTP"] as const) {
    if (outputValue(output, `${prefix}Enable`) !== "1") continue;
    const proxy = proxyAddress("http", outputValue(output, `${prefix}Proxy`), outputValue(output, `${prefix}Port`));
    if (proxy) return proxy;
  }
  return undefined;
}

function unquoteGsettings(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const match = trimmed.match(/^['"](.*)['"]$/s);
  return (match?.[1] ?? trimmed).trim() || undefined;
}

function proxyFromGsettings(runCommand: ProxyCommandRunner): string | undefined {
  const mode = unquoteGsettings(runCommand("gsettings", ["get", "org.gnome.system.proxy", "mode"]));
  if (mode !== "manual") return undefined;

  for (const [section, scheme] of [["socks", "socks5h"], ["https", "http"], ["http", "http"]] as const) {
    const host = unquoteGsettings(runCommand("gsettings", ["get", `org.gnome.system.proxy.${section}`, "host"]));
    const port = unquoteGsettings(runCommand("gsettings", ["get", `org.gnome.system.proxy.${section}`, "port"]));
    const proxy = proxyAddress(scheme, host, port);
    if (proxy) return proxy;
  }
  return undefined;
}

export function proxyFromWindowsServer(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.includes("=")) return trimmed.includes("://") ? trimmed : `http://${trimmed}`;

  const entries = new Map(trimmed.split(";").flatMap((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) return [];
    return [[entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim()] as const];
  }));
  const socks = entries.get("socks");
  if (socks) return socks.includes("://") ? socks : `socks5h://${socks}`;
  const web = entries.get("https") ?? entries.get("http");
  return web ? (web.includes("://") ? web : `http://${web}`) : undefined;
}

function detectSystemProxy(platform: ProxyPlatform, runCommand: ProxyCommandRunner): string | undefined {
  if (platform === "darwin") {
    const output = runCommand("/usr/sbin/scutil", ["--proxy"]);
    return output ? proxyFromMacOsOutput(output) : undefined;
  }
  if (platform === "linux") return proxyFromGsettings(runCommand);
  if (platform === "win32") {
    const output = runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; if ($p.ProxyEnable -eq 1) {[Console]::Out.Write([string]$p.ProxyServer)}",
    ]);
    return output ? proxyFromWindowsServer(output) : undefined;
  }
  return undefined;
}

export function resolveEffectiveProxy(options: ProxyResolutionOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const configured = options.configuredProxy?.trim();
  if (configured) {
    const mode = configured.toLowerCase();
    if (DIRECT_PROXY_VALUES.has(mode)) return undefined;
    if (mode !== "auto") return configured;
  }

  const environmentProxy = firstEnvironmentProxy(env);
  if (environmentProxy) return environmentProxy;
  return detectSystemProxy(options.platform ?? process.platform, options.runCommand ?? defaultRunCommand);
}
