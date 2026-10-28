// Phone/desktop notifications through ntfy (https://ntfy.sh, or a self-hosted server).
//
// HQ can't message you on its own between runs, so the console does it: when a run
// finishes (after a while), stops on an error, or waits for your approval. Tapping a
// notification opens that chat; approval notifications carry Approve / Reject buttons
// backed by one-time links, so a forwarded notification can't be replayed.
//
// Notifications carry only titles and status, never code or secrets: on the public
// ntfy.sh server anyone who knows the topic name can read them, so use a long random
// topic (make init generates one).
import crypto from "node:crypto";

const ACTION_TTL_MS = 24 * 3600 * 1000;

export class Notifier {
  /**
   * @param {{url?: string, topic?: string, token?: string, publicUrl?: string, doneMinSeconds?: number}} opts
   */
  constructor({ url, topic, token, publicUrl, doneMinSeconds } = {}) {
    this.url = (url || "https://ntfy.sh").replace(/\/+$/, "");
    this.topic = (topic || "").trim();
    this.token = token || "";
    this.publicUrl = (publicUrl || "").replace(/\/+$/, "");
    this.doneMinMs = Math.max(0, Number(doneMinSeconds ?? 60)) * 1000;
    /** @type {Map<string, {runId: string, interruptId: string, action: "approve"|"reject", expires: number}>} */
    this.actions = new Map();
    this.sent = 0;
    this.lastError = "";
  }

  get enabled() {
    return Boolean(this.topic);
  }

  /** What the console's Settings shows. */
  info() {
    return { enabled: this.enabled, server: this.url, topic: this.topic, sent: this.sent, last_error: this.lastError || null };
  }

  chatLink(runId) {
    return this.publicUrl ? `${this.publicUrl}/?chat=${encodeURIComponent(runId)}` : undefined;
  }

  /**
   * Publish one notification. Never throws: a failed notification must not break a run.
   * @param {{title: string, message: string, tags?: string[], priority?: number, runId?: string, actions?: any[]}} n
   */
  async send({ title, message, tags = [], priority = 3, runId = undefined, actions = [] }) {
    if (!this.enabled) return false;
    const click = runId ? this.chatLink(runId) : this.publicUrl || undefined;
    const body = {
      topic: this.topic,
      title: clip(title, 120),
      message: clip(message, 400),
      tags,
      priority,
      ...(click ? { click } : {}),
      ...(actions.length ? { actions } : {}),
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
      this.sent += 1;
      this.lastError = "";
      return true;
    } catch (e) {
      this.lastError = String(e?.message || e);
      console.error("notification failed:", this.lastError);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------ events
  runFinished(run, ms) {
    if (ms < this.doneMinMs) return; // you were probably watching
    return this.send({ title: "HQ finished", message: `${chatName(run)} (${duration(ms)})`, tags: ["white_check_mark"], runId: run.id });
  }

  runFailed(run, reason) {
    return this.send({ title: "HQ stopped: needs you", message: `${chatName(run)}: ${reason}`, tags: ["x"], priority: 4, runId: run.id });
  }

  approvalNeeded(run, interruptId, tool) {
    const actions = [];
    const open = this.chatLink(run.id);
    if (open) actions.push({ action: "view", label: "Open", url: open, clear: true });
    if (this.publicUrl) {
      for (const [action, label] of [
        ["approve", "Approve"],
        ["reject", "Reject"],
      ]) {
        const token = this._actionToken(run.id, interruptId, /** @type {any} */ (action));
        actions.push({ action: "http", label, url: `${this.publicUrl}/api/notify/act/${token}`, method: "POST", clear: true });
      }
    }
    return this.send({ title: "HQ needs your approval", message: `${tool} in ${chatName(run)}`, tags: ["warning"], priority: 4, runId: run.id, actions });
  }

  test() {
    return this.send({ title: "HQ test notification", message: "Notifications work. Tapping this opens the console.", tags: ["bell"] });
  }

  // ------------------------------------------------------- one-time links
  _actionToken(runId, interruptId, action) {
    this._prune();
    const token = crypto.randomBytes(24).toString("base64url");
    this.actions.set(token, { runId, interruptId, action, expires: Date.now() + ACTION_TTL_MS });
    return token;
  }

  /** Consume a one-time action link (and its sibling for the same approval). */
  takeAction(token) {
    this._prune();
    const hit = this.actions.get(String(token || ""));
    if (!hit) return null;
    for (const [t, a] of this.actions) if (a.runId === hit.runId && a.interruptId === hit.interruptId) this.actions.delete(t);
    return hit;
  }

  _prune() {
    const now = Date.now();
    for (const [t, a] of this.actions) if (a.expires < now) this.actions.delete(t);
  }
}

function chatName(run) {
  return `"${clip(run.title || "Untitled chat", 80)}"`;
}

function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}
