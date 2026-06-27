/**
 * Clinic Review AI — Express backend + Google Gemini
 * ==================================================
 *
 * STEP 1 — What runs where
 * ------------------------
 * - Your **browser** loads `index.html` + `script.js`. It does NOT know your API key.
 * - **script.js** sends a POST to `/generate-reply` with JSON:
 *     { review, context: { situation, category? }, pastCases }
 * - The server picks **2–5** library rows: **same category as `context.category` first** (ranked by
 *   text similarity), then **fallback** from other categories only if needed—unrelated categories do not
 *   fill the shortlist when enough same-category cases exist. It sends **only those rows** to Gemini
 *   (not the full library), and returns **transparency** so the UI can show what was selected and why.
 *
 * STEP 2 — One-time setup (Terminal)
 * ----------------------------------
 *   cd "/path/to/Clinic review AI/backend"
 *   npm install
 *   cp .env.example .env
 *   # Edit `.env`: paste your real GEMINI_API_KEY after the =
 *   npm start
 *
 * STEP 3 — Run the frontend
 * -------------------------
 * Open `index.html` in the browser (or use “Open with Live Server”).
 * Click **Generate reply** — the page calls `http://localhost:3000/generate-reply`.
 *
 * STEP 4 — If something fails
 * ---------------------------
 * - “API key not set” → create `backend/.env` with `GEMINI_API_KEY=...`
 * - Model errors → set `GEMINI_MODEL=` in `.env` to a model your key supports (see Google’s model list).
 * - Reply stops mid-sentence → raise `GEMINI_MAX_OUTPUT_TOKENS` (default 8192) or ensure `GEMINI_THINKING_BUDGET=0` so thinking doesn’t use the output budget.
 * - Replies show `[Clinic Phone Number]` / `[email]` → set `CLINIC_PUBLIC_PHONE` and/or `CLINIC_OPERATIONS_EMAIL` in `backend/.env` (see `.env.example`).
 * - CORS errors → keep using `cors()` below; ensure the backend URL in `script.js` matches this port.
 */

// Load `.env` from this same folder as `server.js` (works even if you start Node from elsewhere).
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const {
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
} = require("./db");
const {
  isAuditEnabled,
  createOrLoadSession,
  appendAuditEvents,
  listAuditSessions,
  getAuditSession,
  reviewPreviewFromText,
} = require("./audit");

const app = express();
const PORT = process.env.PORT || 3000;

/** Must match frontend `script.js` — Review Library and clinic knowledge share these categories only. */
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

function normalizeUserCategoryInput(raw) {
  const s = String(raw || "").trim();
  return CATEGORY_VALUE_SET.has(s) ? s : null;
}

function getCaseCategories(c) {
  if (c && Array.isArray(c.categories) && c.categories.length) {
    return normalizeCaseCategories(c);
  }
  return [normalizeCaseCategory(c)];
}

function caseHasCategory(c, userCat) {
  if (!userCat) return false;
  return getCaseCategories(c).includes(userCat);
}

function sameCategoryAsReviewerBonus(userCategory, c) {
  if (!userCategory) return 0;
  return caseHasCategory(c, userCategory) ? 6 : 0;
}

function categoryOverlapBonus(queryTokens, category) {
  const cat = normalizeCaseCategory({ category });
  if (!queryTokens.length) return 0;
  const catLower = cat.toLowerCase();
  const catToks = tokenize(cat);
  const hit = queryTokens.some(
    (qt) =>
      catLower.includes(qt) ||
      catToks.some((ct) => ct === qt || (qt.length > 2 && (ct.includes(qt) || qt.includes(ct))))
  );
  return hit ? 3 : 0;
}

function caseCategoryOverlapBonus(queryTokens, c) {
  let max = 0;
  for (const cat of getCaseCategories(c)) {
    max = Math.max(max, categoryOverlapBonus(queryTokens, cat));
  }
  return max;
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/** Optional main public / operations phone — prompts and placeholder cleanup. */
function clinicPublicPhoneFromEnv() {
  const raw = process.env.CLINIC_PUBLIC_PHONE;
  if (raw === undefined || raw === null) return "";
  return String(raw).trim();
}

/** Optional operations email — prompts and placeholder cleanup. */
function clinicOperationsEmailFromEnv() {
  const raw = process.env.CLINIC_OPERATIONS_EMAIL;
  if (raw === undefined || raw === null) return "";
  return String(raw).trim();
}

function clinicContactPromptBlock() {
  const phone = clinicPublicPhoneFromEnv();
  const email = clinicOperationsEmailFromEnv();
  if (phone && email) {
    return (
      "OPERATIONS CONTACT — use these **exact** values in the closing (no placeholders, no reformatting):\n" +
      `Phone: ${phone}\n` +
      `Email: ${email}\n\n` +
      "REPLY ENDING — **Exactly two allowed closings.** Pick **one** only. **Copy the sentence verbatim** using the phone and email above. **Do not** add a second sign-off or a different CTA. **Do not** use both A and B.\n\n" +
      "**CLOSING A —** Use when the body of the reply **already resolves or answers** the patient’s main complaint (you have explained policy, corrected a misunderstanding, or otherwise addressed what they raised) and you are **not** telling them they **must** call as the primary next step. End the **entire** public reply with **only** this sentence:\n" +
      `"If you have any other issues, please reach out directly to the operations team at ${phone} or ${email}."\n\n` +
      "**CLOSING B —** Use when the patient **needs to contact** operations for more help, **or** you **need additional information** from the patient, **or** the issue **cannot be fully handled** in this public reply alone. End the **entire** public reply with **only** this sentence (it already ends with “Thank you.”):\n" +
      `"Please contact our operations team directly at ${phone} or ${email} when you get a chance. Thank you."\n\n`
    );
  }
  if (phone || email) {
    return (
      `Configure **both** CLINIC_PUBLIC_PHONE and CLINIC_OPERATIONS_EMAIL in backend/.env so the model can use the two standard closings. Currently only partial contact is set — end with “please contact our office” or profile language; do not invent missing details.\n\n`
    );
  }
  return (
    `Set CLINIC_PUBLIC_PHONE and CLINIC_OPERATIONS_EMAIL in backend/.env. Until then, end with neutral “please contact our office” wording; do not invent phone numbers or emails.\n\n`
  );
}

/** Replace common LLM contact placeholders when we have configured values. */
function applyClinicContactPlaceholders(text) {
  let out = typeof text === "string" ? text : "";
  if (!out) return out;

  const phone = clinicPublicPhoneFromEnv();
  if (phone) {
    const phonePatterns = [
      /\[Clinic Phone Number\]/gi,
      /\[clinic phone number\]/gi,
      /\[clinic phone\]/gi,
      /\[Phone Number\]/gi,
      /\[phone number\]/gi,
      /\[YOUR PHONE NUMBER\]/gi,
      /\[Insert Phone Number\]/gi,
      /\[insert phone( number)?\]/gi,
    ];
    for (const re of phonePatterns) {
      out = out.replace(re, phone);
    }
  }

  const emailAddr = clinicOperationsEmailFromEnv();
  if (emailAddr) {
    const emailPatterns = [
      /\[Clinic Email\]/gi,
      /\[clinic email\]/gi,
      /\[Email Address\]/gi,
      /\[email address\]/gi,
      /\[YOUR EMAIL\]/gi,
      /\[insert email( address)?\]/gi,
      /\[operations email\]/gi,
    ];
    for (const re of emailPatterns) {
      out = out.replace(re, emailAddr);
    }
  }

  return out;
}

/** Output token budget; thinking models may reserve part of this unless thinking is disabled. */
function parseMaxOutputTokens() {
  const raw = process.env.GEMINI_MAX_OUTPUT_TOKENS;
  const fallback = 8192;
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(65536, Math.max(512, n));
}
const MAX_OUTPUT_TOKENS = parseMaxOutputTokens();

/**
 * Prefer SDK `response.text`; fall back to concatenating non-thought text parts.
 * Newer models may split output across parts; some hit MAX_TOKENS when the budget is too low.
 */
function extractGeminiReplyText(response) {
  if (!response) return "";
  const viaGetter = typeof response.text === "string" ? response.text : "";
  const parts = response.candidates?.[0]?.content?.parts;
  let fromParts = "";
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part || typeof part.text !== "string") continue;
      if (part.thought === true) continue;
      fromParts += part.text;
    }
  }
  const body = fromParts.length > viaGetter.length ? fromParts : viaGetter;
  return typeof body === "string" ? body.trim() : "";
}

/** Concatenate model "thought" / reasoning parts when thinking is enabled. */
function extractGeminiThoughtText(response) {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  let out = "";
  for (const part of parts) {
    if (!part || typeof part.text !== "string") continue;
    if (part.thought !== true) continue;
    out += part.text;
  }
  return out.trim();
}

/** Sanitized part list for audit debugging (text + thought flag only). */
function extractGeminiRawParts(response) {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((p) => p && typeof p.text === "string")
    .map((p) => ({
      text: p.text,
      thought: p.thought === true,
    }));
}

