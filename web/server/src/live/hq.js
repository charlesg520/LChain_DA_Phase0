// Thin client for HQ: Aegra's Agent Protocol (threads, runs, SSE) plus /ops.
// The HQ API token lives here, server-side; browsers never see it.

import http from "node:http";
import https from "node:https";

export class HqError extends Error {
  /** @param {number} status @param {string} message @param {any} [body] */
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class HqClient {
  /** @param {{apiUrl: string, apiToken: string}} opts */
  constructor({ apiUrl, apiToken }) {
    this.base = apiUrl.replace(/\/+$/, "");
    this.token = apiToken;
  }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  /**
   * JSON request. Throws HqError with HQ's own message on failure.
   * @param {string} path
   * @param {{method?: string, body?: any, timeoutMs?: number}} [opts]
   */
  async json(path, { method, body, timeoutMs = 30000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(this.base + path, {
        method: method || (body !== undefined ? "POST" : "GET"),
        headers: this.headers(body !== undefined ? { "content-type": "application/json" } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (e) {
      throw new HqError(502, `HQ is unreachable (${e?.cause?.code || e?.name || e?.message || e})`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && (data.detail || data.message || data.error)) || res.statusText;
      throw new HqError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg), data);
    }
    return data;
  }

  /**
   * Open an SSE stream and yield {event, data, id} until it ends.
   *
   * Uses node:http rather than fetch: fetch (undici) gives up on a response body
   * that is quiet for 5 minutes, and an agent run can legitimately be quiet that
   * long (a long build or test inside the sandbox).
   *
   * @param {string} path
   * @param {any} body  JSON body to POST, or null to GET (joining a run)
   * @param {AbortSignal} signal
   * @param {{lastEventId?: string}} [opts]
   */
  async *stream(path, body, signal, { lastEventId } = {}) {
    const url = new URL(this.base + path);
    const mod = url.protocol === "https:" ? https : http;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    /** @type {Record<string, string>} */
    const headers = this.headers({ accept: "text/event-stream" });
    if (payload) Object.assign(headers, { "content-type": "application/json", "content-length": String(payload.length) });
    if (lastEventId) headers["last-event-id"] = lastEventId;
    if (signal.aborted) return;

    /** @type {import("node:http").IncomingMessage} */
    let res;
    try {
      res = await new Promise((resolve, reject) => {
        const req = mod.request(url, { method: payload ? "POST" : "GET", headers, signal }, resolve);
        req.on("error", reject);
        req.setTimeout(0);
        req.end(payload || undefined);
      });
    } catch (e) {
      if (signal.aborted) return;
      throw new HqError(502, `HQ is unreachable (${e?.code || e?.message || e})`);
    }
    const status = res.statusCode || 0;
    if (status < 200 || status >= 300) {
      let text = "";
      for await (const c of res) text += c;
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      const msg = (data && (data.message || data.detail || data.error)) || res.statusMessage || `HTTP ${status}`;
      throw new HqError(status, typeof msg === "string" ? msg : JSON.stringify(msg), data);
    }
    res.setEncoding("utf8");
    let buf = "";
    try {
      for await (const chunk of res) {
        buf += chunk;
        let m;
        while ((m = /\r?\n\r?\n/.exec(buf))) {
          const block = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          const ev = parseBlock(block);
          if (ev) yield ev;
        }
      }
      if (!res.complete) throw new HqError(502, "the stream from HQ was cut off");
      const tail = parseBlock(buf);
      if (tail) yield tail;
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof HqError) throw e;
      throw new HqError(502, `the stream from HQ was cut off (${e?.code || e?.message || e})`);
    } finally {
      res.destroy();
    }
  }
}

/** Parse one SSE block into {event, id, data}; data is JSON when it parses. */
export function parseBlock(block) {
  let event = "message";
  let id;
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length && event === "message") return null;
  const raw = data.join("\n");
  try {
    return { event, id, data: raw ? JSON.parse(raw) : null };
  } catch {
    return { event, id, data: raw };
  }
}
