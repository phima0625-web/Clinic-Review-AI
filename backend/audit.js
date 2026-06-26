/**
 * AI audit log — Supabase-backed sessions for Gemini flows.
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same as db.js).
 */
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

let supabaseClient = null;

function isAuditEnabled() {
  const url = process.env.SUPABASE_URL && String(process.env.SUPABASE_URL).trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim();
  return Boolean(url && key);
}

function getClient() {
  if (!isAuditEnabled()) return null;
  if (!supabaseClient) {
    supabaseClient = createClient(
      String(process.env.SUPABASE_URL).trim(),
      String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim()
    );
  }
  return supabaseClient;
}

function newAuditSessionId() {
  return `audit-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function reviewPreviewFromText(review) {
  const s = typeof review === "string" ? review.trim() : "";
  if (!s) return "";
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function mergeTokenTotals(existing, usage) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  if (!usage || typeof usage !== "object") return base;
  const keys = [
    "promptTokenCount",
    "candidatesTokenCount",
    "outputTokenCount",
    "totalTokenCount",
    "thoughtsTokenCount",
    "cachedContentTokenCount",
  ];
  for (const k of keys) {
    const n = usage[k];
    if (typeof n === "number" && Number.isFinite(n)) {
      base[k] = (typeof base[k] === "number" ? base[k] : 0) + n;
    }
  }
  return base;
}

function rowToSessionListItem(row) {
  const events = Array.isArray(row.events) ? row.events : [];
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    actorRole: row.actor_role,
    feature: row.feature,
    status: row.status,
    model: row.model || "",
    reviewPreview: row.review_preview || "",
    tokenTotals: row.token_totals || {},
    eventCount: events.length,
  };
}

function rowToSessionFull(row) {
  const events = Array.isArray(row.events) ? row.events : [];
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    actorRole: row.actor_role,
    feature: row.feature,
    status: row.status,
    model: row.model || "",
    reviewPreview: row.review_preview || "",
    tokenTotals: row.token_totals || {},
    eventCount: events.length,
    events,
  };
}

/**
 * Create a new session or load existing by id.
 * @returns {Promise<{ id: string, isNew: boolean } | null>}
 */
async function createOrLoadSession(sessionId, meta) {
  const client = getClient();
  if (!client) return null;

  const id =
    typeof sessionId === "string" && sessionId.trim()
      ? sessionId.trim()
      : newAuditSessionId();
  const m = meta && typeof meta === "object" ? meta : {};

  const { data: existing, error: readErr } = await client
    .from("ai_audit_sessions")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (readErr) {
    console.error("audit createOrLoadSession read:", readErr.message);
    return null;
  }

  if (existing) {
    return { id, isNew: false };
  }

  const now = new Date().toISOString();
  const row = {
    id,
    created_at: now,
    updated_at: now,
    actor_role: m.actorRole === "user" ? "user" : "admin",
    feature: typeof m.feature === "string" ? m.feature : "generate_reply",
    status: typeof m.status === "string" ? m.status : "in_progress",
    model: typeof m.model === "string" ? m.model : null,
    review_preview:
      typeof m.reviewPreview === "string"
        ? m.reviewPreview
        : reviewPreviewFromText(m.review),
    token_totals: {},
    events: [],
  };

  const { error: insertErr } = await client.from("ai_audit_sessions").insert(row);
  if (insertErr) {
    console.error("audit createOrLoadSession insert:", insertErr.message);
    return null;
  }
  return { id, isNew: true };
}

/**
 * Append events to a session; optionally update status, review_preview, token totals.
 */
async function appendAuditEvents(sessionId, events, patch) {
  const client = getClient();
  if (!client || !sessionId) return false;

  const incoming = Array.isArray(events) ? events.filter(Boolean) : [];
  if (!incoming.length && !(patch && typeof patch === "object")) return true;

  const { data: row, error: readErr } = await client
    .from("ai_audit_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (readErr || !row) {
    if (readErr) console.error("audit appendAuditEvents read:", readErr.message);
    return false;
  }

  const prevEvents = Array.isArray(row.events) ? row.events : [];
  const nextEvents = [...prevEvents, ...incoming];
  let tokenTotals = row.token_totals || {};

  for (const ev of incoming) {
    if (ev && ev.type === "gemini_response" && ev.usageMetadata) {
      tokenTotals = mergeTokenTotals(tokenTotals, ev.usageMetadata);
    }
  }

  const p = patch && typeof patch === "object" ? patch : {};
  const update = {
    updated_at: new Date().toISOString(),
    events: nextEvents,
    token_totals: tokenTotals,
  };
  if (typeof p.status === "string") update.status = p.status;
  if (typeof p.model === "string") update.model = p.model;
  if (typeof p.reviewPreview === "string") update.review_preview = p.reviewPreview;

  const { error: updErr } = await client
    .from("ai_audit_sessions")
    .update(update)
    .eq("id", sessionId);

  if (updErr) {
    console.error("audit appendAuditEvents update:", updErr.message);
    return false;
  }
  return true;
}

async function listAuditSessions({ limit = 50, offset = 0 } = {}) {
  const client = getClient();
  if (!client) return [];

  const lim = Math.min(100, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);

  const { data, error } = await client
    .from("ai_audit_sessions")
    .select(
      "id, created_at, updated_at, actor_role, feature, status, model, review_preview, token_totals, events"
    )
    .order("created_at", { ascending: false })
    .range(off, off + lim - 1);

  if (error) {
    console.error("audit listAuditSessions:", error.message);
    return [];
  }
  return (data || []).map(rowToSessionListItem);
}

async function getAuditSession(id) {
  const client = getClient();
  if (!client || !id) return null;

  const { data, error } = await client
    .from("ai_audit_sessions")
    .select("*")
    .eq("id", String(id))
    .maybeSingle();

  if (error) {
    console.error("audit getAuditSession:", error.message);
    return null;
  }
  if (!data) return null;
  return rowToSessionFull(data);
}

module.exports = {
  isAuditEnabled,
  newAuditSessionId,
  createOrLoadSession,
  appendAuditEvents,
  listAuditSessions,
  getAuditSession,
  reviewPreviewFromText,
  mergeTokenTotals,
};