/** Normalize token usage from Gemini SDK response.usageMetadata. */
function extractGeminiUsageMetadata(response) {
  const u = response?.usageMetadata;
  if (!u || typeof u !== "object") return null;
  const out = {};
  const map = [
    ["promptTokenCount", u.promptTokenCount],
    ["candidatesTokenCount", u.candidatesTokenCount],
    ["outputTokenCount", u.outputTokenCount],
    ["totalTokenCount", u.totalTokenCount],
    ["thoughtsTokenCount", u.thoughtsTokenCount],
    ["cachedContentTokenCount", u.cachedContentTokenCount],
  ];
  for (const [key, val] of map) {
    if (typeof val === "number" && Number.isFinite(val)) out[key] = val;
  }
  if (out.candidatesTokenCount == null && out.outputTokenCount != null) {
    out.candidatesTokenCount = out.outputTokenCount;
  }
  return Object.keys(out).length ? out : null;
}

async function callGeminiWithAudit(ai, { model, contents, config }) {
  const requestAt = new Date().toISOString();
  const requestEvent = {
    type: "gemini_request",
    at: requestAt,
    model,
    generationConfig: config || {},
    request: { contents: typeof contents === "string" ? contents : String(contents || "") },
  };
  try {
    const response = await ai.models.generateContent({
      model,
      contents,
      config,
    });
    const responseEvent = {
      type: "gemini_response",
      at: new Date().toISOString(),
      model,
      finishReason: response?.candidates?.[0]?.finishReason || null,
      usageMetadata: extractGeminiUsageMetadata(response),
      visibleText: extractGeminiReplyText(response),
      thoughtText: extractGeminiThoughtText(response),
      rawParts: extractGeminiRawParts(response),
    };
    return { response, auditEvents: [requestEvent, responseEvent], error: null };
  } catch (err) {
    const errorEvent = {
      type: "error",
      at: new Date().toISOString(),
      phase: "gemini_request",
      message: err && err.message ? err.message : String(err),
    };
    return { response: null, auditEvents: [requestEvent, errorEvent], error: err };
  }
}

async function ensureAuditSession(sessionId, meta) {
  if (!isAuditEnabled()) return null;
  const loaded = await createOrLoadSession(sessionId, meta);
  return loaded ? loaded.id : null;
}

async function recordAuditEvents(sessionId, events, patch) {
  if (!isAuditEnabled() || !sessionId) return;
  await appendAuditEvents(sessionId, events, patch);
}

/** generationConfig: disable thinking by default (0) so visible reply gets the full output budget. */
function buildGenerationConfig() {
  const config = {
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.7,
  };
  const tbRaw = process.env.GEMINI_THINKING_BUDGET;
  if (tbRaw === undefined || tbRaw === "" || tbRaw === "0") {
    config.thinkingConfig = { thinkingBudget: 0 };
  } else if (tbRaw === "auto" || tbRaw === "-1") {
    config.thinkingConfig = { thinkingBudget: -1 };
  } else {
    const n = parseInt(String(tbRaw), 10);
    if (Number.isFinite(n)) config.thinkingConfig = { thinkingBudget: n };
  }
  return config;
}

/** At most this many approved past cases are included in the Gemini prompt (top matches only). */
const MAX_SIMILAR_CASES = 5;

app.use(express.json({ limit: "1mb" }));
app.use(cors());

/** Admin login — APP_USERNAME / APP_PASSWORD / APP_SESSION_SECRET. Staff: USER_USERNAME / USER_PASSWORD. */
function authEnabled() {
  const s = process.env.APP_SESSION_SECRET && String(process.env.APP_SESSION_SECRET).trim();
  if (!s) return false;
  const admin =
    process.env.APP_USERNAME &&
    String(process.env.APP_USERNAME).trim() &&
    process.env.APP_PASSWORD &&
    String(process.env.APP_PASSWORD);
  const user =
    process.env.USER_USERNAME &&
    String(process.env.USER_USERNAME).trim() &&
    process.env.USER_PASSWORD &&
    String(process.env.USER_PASSWORD);
  return Boolean(admin || user);
}

function userLoginEnabled() {
  const u = process.env.USER_USERNAME && String(process.env.USER_USERNAME).trim();
  const p = process.env.USER_PASSWORD && String(process.env.USER_PASSWORD);
  return Boolean(u && p);
}

