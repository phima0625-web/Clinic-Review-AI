/**
 * Clinic knowledge + review library storage.
 * Uses Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set;
 * otherwise falls back to knowledge.json (library stays client-only via API empty).
 */
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const KNOWLEDGE_PATH = path.join(__dirname, "knowledge.json");

const LIBRARY_CATEGORY_VALUES = [
  "Treatment / Care quality",
  "Provider interaction",
  "Wait time / Scheduling",
  "Billing / Insurance",
  "Referral / Orders",
  "Front desk / Staff",
  "Other",
];
const CATEGORY_VALUE_SET = new Set(LIBRARY_CATEGORY_VALUES);

let supabaseClient = null;

function isDbEnabled() {
  const url = process.env.SUPABASE_URL && String(process.env.SUPABASE_URL).trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim();
  return Boolean(url && key);
}

function getClient() {
  if (!isDbEnabled()) return null;
  if (!supabaseClient) {
    supabaseClient = createClient(
      String(process.env.SUPABASE_URL).trim(),
      String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim()
    );
  }
  return supabaseClient;
}

function normalizeKnowledgeCategory(raw, reviewCategoryFallback) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (CATEGORY_VALUE_SET.has(s)) return s;
  const fb = reviewCategoryFallback != null ? String(reviewCategoryFallback).trim() : "";
  if (CATEGORY_VALUE_SET.has(fb)) return fb;
  return "Other";
}

const LEGACY_TAG_TO_CATEGORY = {
  Billing: "Billing / Insurance",
  Provider: "Provider interaction",
  Flow: "Wait time / Scheduling",
  Referral: "Referral / Orders",
  Staff: "Front desk / Staff",
};

function normalizeCaseCategory(c) {
  const direct = String((c && c.category) || "").trim();
  if (CATEGORY_VALUE_SET.has(direct)) return direct;
  const fromTitle = String((c && c.title) || "").trim();
  if (CATEGORY_VALUE_SET.has(fromTitle)) return fromTitle;
  for (const tag of (c && c.tags) || []) {
    if (LEGACY_TAG_TO_CATEGORY[tag]) return LEGACY_TAG_TO_CATEGORY[tag];
  }
  return "Other";
}

/** Normalize to a non-empty array of valid library categories. */
function normalizeCaseCategories(raw) {
  if (raw && Array.isArray(raw.categories) && raw.categories.length) {
    const seen = new Set();
    const out = [];
    for (const item of raw.categories) {
      const s = typeof item === "string" ? item.trim() : "";
      if (CATEGORY_VALUE_SET.has(s) && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    if (out.length) return out;
  }
  return [normalizeCaseCategory(raw)];
}

function cleanLibraryItem(it) {
  if (!it || typeof it !== "object") return null;
  const replyText = typeof it.replyText === "string" ? it.replyText.trim() : "";
  if (!replyText) return null;
  const categories = normalizeCaseCategories(it);
  return {
    id:
      typeof it.id === "string" && it.id
        ? it.id
        : `case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    categories,
    category: categories[0],
    reviewText: typeof it.reviewText === "string" ? it.reviewText.trim() : "",
    contextText: typeof it.contextText === "string" ? it.contextText.trim() : "",
    replyText,
    createdAt: typeof it.createdAt === "string" ? it.createdAt : new Date().toISOString(),
  };
}

function rowToKnowledge(row) {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    category: row.category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLibraryCase(row) {
  const categories = normalizeCaseCategories({
    categories: row.categories,
    category: row.category,
  });
  return {
    id: row.id,
    category: categories[0],
    categories,
    reviewText: row.review_text || "",
    contextText: row.context_text || "",
    replyText: row.reply_text || "",
    createdAt: row.created_at,
  };
}

function loadKnowledgeFromFile() {
  try {
    if (!fs.existsSync(KNOWLEDGE_PATH)) return [];
    const raw = fs.readFileSync(KNOWLEDGE_PATH, "utf8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        id: x.id != null ? String(x.id) : `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        question: typeof x.question === "string" ? x.question : "",
        answer: typeof x.answer === "string" ? x.answer : "",
        category: normalizeKnowledgeCategory(x.category, null),
        createdAt: typeof x.createdAt === "string" ? x.createdAt : new Date().toISOString(),
        updatedAt: typeof x.updatedAt === "string" ? x.updatedAt : new Date().toISOString(),
      }))
      .filter((x) => x.question.trim() && x.answer.trim());
  } catch (err) {
    console.warn("knowledge.json read failed; treating as empty:", err && err.message ? err.message : err);
    return [];
  }
}

