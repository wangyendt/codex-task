import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, withFileLock } from "../../fs-utils.js";
import { CodexTaskError } from "../../errors.js";
import { ImpersonatedSession } from "./http.js";

interface AuthTokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
  account_id: string;
}

const TOKEN_REFRESH_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function authPath(codexHome: string): string {
  return join(codexHome, "auth.json");
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const payload = jwt.split(".")[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function tokenExpiry(accessToken: string): number | undefined {
  const expiry = decodeJwtPayload(accessToken)?.["exp"];
  return typeof expiry === "number" ? expiry * 1000 : undefined;
}

export function isTokenExpired(accessToken: string): boolean {
  const expiry = tokenExpiry(accessToken);
  return expiry === undefined || Date.now() >= expiry - EXPIRY_BUFFER_MS;
}

function extractAccountId(accessToken: string): string | undefined {
  const auth = decodeJwtPayload(accessToken)?.["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return undefined;
  const accountId = (auth as Record<string, unknown>)["chatgpt_account_id"];
  return typeof accountId === "string" ? accountId : undefined;
}

function loadAuthDocument(codexHome: string): Record<string, unknown> {
  const path = authPath(codexHome);
  if (!existsSync(path)) {
    throw new CodexTaskError("AUTH_NOT_FOUND", `No Codex login found at ${path}. Run codex login first.`, {
      exitCode: 2,
    });
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new CodexTaskError("AUTH_INVALID", `Could not parse ${path}`, { exitCode: 2, cause: error });
  }
}

function tokensFromDocument(document: Record<string, unknown>): AuthTokens {
  const tokens = document["tokens"] as Partial<AuthTokens> | undefined;
  if (!tokens?.access_token) {
    throw new CodexTaskError("AUTH_INVALID", "Codex auth.json has no OAuth access token. Run codex login.", {
      exitCode: 2,
    });
  }
  return {
    access_token: tokens.access_token,
    id_token: tokens.id_token ?? "",
    refresh_token: tokens.refresh_token ?? "",
    account_id: tokens.account_id ?? "",
  };
}

async function refreshTokens(refreshToken: string, proxy?: string): Promise<AuthTokens> {
  const session = new ImpersonatedSession(15_000, proxy);
  try {
    const response = await session.post(
      TOKEN_REFRESH_URL,
      { "Content-Type": "application/json" },
      JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID }),
    );
    if (response.status < 200 || response.status >= 300) {
      throw new CodexTaskError("AUTH_REFRESH_FAILED", `Codex token refresh failed with HTTP ${response.status}`, {
        details: response.text.slice(0, 300),
      });
    }
    const value = JSON.parse(response.text) as Record<string, unknown>;
    return {
      access_token: typeof value["access_token"] === "string" ? value["access_token"] : "",
      id_token: typeof value["id_token"] === "string" ? value["id_token"] : "",
      refresh_token: typeof value["refresh_token"] === "string" ? value["refresh_token"] : refreshToken,
      account_id: "",
    };
  } finally {
    session.close();
  }
}

export async function ensureDirectAuth(
  codexHome: string,
  proxy?: string,
): Promise<{ accessToken: string; accountId: string; expiresAt?: number | undefined }> {
  const initial = tokensFromDocument(loadAuthDocument(codexHome));
  if (!isTokenExpired(initial.access_token)) {
    return {
      accessToken: initial.access_token,
      accountId: extractAccountId(initial.access_token) ?? initial.account_id,
      expiresAt: tokenExpiry(initial.access_token),
    };
  }
  if (!initial.refresh_token) {
    throw new CodexTaskError("AUTH_EXPIRED", "Codex OAuth token expired and has no refresh token. Run codex login.", {
      exitCode: 2,
    });
  }

  const path = authPath(codexHome);
  return withFileLock(`${path}.codex-task.lock`, async () => {
    const latestDocument = loadAuthDocument(codexHome);
    const latest = tokensFromDocument(latestDocument);
    if (!isTokenExpired(latest.access_token)) {
      return {
        accessToken: latest.access_token,
        accountId: extractAccountId(latest.access_token) ?? latest.account_id,
        expiresAt: tokenExpiry(latest.access_token),
      };
    }
    const refreshed = await refreshTokens(latest.refresh_token || initial.refresh_token, proxy);
    if (!refreshed.access_token) {
      throw new CodexTaskError("AUTH_REFRESH_FAILED", "Codex token refresh returned no access token");
    }
    const accountId = extractAccountId(refreshed.access_token) ?? latest.account_id;
    const previousTokens = (latestDocument["tokens"] as Record<string, unknown> | undefined) ?? {};
    const merged = {
      ...latestDocument,
      tokens: {
        ...previousTokens,
        access_token: refreshed.access_token,
        ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
        ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
        ...(accountId ? { account_id: accountId } : {}),
      },
      last_refresh: new Date().toISOString(),
    };
    atomicWrite(path, JSON.stringify(merged, null, 2), 0o600);
    return {
      accessToken: refreshed.access_token,
      accountId,
      expiresAt: tokenExpiry(refreshed.access_token),
    };
  });
}

export function inspectDirectAuth(codexHome: string): {
  found: boolean;
  valid: boolean;
  expiresAt?: number | undefined;
  message: string;
} {
  try {
    const tokens = tokensFromDocument(loadAuthDocument(codexHome));
    const expiresAt = tokenExpiry(tokens.access_token);
    return {
      found: true,
      valid: !isTokenExpired(tokens.access_token),
      expiresAt,
      message: expiresAt ? `OAuth token expires at ${new Date(expiresAt).toISOString()}` : "OAuth token expiry is unreadable",
    };
  } catch (error) {
    return { found: false, valid: false, message: error instanceof Error ? error.message : String(error) };
  }
}