function adminLoginEnabled() {
  const u = process.env.APP_USERNAME && String(process.env.APP_USERNAME).trim();
  const p = process.env.APP_PASSWORD && String(process.env.APP_PASSWORD);
  return Boolean(u && p);
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createSessionToken(role) {
  const secret = String(process.env.APP_SESSION_SECRET).trim();
  const exp = Date.now() + SESSION_TTL_MS;
  const r = role === "user" ? "user" : "admin";
  const payload = `session:${r}:${exp}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/** @returns {{ valid: boolean, role: "admin"|"user"|null, exp: number|null }} */
function parseSessionToken(token) {
  if (!authEnabled() || !token) return { valid: false, role: null, exp: null };
  const parts = String(token).split(".");
  if (parts.length !== 2) return { valid: false, role: null, exp: null };
  const [payload, sig] = parts;
  const secret = String(process.env.APP_SESSION_SECRET).trim();
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (sig.length !== expected.length || sig !== expected) {
    return { valid: false, role: null, exp: null };
  }
  const m = payload.match(/^session:(admin|user):(\d+)$/);
  if (!m) return { valid: false, role: null, exp: null };
  const exp = Number(m[2]);
  if (Date.now() >= exp) return { valid: false, role: null, exp: null };
  return { valid: true, role: m[1], exp };
}

function requireAuth(req, res, next) {
  if (!authEnabled()) {
    req.authRole = "admin";
    return next();
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const parsed = parseSessionToken(token);
  if (parsed.valid && parsed.role) {
    req.authRole = parsed.role;
    return next();
  }
  return res.status(401).json({ error: "Login required." });
}

function requireAdmin(req, res, next) {
  if (!authEnabled()) return next();
  if (req.authRole === "admin") return next();
  return res.status(403).json({ error: "Admin access required." });
}

let genaiModulePromise = null;
function loadGenAi() {
  if (!genaiModulePromise) {
    genaiModulePromise = import("@google/genai");
  }
  return genaiModulePromise;
}

// --- Similarity ranking (same logic as `script.js` so UI and server stay aligned) ---

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function scoreCase(queryTokens, c, userCategory) {
  const reviewTokens = new Set(tokenize(c.reviewText));
  const replyTokens = new Set(tokenize(c.replyText));
  const contextTokens = new Set(tokenize(c.contextText));
  let score = 0;
  for (const t of queryTokens) {
    if (reviewTokens.has(t)) score += 2;
    if (replyTokens.has(t)) score += 1;
    if (contextTokens.has(t)) score += 1;
  }
  score += caseCategoryOverlapBonus(queryTokens, c);
  score += sameCategoryAsReviewerBonus(userCategory, c);
  return score;
}

function findSimilarCases(matchingText, library, limit, userCategory) {
  const queryTokens = tokenize(matchingText);
  const userCat = normalizeUserCategoryInput(userCategory);
  if (queryTokens.length === 0 && !userCat) {
    return library.slice(0, limit).map((c) => ({ case: c, score: 0 }));
  }
  return library
    .map((c) => ({ case: c, score: scoreCase(queryTokens, c, userCat) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * How many library cases to pass to Gemini: between 2 and 5 when possible.
 * - 0 library → 0
 * - 1 library → 1
 * - 2–5 in library → use all of them (they’re the top N after sort anyway)
 * - 6+ in library → top 5 only
 */
function similarCaseCount(libraryLength) {
  if (libraryLength <= 0) return 0;
  if (libraryLength === 1) return 1;
  return Math.min(MAX_SIMILAR_CASES, libraryLength);
}

/**
 * Short explanation of overlap for one case (for transparency).
 * selectionType: SAME_CATEGORY | FALLBACK | GENERAL — how this row entered the shortlist.
 */
function caseSelectionRationale(matchingText, c, score, userCategory, selectionType) {
  const queryTokens = tokenize(matchingText);
  const userCat = normalizeUserCategoryInput(userCategory);
  const kind = selectionType || "GENERAL";
  const lead = [];
  if (kind === "SAME_CATEGORY" && userCat) {
    const tags = getCaseCategories(c).join(" · ");
    lead.push(
      `SAME CATEGORY — this library case is tagged “${tags}”, matching the category you selected for this new review (“${userCat}”). Within that group it ranked by text similarity to your review and notes.`
    );
  } else if (kind === "FALLBACK" && userCat) {
    lead.push(
      `FALLBACK — either no saved cases use “${userCat}”, or there were not enough to fill every slot; this row is from another category and was ranked by highest similarity to your review and notes.`
    );
  } else {
    lead.push(
      "BY SIMILARITY — no category was selected for this new review; this case ranked high when matching your text + notes against the whole library."
    );
  }

  if (queryTokens.length === 0 && !userCat) {
    return lead.join(" ") + " No review or context text to match on; included as a general reference.";
  }
  const reviewTokens = new Set(tokenize(c.reviewText));
  const replyTokens = new Set(tokenize(c.replyText));
  const contextTokens = new Set(tokenize(c.contextText));
  const shared = queryTokens.filter(
    (t) => reviewTokens.has(t) || replyTokens.has(t) || contextTokens.has(t)
  );
  const catTags = getCaseCategories(c);
  const catBonus = caseCategoryOverlapBonus(queryTokens, c);
  const sameCatBonus = sameCategoryAsReviewerBonus(userCat, c);
  const parts = [...lead];
  if (shared.length) {
    parts.push(
      `Overlapping words (past review / reply / internal context): ${shared.slice(0, 10).join(", ")}${
        shared.length > 10 ? "…" : ""
      }`
    );
  }
  if (catBonus > 0) {
    parts.push(`Category/theme overlap: “${catTags.join(" · ")}” aligns with words in your new review or notes (+3).`);
  }
  if (sameCatBonus > 0 && userCat) {
    parts.push(`Score includes +6 because this row’s category matches what you selected for this review.`);
  }
  if (!shared.length && catBonus === 0 && !(sameCatBonus > 0 && userCat)) {
    parts.push(`Match score ${score} (weak keyword overlap; order may reflect ties).`);
  } else {
    parts.push(
      `Weighted score ${score} (+2 past review word, +1 reply or saved context word, +3 category/theme overlap, +6 same category as your selection when applicable).`
    );
  }
  return parts.join(" ");
}

/** Same as frontend: public review + internal notes, for ranking only. */
function textForMatching(review, situation) {
  const r = typeof review === "string" ? review.trim() : "";
  const s = typeof situation === "string" ? situation.trim() : "";
  if (!r && !s) return "";
  if (!r) return s;
  if (!s) return r;
  return `${r}\n${s}`;
}

function pickCasesForGemini(reviewText, situation, pastCases, userCategory) {
  const library = Array.isArray(pastCases) ? pastCases : [];
  const matchingText = textForMatching(reviewText, situation);
  const userCat = normalizeUserCategoryInput(userCategory);
  const n = similarCaseCount(library.length);
  if (n === 0) {
    return {
      selected: [],
      selectedCasesMeta: [],
      selectedReviewCategory: userCat || "",
      selectionSummary:
        "No past cases were in your library, so none were sent to Gemini—only the new review and internal context were used.",
    };
  }

  /** Tiered pick: same category first (ranked by similarity), then fill with best other-category matches. */
  let top = [];
  if (userCat) {
    const sameCatLib = library.filter((c) => caseHasCategory(c, userCat));
    const otherLib = library.filter((c) => !caseHasCategory(c, userCat));
    const rankedSame = findSimilarCases(matchingText, sameCatLib, sameCatLib.length, userCat);
    const rankedOther = findSimilarCases(matchingText, otherLib, otherLib.length, userCat);
    for (let i = 0; i < rankedSame.length && top.length < n; i++) {
      top.push({ ...rankedSame[i], selectionType: "SAME_CATEGORY" });
    }
    for (let i = 0; i < rankedOther.length && top.length < n; i++) {
      top.push({ ...rankedOther[i], selectionType: "FALLBACK" });
    }
  } else {
    const rankedAll = findSimilarCases(matchingText, library, library.length, null);
    for (let i = 0; i < n && i < rankedAll.length; i++) {
      top.push({ ...rankedAll[i], selectionType: "GENERAL" });
    }
  }

  const sameCount = top.filter((t) => t.selectionType === "SAME_CATEGORY").length;
  const fallbackCount = top.filter((t) => t.selectionType === "FALLBACK").length;

  const selectedCasesMeta = top.map(({ case: c, score, selectionType }) => {
    const categories = getCaseCategories(c);
    const category = categories[0];
    return {
      id: c.id != null ? String(c.id) : "",
      category,
      categories,
      title: categories.join(" · "),
      score,
      selectionType,
      selectedReviewCategory: userCat || "",
      rationale: caseSelectionRationale(matchingText, c, score, userCat, selectionType),
      reviewExcerpt: (c.reviewText || "").slice(0, 200),
      contextExcerpt: (c.contextText || "").slice(0, 160),
    };
  });

  const selected = top.map((x) => x.case);

  let selectionSummary = "";
  if (userCat) {
    const inPool = library.filter((c) => caseHasCategory(c, userCat)).length;
    if (inPool === 0) {
      selectionSummary =
        `You categorized this review as “${userCat}”, but no library cases use that category. ` +
        `All ${top.length} example(s) are FALLBACK picks from other categories, ranked by similarity to your review and notes.`;
    } else if (fallbackCount === 0) {
      selectionSummary =
        `You categorized this review as “${userCat}”. Enough same-category cases existed (${inPool} in library); ` +
        `only SAME CATEGORY picks were sent (${sameCount} case(s)), each ranked by keyword/text overlap with your review and internal notes (+2/+1/+1/+3/+6 as in the app).`;
    } else {
      selectionSummary =
        `You categorized this review as “${userCat}”. We filled ${sameCount} slot(s) from that category first (highest similarity), ` +
        `then ${fallbackCount} FALLBACK slot(s) from other categories so unrelated topics do not dominate—those are the next-best matches overall.`;
    }
  } else {
    selectionSummary =
      `No category was selected for this new review, so all ${top.length} case(s) were chosen by similarity across the full library ` +
      `(same scoring: review + notes vs. each row’s past review, reply, internal context, and category themes).`;
  }

  if (tokenize(matchingText).length === 0 && !userCat) {
    selectionSummary =
      `The review and context fields were both empty, so similarity scores tie. The first ${top.length} case(s) were used as generic examples.`;
  } else if (tokenize(matchingText).length === 0 && userCat) {
    selectionSummary +=
      " With no text to match, ordering within each bucket may be arbitrary.";
  }

  return { selected, selectedCasesMeta, selectedReviewCategory: userCat || "", selectionSummary };
}

/** Fixed instructions we give Gemini (shown in the Transparency panel as “style rules”). */
const GEMINI_STYLE_RULES = [
  "Professional, empathetic, **tight** copy — prefer **~100–120 words** when the message is complete; never pad to sound fuller; same meaning with **fewer** words beats longer.",
  "Use **plain, professional** wording: avoid intensifiers and dramatic phrasing (e.g. prefer “We are sorry to hear that” over “We are very sorry”; skip “deeply/extremely/truly/incredibly” and similar unless staff context explicitly uses them).",
  "**Minimal wording:** drop filler and hedges (e.g. avoid “we also do our best to …” → say what you do directly; cut redundant qualifiers that repeat the same point). Skip generic accountability boilerplate (“we will review our guidelines internally to ensure …”) **unless** internal context or policy requires that commitment.",
  "**Empathy + reassurance (every reply):** keep each opening sentence to **one clean thought**; remove trailing clauses that only add emphasis or restate the obvious (e.g. prefer “We strive to provide transparent and efficient service.” alone over the same line plus “especially for such important appointments” when the review already names the visit type). If a tail clause does not add **new** information, delete it.",
  "Suitable for a public online review response.",
  "No diagnosis, medical advice, or protected health information.",
  "No legal admissions or guaranteed outcomes.",
  "Output only the reply text—no labels or quotes around it.",
  "Examples may include the clinic’s internal notes from that time—use them to learn what we clarify publicly vs keep private; **include public-safe incident and policy facts** from internal context when they relate to the complaint (paraphrase; never PHI or patient identifiers).",
  "Learn the relationship between past review → internal context → approved reply (what was acknowledged, when we explained vs avoided explaining, how we handled follow-up). Mimic the decision-making, not the wording.",
  "Reuse the same structure when a past case is extremely similar (same issue, similar context, similar resolution); still adapt phrasing to fit the new case. Avoid verbatim copy except for short generic empathy lines.",
  "Saved clinic knowledge (knowledge.json) is cumulative policy and standing facts—use it together with past library examples: knowledge for what is true/allowable; examples for voice, length, and structure.",
  "When staff have just answered your clarifying questions, treat those answers as **authoritative policy/facts** for this draft: reflect them clearly in the public reply’s explanation (patient-friendly paraphrase), even if past examples used vaguer wording.",
  "When staff type policy, regulatory/program rules, billing facts, or **what happened that day** into **internal context**, treat that as authorized substance for the public reply: explain it clearly for future readers (paraphrase; no PHI), and do not drop it to match vaguer library examples.",
  "When internal context describes **operational or incident facts** (timing, staffing, process followed, what was offered) that relate to the complaint, the draft must include those facts in the explanation so future readers understand what occurred—not only generic empathy.",
  "If the **review challenges** a requirement and context states the **correct rule**, the draft must **explain that rule** in the reply body—not only apologize without addressing the policy point.",
  "Reply ending: **only** CLOSING A or CLOSING B from the OPERATIONS CONTACT block — see that block for the exact sentences. No other sign-offs.",
  "Reply shape: brief empathy+reassurance, lean clarification/explanation, optional light accountability, then **exactly one** of CLOSING A or CLOSING B — one flowing reply (no outline in posted text).",
].join("\n");

/** Newest-first for prompt visibility (ISO date strings compare lexicographically). */
function sortKnowledgeForPrompt(items) {
  const arr = Array.isArray(items) ? [...items] : [];
  arr.sort((a, b) => {
    const bKey = String((b && b.updatedAt) || (b && b.createdAt) || "");
    const aKey = String((a && a.updatedAt) || (a && a.createdAt) || "");
    return bKey.localeCompare(aKey);
  });
  return arr;
}

/**
 * Build clinic knowledge for the prompt. When staff pick a review category, include only
 * knowledge in that category plus "Other" (general); omit unrelated categories.
 * Returns `{ block, injectionSummary }` for transparency.
 */
function buildKnowledgeBlock(savedKnowledge, currentClarifications, reviewCategory) {
  const savedRaw = Array.isArray(savedKnowledge) ? savedKnowledge : [];
  const sortedAll = sortKnowledgeForPrompt(savedRaw);
  const userCat = normalizeUserCategoryInput(reviewCategory);
  let saved = [];
  let injectionSummary = "";

  if (userCat) {
    const same = sortedAll.filter((k) => normalizeKnowledgeCategory(k.category, null) === userCat);
    const otherCat = sortedAll.filter((k) => normalizeKnowledgeCategory(k.category, null) === "Other");
    const sameIds = new Set(same.map((k) => String(k.id)));
    const otherOnly = otherCat.filter((k) => !sameIds.has(String(k.id)));
    saved = [...same, ...otherOnly];
    injectionSummary = `Clinic knowledge in the prompt: ${same.length} in “${userCat}”, ${otherOnly.length} in “Other” (general). Other categories excluded.`;
    if (same.length === 0 && otherOnly.length === 0) {
      injectionSummary = `Clinic knowledge in the prompt: none saved under “${userCat}” or “Other”.`;
    }
  } else {
    saved = sortedAll;
    injectionSummary =
      sortedAll.length === 0
        ? "No review category selected — no saved clinic knowledge."
        : `No review category selected — ${sortedAll.length} entr${sortedAll.length === 1 ? "y" : "ies"} (all categories, newest first).`;
  }

  const fresh = Array.isArray(currentClarifications) ? currentClarifications : [];
  const lines = [];
  if (saved.length) {
    lines.push(
      "Saved clinic knowledge (same category labels as Review Library). Each Q line: [id:…] [category:…] — copy exact ids into JSON knowledge_refs when that entry supports your answer:"
    );
    saved.forEach((k, i) => {
      const kid = (k && k.id) != null ? String(k.id) : "";
      const cat = normalizeKnowledgeCategory(k && k.category, null);
      const q = (k && k.question) || "";
      const a = (k && k.answer) || "";
      lines.push(`${i + 1}. [id:${kid}] [category:${cat}] Q: ${q}`);
      lines.push(`   A: ${a}`);
    });
  }
  if (fresh.length) {
    if (lines.length) lines.push("");
    lines.push(
      "Just-confirmed answers for this review (STAFF-AUTHORITATIVE for the final reply — use these facts/policies in the public text; patient-safe paraphrase only). Each line: [id:…] [category:…] — include each id you rely on in knowledge_refs:"
    );
    fresh.forEach((p, i) => {
      const q = (p && p.question) || "";
      const a = (p && p.answer) || "";
      const rid = `__this_round__${i}__`;
      const cat = normalizeKnowledgeCategory(p && p.category, reviewCategory);
      lines.push(`${i + 1}. [id:${rid}] [category:${cat}] Q: ${q}`);
      lines.push(`   A: ${a}`);
    });
  }
  if (!lines.length) {
    return {
      block: `Clinic knowledge base: (no saved Q/A yet — if you need clinic-specific facts, ask clarifying questions instead of guessing.)\n\n`,
      injectionSummary: userCat
        ? `No saved entries under “${userCat}” or “Other”.`
        : "No saved clinic knowledge.",
    };
  }
  return {
    block:
      `Clinic knowledge base (INTERNAL — categories match the Review Library list; synthesize entries before deciding anything is "unknown"; public-safe paraphrase only; never PHI):\n` +
      lines.join("\n") +
      `\n\n`,
    injectionSummary,
  };
}

/** Map model-reported knowledge_refs to rows for the transparency UI. */
function resolveKnowledgeCited(refs, savedKnowledge, currentClarifications) {
  const raw = Array.isArray(refs) ? refs : [];
  const saved = Array.isArray(savedKnowledge) ? savedKnowledge : [];
  const fresh = Array.isArray(currentClarifications) ? currentClarifications : [];
  const byId = new Map(saved.map((k) => [String(k.id), k]));
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (r == null || typeof r !== "string") continue;
    let id = r.trim();
    const bracket = id.match(/^\[id:([^\]]+)\]$/);
    if (bracket) id = bracket[1].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const roundMatch = /^__this_round__(\d+)__$/.exec(id);
    if (roundMatch) {
      const i = parseInt(roundMatch[1], 10);
      const p = fresh[i];
      if (p) {
        out.push({
          id,
          source: "this_generation",
          category: normalizeKnowledgeCategory(p.category, null),
          question: (p.question || "").trim(),
          answer: (p.answer || "").trim(),
        });
      } else {
        out.push({
          id,
          source: "this_generation",
          category: "Other",
          question: "",
          answer: "",
          unknown: true,
        });
      }
      continue;
    }
    const k = byId.get(id);
    if (k) {
      out.push({
        id: String(k.id),
        source: "saved",
        category: normalizeKnowledgeCategory(k.category, null),
        question: (k.question || "").trim(),
        answer: (k.answer || "").trim(),
      });
    } else {
      out.push({ id, source: "unknown", category: "", question: "", answer: "", unknown: true });
    }
  }
  return out;
}

function buildGeminiPrompt(
  review,
  situation,
  selectedCasesOnly,
  reviewCategory,
  knowledgeBlockText,
  forceReply,
  hasJustConfirmedStaffAnswers
) {
  const situationTrim = typeof situation === "string" ? situation.trim() : "";
  const situationBlock = situationTrim
    ? `Internal staff context (staff-only input — do **not** paste this block verbatim; **do** use stated **policies, regulatory/program requirements, billing facts, and what occurred that day** in the public reply’s explanation when they relate to the complaint; patient-friendly paraphrase; never PHI or patient-identifying details):
"""
${situationTrim}
"""
`
    : `Internal staff context: (none provided)

`;

  const userCat = normalizeUserCategoryInput(reviewCategory);
  const staffCategoryBlock = userCat
    ? `Staff classification of this review (internal — do not mention this in the public reply): ${userCat}\n\n`
    : "";

  const slice = Array.isArray(selectedCasesOnly) ? selectedCasesOnly : [];
  const examplesBlock = slice.length
    ? slice
        .map((c, i) => {
          const category = normalizeCaseCategory(c);
          const rev = (c && c.reviewText) || "";
          const ctx = typeof (c && c.contextText) === "string" ? c.contextText.trim() : "";
          const rep = (c && c.replyText) || "";
          return [
            `Example ${i + 1} (Category: ${category})`,
            `Past patient review: ${rev}`,
            ctx
              ? `Internal staff context for that case (NOT public — what we knew at the time): ${ctx}`
              : `Internal staff context for that case: (none recorded)`,
            `Our final approved public reply (as published): ${rep}`,
            `When you read this example, internally note: (a) the patient's main concern, (b) which parts of internal context shaped the reply, (c) how we structured the response (acknowledgement → empathy → optional clarification → follow-up/close), and (d) what we deliberately did NOT say publicly.`,
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n---\n\n")
    : "(No similar past cases were included — fall back to professional, empathetic defaults.)";

  const threeSources = `THREE SOURCES OF REASONING (apply in this order):
1) INTERNAL STAFF CONTEXT — When non-empty, it is the **primary** source for **what happened** (operational/incident narrative: timing, staffing, process followed, what was offered or done that day) and for **policy/regulatory/billing facts** the staff chose to give you (e.g. agency guidance like immigration-medical vaccine rules, seasonal facts, “standard practice” vs misconception in the review). When context facts **directly or indirectly** address the reviewer’s concern, the reply’s **explanation must carry** that substance (not only sympathy)—so future readers understand what truly occurred. If the review **asserts** a **policy misconception** and context **corrects** it, the reply’s **explanation must carry** that correction too. **Reflect** those **public-safe** facts/policies in the reply’s **explanation**—paraphrase; never PHI or patient identifiers. Do not ignore stated facts just to keep the reply shorter or to match a generic example.
2) CLINIC KNOWLEDGE — Persistent Q/A uses the **same seven categories** as Review Library. Use it when context is missing to explain **general** operations and policy in neutral, professional language. Never present an assumption or inference as a confirmed fact.
3) CLARIFICATION — If you need more information before a safe public reply, ask **the clinic staff member using this tool** (not the patient/reviewer). Output those questions **before** the final reply (see OUTPUT MODE and CLARIFYING QUESTIONS STYLE). Do not guess or invent facts.`;

  const staffConfirmedPriorityBlock =
    forceReply && hasJustConfirmedStaffAnswers
      ? `STAFF-CONFIRMED ANSWERS — **HIGHEST PRIORITY** (this request only):
The knowledge block includes **"Just-confirmed answers for this review"** — what clinic staff just told you about policy, operations, or facts needed to respond fairly.
- Treat every **A:** under that section as **binding** for this draft: state or reflect that substance in the public **reply**, especially in the **clarification/explanation** part (plain language patients understand; paraphrase; no PHI).
- Do **not** omit, soften, or contradict those facts to match a generic or “softer” line from a past example. Examples are for **tone and structure**; **staff-confirmed lines win on facts and policy** (e.g. grace periods, late policies, when visit may be deferred).
- If internal context conflicts with **just-confirmed** clarification answers on the **same** policy point, prefer **just-confirmed** for what the clinic communicates **publicly** (those are the freshest staff instructions); otherwise internal context remains **binding** for facts/policies it clearly states.
- Put **knowledge_refs** entries for each just-confirmed row you used, using the exact \`[id:__this_round__N__]\` strings from the block.

`
      : "";

  const contextPolicyPriorityBlock = situationTrim
    ? `INTERNAL CONTEXT — **AUTHORIZED FACTS FOR THE PUBLIC REPLY** (staff typed this for you — **substance must reach the public reply** when relevant):
The **Internal staff context** block may include **what occurred that day** (operations, timing, staffing constraints, process followed, what was offered or done), regulatory or program rules (e.g. civil surgeon / immigration medical requirements), seasonal or clinical facts, standard clinic policy, or **billing truth** (e.g. fee was required by guideline, **not** an improper add-on).
- **Incident / operational facts (mandatory when relevant):** When staff describe **what happened that day** and it **directly or indirectly** relates to the reviewer’s complaint, the public reply **must include** those facts in the **clarification/explanation**—patient-friendly paraphrase, not verbatim paste. Goal: future readers (patients, managers, auditors) understand **what truly occurred**, not only generic empathy. **Do not** omit authorized incident facts to keep the reply vague.
- **Public-safe only:** No PHI, no patient names/DOB/MRN/appointment identifiers, no other patients’ details, no diagnosis or medical advice. OK example: “That day we were running behind due to an emergency visit, which extended wait times.” NOT OK: patient name, chart details, or another patient’s situation.
- **Review vs context (mandatory):** When the **patient’s review disputes** whether something was **required or appropriate** (e.g. claims a flu vaccine “wasn’t required” for an immigration medical exam) and **context** states the **actual rule** (e.g. when flu vaccine is **available to the civil surgeon**, the exam process **requires** it per applicable program guidance), the public reply **must** include that **policy substance** in the **clarification/explanation**—patient-friendly paraphrase, neutral tone. **Do not** respond with only empathy/apology while **omitting** the rule that answers the complaint; that is **forbidden**.
- When context states a **rule, requirement, or factual basis** for the clinic’s action, the public **reply must incorporate** that idea in the **clarification/explanation** part so future readers see the clinic **followed applicable guidance**—not arbitrary policy. Use **patient-friendly paraphrase**; avoid long quoted blocks; **no PHI**.
- Do **not** omit or soften these points to match a vaguer **past example**. Examples = **tone/structure**; context = **authorized facts and policy** for **this** response.
- If context corrects a misunderstanding (e.g. reviewer thought something was optional when it was **required by program rules**), explain **neutrally** without arguing or blaming the reviewer.
- If context says there was **no inappropriate extra charge** (or similar), you may state that **briefly and professionally** when it addresses the concern—no guarantees, no legal posture.

`
    : "";

  const examplesAndKnowledge = `EXAMPLES + KNOWLEDGE TOGETHER:
- PAST EXAMPLES below were selected with **same-category-first** logic (like clinic knowledge). Use them for voice, structure, empathy, pacing, and review→context→reply patterns.
- Align **substance** with internal context (when present) and clinic knowledge; align **style** with examples. If an example conflicts with context/knowledge on facts, follow context and knowledge.
- When **staff-confirmed answers** are present (see STAFF-CONFIRMED ANSWERS above if shown), they outrank example-implied facts for **policy and operational truth** — still keep the reply’s **voice** like the examples where possible.
- When **internal staff context** states policy/regulatory/billing facts or **incident/operational facts** (see INTERNAL CONTEXT — AUTHORIZED FACTS FOR THE PUBLIC REPLY above if shown), those outrank **examples** for **substance**; incorporate them in the explanation.
- Without reliable context or knowledge for this incident, keep the reply **general and empathetic** — no specific claims about what happened.`;

  const clarificationRules = forceReply
    ? `OUTPUT MODE — FINAL REPLY ONLY (prior round already asked or skipped clarifications):
- Set "needs_clarification" false, "questions" [], complete "reply", and "knowledge_refs" to ids from the knowledge block you used (or []).
- **Internal context facts:** If **Internal staff context** states policies, regulatory/program requirements, billing facts, or **what happened that day** (operational/incident narrative), the public reply **must reflect** their substance when they relate to the complaint—whether they rebut a misconception, explain a requirement, or clarify **what occurred** (patient-facing paraphrase). Do not produce a reply that ignores them.
- **Staff just-confirmed facts:** If **"Just-confirmed answers for this review"** appears in the knowledge block, the public reply **must incorporate** those policies/facts where relevant (patient-facing wording). Do not produce a reply that ignores them.
- **Safe fallback:** If facts are still unclear, write a **short** reply that still **approximates** the reply structure (empathy + brief neutral line + light accountability if appropriate + **CLOSING A or B**): thank them, avoid claims you cannot verify, no blame — **do not fabricate events**. Use **CLOSING B** if follow-up is essential; otherwise **CLOSING A** when the reply still addresses what you can.`
    : `OUTPUT MODE — CLARIFY WHEN UNSURE, ELSE DRAFT:

CLARIFYING QUESTIONS STYLE (critical):
- The "questions" strings are read **only by clinic staff** (the user of this app). They are **not** shown to the reviewer or patient.
- Phrase every question to **staff** about **clinic policy, operations, or how the practice handles situations like this** — information that can be saved as clinic knowledge and reused later.
- Good patterns: "What is your policy on…?", "Does your clinic allow…?", "How should public replies handle…?", "When [situation X], what is the standard staff response?".
- **Forbidden:** addressing the reviewer or patient ("Can you confirm…", "Were you…", "Did the patient…", "What was your appointment…"). Do not write questions as if chatting with the person who left the review.
- Questions must **not** request PHI or patient identifiers.

- Prefer needs_clarification **true** (with 1–4 such staff-directed questions; "reply" "" ; knowledge_refs []) when internal context is empty or says staff cannot verify key facts, **and** clinic knowledge does not fill the gap, **or** uncertainty would change a fair public response.
- Prefer needs_clarification **false** when **Internal staff context** and/or clinic knowledge already supply the **policy/regulatory/billing facts** or **incident/operational facts** needed to respond fairly (e.g. staff pasted what occurred that day or program rules)—draft using that material rather than asking redundant staff questions.
- Do NOT re-ask what is already covered in injected knowledge (same category or "Other").
- When asking clarifications, knowledge_refs must be [].`;

  const replyFramework = `REPLY STRUCTURE (structured but flexible — write as natural **continuous** prose; **never** put numbered lists, headings, or section titles in the public "reply"):

1) **Empathy — ALWAYS** — Acknowledge the patient’s experience or frustration. **Keep it minimal:** usually **one short sentence**. **Do not** admit fault, blame, or legal liability. **Tone:** straightforward empathy — **no** intensifiers (avoid *very*, *extremely*, *deeply*, *truly*, *incredibly* before *sorry*, *disappointed*, etc.); sound human and calm, not theatrical. **Do not** tack on extra phrases that only dramatize or repeat what the review already stated.

2) **Reassurance — STRONGLY RECOMMENDED** — Reinforce clinic values (quality care, professionalism, patient safety) in **one short sentence** when used. **One core claim**—avoid comma-splice tails like “especially for …” / “particularly during …” unless they state something **new** beyond the main clause.

**Together, (1) + (2) must stay tight:** in **most** replies use **at most 2 short sentences total** for empathy + reassurance combined; **never more than 3 short sentences** for those two beats. Long openings read like generic AI — **avoid that**. **Trim redundant tails** on those sentences (importance fluff, “such an important …” echoes). The **heart of the reply** is **clarification/explanation (3)** — put every **required** fact there; **each sentence should earn its place** (no hedge clauses or duplicate ideas).

3) **Clarification / explanation — ALWAYS (main body)** — This is the **most important** part. Use **internal staff context** (including **what occurred that day**, **regulatory/program rules**, seasonal facts, or **billing clarifications** staff typed there), **clinic knowledge**, and — when present — **just-confirmed staff answers** from the clarification step. When context describes **operational or incident facts** that relate to the complaint, **include them here** (paraphrased, public-safe) so readers understand what happened—do not omit them to stay vague. Correct misunderstandings **neutrally**; explain **why** requirements apply when context authorizes you to (**patient-safe**, **non-defensive**). **Do not** sound defensive or argumentative. For a short praise/thank-you only, this may be one light sentence rather than a long policy paragraph — still keep (1)+(2) brief.

4) **Light accountability — OPTIONAL** — Only if internal context signals a concrete follow-up; **one short phrase** max. **Do not** add generic “we will review internally / ensure guidelines remain appropriate” filler when the explanation already addresses the concern. **Do not** admit wrongdoing or liability.

5) **End of reply — CLOSING A or B only —** See **OPERATIONS CONTACT / REPLY ENDING** in the prompt. **CLOSING A** when the reply **already answers** the complaint. **CLOSING B** when the patient **should contact** operations for further help, **or** you **need more information** from them, **or** the issue **is not fully resolved** in text. **Exactly one** sentence — verbatim from that block — then **stop**.

**Flexibility:** Merge beats when it reads better; keep **empathy + reassurance** short. **After drafting, mentally tighten:** remove hedges (*do our best to*, *try to* when the direct verb works), duplicate ideas, and trailing “policy review” sentences unless required; **cut** low-value tails on empathy/reassurance (*especially/particularly for such…* when the point is already clear). Prefer **~100–120 words** total when complete; **shorter is better** if meaning is unchanged. Do not promise refunds or guaranteed outcomes.`;


  return `You help a medical clinic draft a SHORT reply to an ONLINE patient review (e.g. Google).

Behave like a trained clinic staff member: use real internal context when available; use clinic knowledge when context is missing; ask when unsure; avoid guessing; explain policies neutrally; help readers understand how the clinic works.

CORE RULES (apply to the "reply" field):
- Follow **REPLY STRUCTURE** below: one smooth reply, no visible outline or labels in the posted text.
- Keep **empathy + reassurance** very short (about **2 short sentences** total in most cases, **3 short sentences max**); drop **redundant tail clauses** there in **every** reply (same rule for all topics). The **clarification/explanation** section should carry most of the reply.
- Be professional, empathetic, and **economical**: default **~100–120 words**, shorter when possible without losing required facts from context/knowledge.
- Prefer **direct** phrasing over padded or dramatic words (skip unnecessary *very/extremely/deeply* and similar); empathy stays real but **restrained**.
- **Same meaning, fewer words:** avoid hedges and redundant phrases (e.g. “regardless of payment method” when “all patients” already covers fairness); do not stack softeners before verbs.
- Do not diagnose, give medical advice, or include protected health information.
- Do not admit legal liability or promise specific outcomes (refunds, guarantees, etc.).
- The "reply" field must be ONLY the public reply text — no title, no quotes, no "Here is the reply:"
- **Final sentence:** when phone **and** email are in the prompt block, end with **exactly one** of **CLOSING A** or **CLOSING B** verbatim — no other contact paragraph.

${replyFramework}

${threeSources}

${contextPolicyPriorityBlock}${staffConfirmedPriorityBlock}${examplesAndKnowledge}

${clarificationRules}

OUTPUT FORMAT — return JSON ONLY (no prose, no markdown fences) matching:
{
  "needs_clarification": boolean,
  "questions": string[],   // 1–4 questions to CLINIC STAFF about policy/operations (never to the patient); [] when not asking
  "reply": string,         // empty string "" when needs_clarification is true
  "knowledge_refs": string[]  // EXACT [id:…] strings from clinic knowledge you relied on; [] when asking or when none applied
}

${clinicContactPromptBlock()}${knowledgeBlockText}${situationBlock}${staffCategoryBlock}Patient review to respond to (this is what the public saw):
"""
${typeof review === "string" ? review : ""}
"""

PAST EXAMPLES (${slice.length} most similar; only these were selected):
${examplesBlock}

HOW TO USE THE EXAMPLES (think silently — do NOT include this analysis in the output):
1. For each example, note concern, internal context role, response structure, and what stayed private.
2. Find patterns: explain vs defer, public-safe use of context, empathy + clarity without defensiveness.
3. Apply to the NEW case: substance from **internal context + clinic knowledge**; expression from **examples**. If unsupported, acknowledge generically and use **CLOSING B** when both contact lines are configured.
4. Prefer **tighter** sentences than a wordy example when you can keep the same substance.

COPYING RULES (when you produce a reply):
- Do NOT copy a past reply verbatim except short generic lines.
- Never copy sentences that depend on another patient’s details.

Now respond with the JSON object described in OUTPUT FORMAT.`;
}

/** Try hard to extract `{needs_clarification, questions, reply, knowledge_refs}` from model output. */
function parseModelDecision(rawText) {
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) return null;
  const candidates = [];
  candidates.push(text);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") {
        const needs = parsed.needs_clarification === true;
        const questions = Array.isArray(parsed.questions)
          ? parsed.questions
              .map((q) => (typeof q === "string" ? q.trim() : ""))
              .filter(Boolean)
              .slice(0, 4)
          : [];
        const reply = typeof parsed.reply === "string" ? parsed.reply : "";
        let knowledge_refs = [];
        if (Array.isArray(parsed.knowledge_refs)) {
          knowledge_refs = parsed.knowledge_refs
            .map((x) => (typeof x === "string" ? x.trim() : ""))
            .filter(Boolean)
            .slice(0, 48);
        }
        return { needs_clarification: needs, questions, reply, knowledge_refs };
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

const REPLY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    needs_clarification: { type: "boolean" },
    questions: { type: "array", items: { type: "string" }, maxItems: 4 },
    reply: { type: "string" },
    knowledge_refs: { type: "array", items: { type: "string" }, maxItems: 48 },
  },
  required: ["needs_clarification", "questions", "reply", "knowledge_refs"],
};

