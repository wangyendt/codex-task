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

function namedAppPaths(name: "codex-task" | "codexerrand", override: string | undefined, env: NodeJS.ProcessEnv): AppPaths {
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
    configDir = join(home, "Library", "Application Support", name);
    stateDir = configDir;
    cacheDir = join(home, "Library", "Caches", name);
  } else if (platform() === "win32") {
    const appData = env["APPDATA"] ?? join(home, "AppData", "Roaming");
    const localAppData = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    configDir = join(appData, name);
    stateDir = join(localAppData, name, "state");
    cacheDir = join(localAppData, name, "cache");
  } else {
    configDir = join(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), name);
    stateDir = join(env["XDG_STATE_HOME"] ?? join(home, ".local", "state"), name);
    cacheDir = join(env["XDG_CACHE_HOME"] ?? join(home, ".cache"), name);
  }

  const tempDir = join(tmpdir(), name);
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

export function appPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  return namedAppPaths("codex-task", env["CODEX_TASK_HOME"], env);
}

/** Read-only compatibility paths for users migrating from CodexErrand. */
export function legacyAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  return namedAppPaths("codexerrand", env["CODEXERRAND_HOME"], env);
}