function saveKnowledgeToFile(items) {
  const safe = Array.isArray(items) ? items : [];
  try {
    fs.writeFileSync(KNOWLEDGE_PATH, JSON.stringify(safe, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("knowledge.json write failed:", err && err.message ? err.message : err);
    return false;
  }
}

async function loadKnowledge() {
  const client = getClient();
  if (!client) return loadKnowledgeFromFile();

  const { data, error } = await client
    .from("clinic_knowledge")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("Supabase loadKnowledge:", error.message);
    throw new Error("Failed to load clinic knowledge from database.");
  }
  return (data || []).map(rowToKnowledge);
}

async function saveKnowledge(items) {
  const cleaned = Array.isArray(items) ? items : [];
  const client = getClient();
  if (!client) return saveKnowledgeToFile(cleaned);

  const { data: existing, error: readErr } = await client.from("clinic_knowledge").select("id");
  if (readErr) {
    console.error("Supabase saveKnowledge read:", readErr.message);
    return false;
  }

  const newIds = new Set(cleaned.map((i) => i.id));
  const toDelete = (existing || []).map((r) => r.id).filter((id) => !newIds.has(id));
  if (toDelete.length) {
    const { error: delErr } = await client.from("clinic_knowledge").delete().in("id", toDelete);
    if (delErr) {
      console.error("Supabase saveKnowledge delete:", delErr.message);
      return false;
    }
  }

  if (cleaned.length === 0) return true;

  const rows = cleaned.map((item) => ({
    id: item.id,
    question: item.question,
    answer: item.answer,
    category: item.category,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  }));

  const { error } = await client.from("clinic_knowledge").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("Supabase saveKnowledge upsert:", error.message);
    return false;
  }
  return true;
}

async function appendKnowledge(pairs, reviewCategoryFallback) {
  const incoming = Array.isArray(pairs) ? pairs : [];
  if (!incoming.length) return loadKnowledge();

  const current = await loadKnowledge();
  const byKey = new Map();
  for (const item of current) {
    byKey.set(String(item.question || "").trim().toLowerCase(), item);
  }
  const now = new Date().toISOString();
  for (const p of incoming) {
    const q = typeof (p && p.question) === "string" ? p.question.trim() : "";
    const a = typeof (p && p.answer) === "string" ? p.answer.trim() : "";
    if (!q || !a) continue;
    const cat = normalizeKnowledgeCategory(p && p.category, reviewCategoryFallback);
    const key = q.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.answer = a;
      existing.category = cat;
      existing.updatedAt = now;
    } else {
      byKey.set(key, {
        id: `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        question: q,
        answer: a,
        category: cat,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  const merged = Array.from(byKey.values()).sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || "")
  );
  const ok = await saveKnowledge(merged);
  if (!ok) throw new Error("Failed to save clinic knowledge.");
  return merged;
}

async function loadLibrary() {
  const client = getClient();
  if (!client) return [];

  const { data, error } = await client
    .from("review_library")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase loadLibrary:", error.message);
    throw new Error("Failed to load review library from database.");
  }
  return (data || []).map(rowToLibraryCase);
}

async function saveLibrary(items) {
  const cleaned = Array.isArray(items) ? items : [];
  const client = getClient();
  if (!client) return false;

  const { data: existing, error: readErr } = await client.from("review_library").select("id");
  if (readErr) {
    console.error("Supabase saveLibrary read:", readErr.message);
    return false;
  }

  const newIds = new Set(cleaned.map((i) => i.id));
  const toDelete = (existing || []).map((r) => r.id).filter((id) => !newIds.has(id));
  if (toDelete.length) {
    const { error: delErr } = await client.from("review_library").delete().in("id", toDelete);
    if (delErr) {
      console.error("Supabase saveLibrary delete:", delErr.message);
      return false;
    }
  }

  if (cleaned.length === 0) return true;

  const rows = cleaned.map((item) => {
    const categories = normalizeCaseCategories(item);
    return {
      id: item.id,
      category: categories[0],
      categories,
      review_text: item.reviewText || "",
      context_text: item.contextText || "",
      reply_text: item.replyText || "",
      created_at: item.createdAt || new Date().toISOString(),
    };
  });

  const { error } = await client.from("review_library").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("Supabase saveLibrary upsert:", error.message);
    return false;
  }
  return true;
}

async function appendLibraryCase(entry) {
  const item = cleanLibraryItem(entry);
  if (!item) throw new Error("replyText is required.");
  if (!isDbEnabled()) {
    throw new Error("Review library requires Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  const current = await loadLibrary();
  current.unshift(item);
  const ok = await saveLibrary(current);
  if (!ok) throw new Error("Failed to save review library.");
  return item;
}

module.exports = {
  isDbEnabled,
  loadKnowledge,
  saveKnowledge,
  appendKnowledge,
  loadLibrary,
  saveLibrary,
  appendLibraryCase,
  cleanLibraryItem,
  normalizeKnowledgeCategory,
  normalizeCaseCategory,
  normalizeCaseCategories,
};