function buildJsonGenerationConfig() {
  const cfg = buildGenerationConfig();
  cfg.responseMimeType = "application/json";
  cfg.responseSchema = REPLY_RESPONSE_SCHEMA;
  return cfg;
}

const KNOWLEDGE_FROM_CASE_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string" },
    answer: { type: "string" },
    category: { type: "string" },
  },
  required: ["question", "answer", "category"],
};

function buildKnowledgeFromCaseJsonConfig() {
  const cfg = buildGenerationConfig();
  cfg.responseMimeType = "application/json";
  cfg.responseSchema = KNOWLEDGE_FROM_CASE_SCHEMA;
  cfg.temperature = 0.45;
  return cfg;
}

/** Parse `{ question, answer, category }` from model output for library → knowledge flow. */
function parseKnowledgeSuggest(rawText) {
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) return null;
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") {
        const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
        const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
        const category = typeof parsed.category === "string" ? parsed.category.trim() : "";
        if (!question || !answer) continue;
        return { question, answer, category };
      }
    } catch {
      /* next */
    }
  }
  return null;
}

function buildKnowledgeFromCasePrompt(libCase) {
  const cat = normalizeCaseCategory(libCase);
  const rev = typeof libCase.reviewText === "string" ? libCase.reviewText : "";
  const ctxRaw = typeof libCase.contextText === "string" ? libCase.contextText.trim() : "";
  const ctx = ctxRaw || "(none)";
  const rep = typeof libCase.replyText === "string" ? libCase.replyText : "";
  const cats = LIBRARY_CATEGORY_VALUES.join("; ");
  return `You help maintain a clinic's persistent **clinic knowledge** (reusable Q/A in knowledge.json for drafting public review replies).

From the Review Library case below, produce exactly ONE new knowledge entry as JSON.

Output shape:
- **category**: one of: ${cats}. Prefer the case category "${cat}" if it is in that list; otherwise use "Other".
- **question**: A concise, reusable question for **clinic staff** about policy, operations, or how to handle situations like this — not patient-specific, no PHI, not phrased as if talking to the reviewer.
- **answer**: **Ground this primarily in the published reply** below. Distill what the clinic communicates—stance, policy, or public-safe explanation—into **standing knowledge** (reusable for future reviews). Do not paste the reply verbatim; avoid patient-specific details; aim under ~120 words unless the reply implies a longer policy.

Review Library case (internal training example only):
Category: ${cat}
Past public review:
"""
${rev}
"""
Internal staff context (not for publication):
"""
${ctx}
"""
Published public reply (approved — align the **answer** with this):
"""
${rep}
"""

Return JSON only: { "question": string, "answer": string, "category": string }`;
}


