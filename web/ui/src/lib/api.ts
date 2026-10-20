import { useStore } from "../store";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function httpBase(): string {
  const { host } = useStore.getState().settings;
  if (!host.trim()) return "";
  const h = host.trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(h)) return h;
  if (/^wss?:\/\//.test(h)) return h.replace(/^ws/, "http");
  return `${window.location.protocol}//${h}`;
}

/** JSON REST call against the console server with the bearer token from Settings. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { token } = useStore.getState().settings;
  const res = await fetch(`${httpBase()}/api${path}`, {
    method: init.method || (init.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = (data && (data.detail || data.error)) || res.statusText || `HTTP ${res.status}`;
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data as T;
}
