import { createRequire } from "node:module";
import { CodexTaskError } from "../../errors.js";
import { resolveEffectiveProxy } from "../../system-proxy.js";

const require = createRequire(import.meta.url);

interface NativeResponse {
  status?: number;
  responseStatus?: number;
  text?: string;
  responseText?: string;
}

interface NativeSession {
  post(url: string, options: { headers: Record<string, string>; data: string }): Promise<NativeResponse>;
  close(): void;
}

interface NativeRequests {
  session(options: Record<string, unknown>): NativeSession;
}

let requests: NativeRequests | undefined;

function loadRequests(): NativeRequests {
  if (requests) return requests;
  try {
    const module = require("@ossiana/node-libcurl") as { requests?: NativeRequests };
    if (!module.requests) throw new Error("module does not export requests");
    requests = module.requests;
    return requests;
  } catch (error) {
    throw new CodexTaskError(
      "DIRECT_UNAVAILABLE",
      "The Direct native transport is unavailable on this platform. Install @ossiana/node-libcurl or use --backend sdk.",
      { exitCode: 2, cause: error },
    );
  }
}

export function directTransportAvailable(): boolean {
  try {
    loadRequests();
    return true;
  } catch {
    return false;
  }
}

export interface HttpResponse {
  status: number;
  text: string;
}

export class ImpersonatedSession {
  private readonly session: NativeSession;

  constructor(timeoutMs: number, proxy?: string) {
    const effectiveProxy = resolveEffectiveProxy({ configuredProxy: proxy });
    this.session = loadRequests().session({
      ja3: "auto",
      akamai: "auto",
      httpVersion: "http2",
      redirect: false,
      timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
      ...(effectiveProxy ? { proxy: effectiveProxy } : {}),
    });
  }

  async post(url: string, headers: Record<string, string>, body: string): Promise<HttpResponse> {
    const response = await this.session.post(url, { headers, data: body });
    return {
      status: response.status ?? response.responseStatus ?? 0,
      text: response.text ?? response.responseText ?? "",
    };
  }

  close(): void {
    try {
      this.session.close();
    } catch {
      // Native teardown is best effort.
    }
  }
}