/** Validate `clarifications` payload from the client. Returns clean array or throws Error. */
function normalizeClarificationsPayload(raw, reviewCategoryFallback) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("Field 'clarifications' must be an array when provided.");
  }
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = typeof item.question === "string" ? item.question.trim() : "";
    const a = typeof item.answer === "string" ? item.answer.trim() : "";
    if (q && a) {
      const category = normalizeKnowledgeCategory(item.category, reviewCategoryFallback);
      out.push({ question: q, answer: a, category });
    }
  }
  return out;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Clinic Review AI backend. POST /generate-reply, /suggest-knowledge-from-case",
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    authRequired: authEnabled(),
    dbEnabled: isDbEnabled(),
  });
});

app.get("/auth/config", (req, res) => {
  res.json({
    authRequired: authEnabled(),
    userLoginEnabled: userLoginEnabled(),
    adminLoginEnabled: adminLoginEnabled(),
  });
});

app.post("/auth/login", (req, res) => {
  if (!authEnabled()) {
    return res.json({ ok: true, authRequired: false, role: "admin" });
  }
  const { username, password } = req.body || {};
  const u = String(username || "").trim();
  const p = String(password || "");
  if (
    adminLoginEnabled() &&
    u === String(process.env.APP_USERNAME).trim() &&
    p === String(process.env.APP_PASSWORD)
  ) {
    return res.json({
      ok: true,
      authRequired: true,
      role: "admin",
      token: createSessionToken("admin"),
    });
  }
  if (
    userLoginEnabled() &&
    u === String(process.env.USER_USERNAME).trim() &&
    p === String(process.env.USER_PASSWORD)
  ) {
    return res.json({
      ok: true,
      authRequired: true,
      role: "user",
      token: createSessionToken("user"),
    });
  }
  return res.status(401).json({ error: "Invalid username or password." });
});

