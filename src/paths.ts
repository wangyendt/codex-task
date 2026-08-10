import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

export interface AppPaths {
  configDir: string;
  stateDir: string;
  cacheDir: string;
  tempDir: string;
  tasksDir: string;
  identityPath: string;
  configPath: string;
}

export function defaultCodexHome(): string {
  return process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
}

export function appPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const override = env["CODEXERRAND_HOME"];
  if (override) {
    const configDir = join(override, "config");
    const stateDir = join(override, "state");
    const cacheDir = join(override, "cache");
    const tempDir = join(override, "temp");
    return {
      configDir,
      stateDir,
      cacheDir,
      tempDir,
      tasksDir: join(stateDir, "tasks"),
      identityPath: join(stateDir, "identity.json"),
      configPath: join(configDir, "config.json"),
    };
  }
  const home = homedir();
  let configDir: string;
  let stateDir: string;
  let cacheDir: string;

  if (platform() === "darwin") {
    configDir = join(home, "Library", "Application Support", "codexerrand");
    stateDir = configDir;
    cacheDir = join(home, "Library", "Caches", "codexerrand");
  } else if (platform() === "win32") {
    const appData = env["APPDATA"] ?? join(home, "AppData", "Roaming");
    const localAppData = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    configDir = join(appData, "codexerrand");
    stateDir = join(localAppData, "codexerrand", "state");
    cacheDir = join(localAppData, "codexerrand", "cache");
  } else {
    configDir = join(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "codexerrand");
    stateDir = join(env["XDG_STATE_HOME"] ?? join(home, ".local", "state"), "codexerrand");
    cacheDir = join(env["XDG_CACHE_HOME"] ?? join(home, ".cache"), "codexerrand");
  }

  const tempDir = join(tmpdir(), "codexerrand");
  return {
    configDir,
    stateDir,
    cacheDir,
    tempDir,
    tasksDir: join(stateDir, "tasks"),
    identityPath: join(stateDir, "identity.json"),
    configPath: join(configDir, "config.json"),
  };
}