app.get("/auth/me", requireAuth, (req, res) => {
  res.json({ role: req.authRole || "admin" });
});

app.get("/knowledge", requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json({ items: await loadKnowledge() });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load knowledge." });
  }
});

/**
 * Replace the entire knowledge list. Used by the UI for Add/Edit/Delete.
 * Body: { items: [{ id?, question, answer, category, createdAt?, updatedAt? }] }
 */
app.put("/knowledge", requireAuth, requireAdmin, async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Field 'items' must be an array." });
  }
  const now = new Date().toISOString();
  const cleaned = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const q = typeof it.question === "string" ? it.question.trim() : "";
    const a = typeof it.answer === "string" ? it.answer.trim() : "";
    if (!q || !a) continue;
    cleaned.push({
      id: typeof it.id === "string" && it.id ? it.id : `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      question: q,
      answer: a,
      category: normalizeKnowledgeCategory(it.category, null),
      createdAt: typeof it.createdAt === "string" ? it.createdAt : now,
      updatedAt: now,
    });
  }
  try {
    const ok = await saveKnowledge(cleaned);
    if (!ok) {
      return res.status(500).json({ error: "Failed to save clinic knowledge." });
    }
    res.json({ items: cleaned });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to save knowledge." });
  }
});

app.get("/library", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!isDbEnabled()) {
      return res.status(503).json({
        error: "Review library requires Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      });
    }
    res.json({ items: await loadLibrary() });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load library." });
  }
});

/**
 * Replace the entire review library. Body: { items: [{ id?, category, reviewText, contextText?, replyText, createdAt? }] }
 */
app.put("/library", requireAuth, requireAdmin, async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({
      error: "Review library requires Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    });
  }
  const { items } = req.body || {};
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Field 'items' must be an array." });
  }
  const cleaned = [];
  for (const it of items) {
    const item = cleanLibraryItem(it);
    if (item) cleaned.push(item);
  }
  try {
    const ok = await saveLibrary(cleaned);
    if (!ok) {
      return res.status(500).json({ error: "Failed to save review library." });
    }
    res.json({ items: cleaned });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to save library." });
  }
});

/**
 * Append one library case (staff or admin). Body: { reviewText?, contextText?, categories[], replyText }
 */
app.post("/library/cases", requireAuth, async (req, res) => {
  if (!isDbEnabled()) {
    return res.status(503).json({
      error: "Review library requires Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    });
  }
  const body = req.body || {};
  const categories = body.categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ error: "Field 'categories' must be a non-empty array." });
  }
  const normalizedCats = normalizeCaseCategories({ categories });
  if (!normalizedCats.length) {
    return res.status(400).json({ error: "At least one valid category is required." });
  }
  try {
    const item = await appendLibraryCase({
      reviewText: body.reviewText,
      contextText: body.contextText,
      categories: normalizedCats,
      replyText: body.replyText,
    });
    res.json({ ok: true, item });
  } catch (err) {
    const msg = err.message || "Failed to save case.";
    if (msg.includes("replyText")) {
      return res.status(400).json({ error: "Field 'replyText' is required." });
    }
    res.status(500).json({ error: msg });
  }
});

/**
 * Body: { libraryCase: { category?, reviewText?, contextText?, replyText } }
 * Uses Gemini to suggest one Q/A; **answer** is derived from the published reply. Client reviews before PUT /knowledge.
 */
app.post("/suggest-knowledge-from-case", requireAuth, requireAdmin, async (req, res) => {
  const libCase = req.body && req.body.libraryCase;
  if (!libCase || typeof libCase !== "object") {
    return res.status(400).json({ error: "Field 'libraryCase' must be an object." });
  }
  const replyText = typeof libCase.replyText === "string" ? libCase.replyText.trim() : "";
  if (!replyText) {
    return res.status(400).json({ error: "libraryCase.replyText is required to derive knowledge." });
  }
  if (!process.env.GEMINI_API_KEY || !String(process.env.GEMINI_API_KEY).trim()) {
    return res.status(503).json({
      error:
        "Server is not configured: set GEMINI_API_KEY in backend/.env. Never put the key in the frontend.",
    });
  }

  let auditSessionId = null;
  try {
    const prompt = buildKnowledgeFromCasePrompt(libCase);
    const config = buildKnowledgeFromCaseJsonConfig();
    auditSessionId = await ensureAuditSession(null, {
      actorRole: req.authRole || "admin",
      feature: "suggest_knowledge",
      model: GEMINI_MODEL,
      reviewPreview: reviewPreviewFromText(libCase.reviewText || replyText),
    });

    if (auditSessionId) {
      await recordAuditEvents(
        auditSessionId,
        [
          {
            type: "user_input",
            at: new Date().toISOString(),
            uiStep: "knowledge-suggest-modal",
            libraryCase: libCase,
          },
        ],
        { model: GEMINI_MODEL, reviewPreview: reviewPreviewFromText(libCase.reviewText || replyText) }
      );
    }

    const { GoogleGenAI } = await loadGenAi();
    const apiKey = String(process.env.GEMINI_API_KEY).trim();
    const ai = new GoogleGenAI({ apiKey });
    const gemini = await callGeminiWithAudit(ai, {
      model: GEMINI_MODEL,
      contents: prompt,
      config,
    });

    if (auditSessionId) {
      await recordAuditEvents(auditSessionId, gemini.auditEvents, {
        status: gemini.error ? "error" : "in_progress",
        model: GEMINI_MODEL,
      });
    }

    if (gemini.error || !gemini.response) {
      throw gemini.error || new Error("Gemini request failed.");
    }

    const rawText = extractGeminiReplyText(gemini.response);
    const parsed = parseKnowledgeSuggest(rawText);
    if (!parsed) {
      if (auditSessionId) await recordAuditEvents(auditSessionId, [], { status: "error" });
      return res.status(502).json({
        error: "Gemini did not return valid JSON. Try again or shorten the case text.",
        auditSessionId,
      });
    }
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    if (!question || !answer) {
      if (auditSessionId) await recordAuditEvents(auditSessionId, [], { status: "error" });
      return res.status(502).json({ error: "Model returned empty question or answer.", auditSessionId });
    }
    const category = normalizeKnowledgeCategory(parsed.category, normalizeCaseCategory(libCase));

    if (auditSessionId) {
      await recordAuditEvents(
        auditSessionId,
        [
          {
            type: "ai_output",
            at: new Date().toISOString(),
            output: { question, answer, category },
          },
        ],
        { status: "reply" }
      );
    }

    return res.json({ question, answer, category, auditSessionId });
  } catch (err) {
    console.error("suggest-knowledge-from-case:", err && err.message ? err.message : err);
    if (auditSessionId) {
      await recordAuditEvents(
        auditSessionId,
        [
          {
            type: "error",
            at: new Date().toISOString(),
            phase: "suggest_knowledge",
            message: err && err.message ? err.message : String(err),
          },
        ],
        { status: "error" }
      );
    }
    const message = err && err.message ? err.message : "Unknown error calling Gemini.";
    return res.status(502).json({
      error: `Request failed: ${message}. Check GEMINI_API_KEY, GEMINI_MODEL, and your network.`,
      auditSessionId,
    });
  }
});

app.get("/audit-log", requireAuth, requireAdmin, async (req, res) => {
  if (!isAuditEnabled()) {
    return res.status(503).json({
      error: "Audit log requires Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    });
  }
  try {
    const limit = parseInt(String(req.query.limit || "50"), 10);
    const offset = parseInt(String(req.query.offset || "0"), 10);
    const items = await listAuditSessions({ limit, offset });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load audit log." });
  }
});

app.get("/audit-log/:id", requireAuth, requireAdmin, async (req, res) => {
  if (!isAuditEnabled()) {
    return res.status(503).json({
      error: "Audit log requires Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    });
  }
  try {
    const session = await getAuditSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Audit session not found." });
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load audit session." });
  }
});


app.post("/generate-reply", requireAuth, async (req, res) => {
  const { review, context, pastCases, clarifications, round, auditSessionId: bodyAuditId, uiStep } =
    req.body || {};

  if (review !== undefined && typeof review !== "string") {
    return res.status(400).json({ error: "Field 'review' must be a string when provided." });
  }
  if (context !== undefined && typeof context !== "object") {
    return res.status(400).json({ error: "Field 'context' must be an object when provided." });
  }
  if (pastCases !== undefined && !Array.isArray(pastCases)) {
    return res.status(400).json({ error: "Field 'pastCases' must be an array when provided." });
  }

  if (!process.env.GEMINI_API_KEY || !String(process.env.GEMINI_API_KEY).trim()) {
    return res.status(503).json({
      error:
        "Server is not configured: set GEMINI_API_KEY in backend/.env (see .env.example). Never put the key in the frontend.",
    });
  }

  if (context && context.category !== undefined && typeof context.category !== "string") {
    return res.status(400).json({ error: "Field 'context.category' must be a string when provided." });
  }

  const library = isDbEnabled()
    ? await loadLibrary()
    : Array.isArray(pastCases)
      ? pastCases
      : [];
  const situation =
    context && typeof context.situation === "string" ? context.situation : "";
  const reviewCategory =
    context && typeof context.category === "string" ? context.category : "";

  let cleanClarifications = [];
  try {
    cleanClarifications = normalizeClarificationsPayload(clarifications, reviewCategory);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const roundNum = Number.isFinite(parseInt(String(round), 10))
    ? Math.max(1, Math.min(2, parseInt(String(round), 10)))
    : cleanClarifications.length
      ? 2
      : 1;
  const forceReply = roundNum >= 2;
  const { selected, selectedCasesMeta, selectionSummary, selectedReviewCategory } = pickCasesForGemini(
    review,
    situation,
    library,
    reviewCategory
  );

  const savedKnowledgeBefore = await loadKnowledge();
  const knowledgeBundle = buildKnowledgeBlock(savedKnowledgeBefore, cleanClarifications, reviewCategory);
  const prompt = buildGeminiPrompt(
    review,
    situation,
    selected,
    reviewCategory,
    knowledgeBundle.block,
    forceReply,
    cleanClarifications.length > 0
  );

  const reviewText = typeof review === "string" ? review : "";
  const resolvedUiStep =
    typeof uiStep === "string" && uiStep.trim()
      ? uiStep.trim()
      : roundNum >= 2
        ? "clarify_submit"
        : "generate";

  let auditSessionId = await ensureAuditSession(bodyAuditId, {
    actorRole: req.authRole || "admin",
    feature: "generate_reply",
    model: GEMINI_MODEL,
    review: reviewText,
  });

  if (auditSessionId) {
    await recordAuditEvents(
      auditSessionId,
      [
        {
          type: "user_input",
          at: new Date().toISOString(),
          round: roundNum,
          uiStep: resolvedUiStep,
          review: reviewText,
          context: { situation, category: reviewCategory },
          clarifications: cleanClarifications,
        },
      ],
      { model: GEMINI_MODEL, reviewPreview: reviewPreviewFromText(reviewText) }
    );
  }

  try {
    const { GoogleGenAI } = await loadGenAi();
    const apiKey = String(process.env.GEMINI_API_KEY).trim();
    const ai = new GoogleGenAI({ apiKey });
    const geminiConfig = buildJsonGenerationConfig();
    const gemini = await callGeminiWithAudit(ai, {
      model: GEMINI_MODEL,
      contents: prompt,
      config: geminiConfig,
    });

    if (gemini.error || !gemini.response) {
      if (auditSessionId) {
        await recordAuditEvents(auditSessionId, gemini.auditEvents, { status: "error" });
      }
      throw gemini.error || new Error("Gemini request failed.");
    }

    const response = gemini.response;
    const fr = response.candidates?.[0]?.finishReason;
    if (fr && fr !== "STOP" && fr !== "FINISH_REASON_UNSPECIFIED") {
      console.warn("Gemini finishReason:", fr, "(reply may be truncated; try raising GEMINI_MAX_OUTPUT_TOKENS)");
    }

    const rawText = extractGeminiReplyText(response);
    const decision = parseModelDecision(rawText);

    if (auditSessionId) {
      const auditEvents = gemini.auditEvents.map((ev) => {
        if (ev.type !== "gemini_response") return ev;
        return {
          ...ev,
          parsed: decision || null,
          parsedFallbackText: decision ? null : rawText || null,
        };
      });
      await recordAuditEvents(auditSessionId, auditEvents, {
        model: GEMINI_MODEL,
        status: "in_progress",
      });
    }

    let knowledgeCitedForResponse = [];
    if (decision && Array.isArray(decision.knowledge_refs)) {
      knowledgeCitedForResponse = resolveKnowledgeCited(
        decision.knowledge_refs,
        savedKnowledgeBefore,
        cleanClarifications
      );
    }

    const transparencyBase = {
      selectedCases: selectedCasesMeta,
      selectedReviewCategory,
      selectionSummary,
      styleRules: `${GEMINI_STYLE_RULES}\n\nModel: ${GEMINI_MODEL} · max output ~${MAX_OUTPUT_TOKENS} tokens.`,
      knowledgeUsed: savedKnowledgeBefore.length,
      clarificationsThisTurn: cleanClarifications.length,
      round: roundNum,
      knowledgeInjectionSummary: knowledgeBundle.injectionSummary,
      knowledgeCited: knowledgeCitedForResponse,
    };

    if (!decision) {
      // Fallback: model didn't return JSON; treat raw text as reply if non-empty.
      const fallbackReply = applyClinicContactPlaceholders(typeof rawText === "string" ? rawText : "");
      if (!fallbackReply.trim()) {
        if (auditSessionId) await recordAuditEvents(auditSessionId, [], { status: "error" });
        return res.status(502).json({
          error:
            "Gemini did not return a parseable response. Try again, or increase GEMINI_MAX_OUTPUT_TOKENS.",
          auditSessionId,
        });
      }
      let savedKnowledgeAfter = savedKnowledgeBefore;
      if (cleanClarifications.length) {
        savedKnowledgeAfter = await appendKnowledge(cleanClarifications, reviewCategory);
      }
      if (auditSessionId) {
        await recordAuditEvents(
          auditSessionId,
          [{ type: "ai_output", at: new Date().toISOString(), output: { reply: fallbackReply, fallback: true } }],
          { status: "reply" }
        );
      }
      return res.json({
        status: "reply",
        reply: fallbackReply,
        auditSessionId,
        transparency: {
          ...transparencyBase,
          knowledgeUsed: savedKnowledgeAfter.length,
          knowledgeCited: [],
          replyNote:
            `Draft produced by Gemini (non-JSON fallback). Pasted review, your internal context (if any), ${selected.length} selected library case(s), and ${savedKnowledgeAfter.length} saved knowledge entrie(s). Have a staff member review before posting.`,
        },
      });
    }

    if (decision.needs_clarification && !forceReply && decision.questions.length) {
      if (auditSessionId) {
        await recordAuditEvents(
          auditSessionId,
          [
            {
              type: "ai_output",
              at: new Date().toISOString(),
              output: { questions: decision.questions, needs_clarification: true },
            },
          ],
          { status: "questions" }
        );
      }
      return res.json({
        status: "questions",
        questions: decision.questions,
        round: roundNum,
        auditSessionId,
        transparency: {
          ...transparencyBase,
          replyNote:
            `Gemini asked ${decision.questions.length} staff-facing question(s) about clinic policy/operations before drafting. Answer as the clinic (not as the patient); your answers are saved to clinic knowledge for next time.`,
        },
      });
    }

    const reply = applyClinicContactPlaceholders(decision.reply || "");
    if (!reply.trim()) {
      if (auditSessionId) await recordAuditEvents(auditSessionId, [], { status: "error" });
      return res.status(502).json({
        error:
          "Gemini returned an empty reply. Try again, increase GEMINI_MAX_OUTPUT_TOKENS, or simplify the input.",
        auditSessionId,
      });
    }

    let savedKnowledgeAfter = savedKnowledgeBefore;
    if (cleanClarifications.length) {
      savedKnowledgeAfter = await appendKnowledge(cleanClarifications, reviewCategory);
    }

    if (auditSessionId) {
      await recordAuditEvents(
        auditSessionId,
        [
          {
            type: "ai_output",
            at: new Date().toISOString(),
            output: {
              reply,
              knowledge_refs: decision.knowledge_refs || [],
              needs_clarification: false,
            },
          },
        ],
        { status: "reply" }
      );
    }

    const transparency = {
      ...transparencyBase,
      knowledgeUsed: savedKnowledgeAfter.length,
      replyNote:
        `Draft produced by Gemini using the pasted review, your internal context (if any), ${selected.length} selected library case(s), and ${savedKnowledgeAfter.length} saved knowledge entrie(s)` +
        (cleanClarifications.length
          ? ` plus ${cleanClarifications.length} just-confirmed answer(s) (now saved for next time).`
          : `.`) +
        ` Have a staff member review before posting.`,
    };

    return res.json({ status: "reply", reply, auditSessionId, transparency });
  } catch (err) {
    console.error("Gemini error:", err && err.message ? err.message : err);
    if (auditSessionId) {
      await recordAuditEvents(
        auditSessionId,
        [
          {
            type: "error",
            at: new Date().toISOString(),
            phase: "generate_reply",
            message: err && err.message ? err.message : String(err),
          },
        ],
        { status: "error" }
      );
    }
    const message =
      err && err.message
        ? err.message
        : "Unknown error calling Gemini.";
    return res.status(502).json({
      error: `Gemini request failed: ${message}. Check GEMINI_API_KEY, GEMINI_MODEL, and your network.`,
      auditSessionId,
    });
  }
});

/** JSON 404 so the browser UI gets a clear message instead of Express's HTML "Cannot POST …". */
app.use((req, res) => {
  res.status(404).json({
    error: `No API route for ${req.method} ${req.path}. If this feature is new, restart the backend from the backend folder (npm start). Another app may be using port ${PORT} — check .env PORT.`,
  });
});

app.listen(PORT, () => {
  console.log(`Clinic Review AI backend: http://localhost:${PORT}`);
  console.log(
    "Routes: GET /, GET /auth/config, GET /auth/me, POST /auth/login, GET/PUT /knowledge, GET/PUT /library, POST /library/cases, POST /generate-reply, POST /suggest-knowledge-from-case, GET /audit-log, GET /audit-log/:id"
  );
  if (isDbEnabled()) {
    console.log("Storage: Supabase (clinic_knowledge + review_library).");
  } else {
    console.warn(
      "Storage: knowledge.json file only. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for persistent cloud storage."
    );
  }
  if (isAuditEnabled()) {
    console.log("Audit log: Supabase ai_audit_sessions (admin GET /audit-log).");
  } else if (isDbEnabled()) {
    console.warn("Audit log: disabled until ai_audit_sessions table exists in Supabase.");
  }
  if (authEnabled()) {
    const parts = [];
    if (adminLoginEnabled()) parts.push("admin (APP_USERNAME)");
    if (userLoginEnabled()) parts.push("staff (USER_USERNAME)");
    console.log(`App login: enabled — ${parts.join(", ")}.`);
  } else {
    console.warn(
      "Optional: set APP_USERNAME, APP_PASSWORD, and APP_SESSION_SECRET in .env to require login."
    );
  }
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  if (clinicPublicPhoneFromEnv() || clinicOperationsEmailFromEnv()) {
    const parts = [];
    if (clinicPublicPhoneFromEnv()) parts.push("phone");
    if (clinicOperationsEmailFromEnv()) parts.push("operations email");
    console.log(`Clinic contact configured for replies: ${parts.join(", ")}`);
  } else {
    console.warn(
      "Optional: set CLINIC_PUBLIC_PHONE and/or CLINIC_OPERATIONS_EMAIL in backend/.env (see .env.example)."
    );
  }
  if (!process.env.GEMINI_API_KEY) {
    console.warn("Warning: GEMINI_API_KEY is not set. Add it to backend/.env");
  }
});
