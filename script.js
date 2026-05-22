(function () {
  "use strict";

  const STORAGE_KEY = "clinicReviewLibrary_v1";

  /**
   * Backend API base URL (no trailing slash).
   * The Express server calls Google Gemini using GEMINI_API_KEY from backend/.env only.
   * This file never contains or sends your API key — only review/context/pastCases.
   */
  const API_BASE_URL = "https://clinic-review-ai.onrender.com";
  const AUTH_STORAGE_KEY = "clinicReviewAuthToken_v1";

  let authRequired = false;
  let loginWaiters = [];

  function getAuthToken() {
    try {
      return sessionStorage.getItem(AUTH_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  function setAuthToken(token) {
    try {
      if (token) sessionStorage.setItem(AUTH_STORAGE_KEY, token);
      else sessionStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  function lockApp() {
    document.body.classList.add("auth-pending");
    const app = document.querySelector(".app");
    if (app) app.setAttribute("aria-hidden", "true");
  }

  function revealApp() {
    document.body.classList.remove("auth-pending");
    const app = document.querySelector(".app");
    if (app) app.removeAttribute("aria-hidden");
  }

  function showLoginScreen(message) {
    const screen = document.getElementById("login-screen");
    const err = document.getElementById("login-error");
    const logout = document.getElementById("btn-logout");
    lockApp();
    if (screen) screen.hidden = false;
    if (logout) logout.hidden = true;
    if (err) {
      if (message) {
        err.textContent = message;
        err.hidden = false;
      } else {
        err.textContent = "";
        err.hidden = true;
      }
    }
  }

  function hideLoginScreen() {
    const screen = document.getElementById("login-screen");
    const err = document.getElementById("login-error");
    const logout = document.getElementById("btn-logout");
    if (screen) screen.hidden = true;
    if (err) err.hidden = true;
    if (logout) logout.hidden = !authRequired;
    revealApp();
  }

  function resolveLoginWaiters() {
    loginWaiters.forEach((fn) => fn());
    loginWaiters = [];
  }

  function waitForLogin() {
    return new Promise((resolve) => {
      loginWaiters.push(resolve);
    });
  }

  async function apiFetch(path, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE_URL}${path}`, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      setAuthToken("");
      showLoginScreen("Session expired. Please sign in again.");
      throw new Error("Login required");
    }
    return res;
  }

  async function bootstrapAuth() {
    lockApp();
    try {
      const res = await fetch(`${API_BASE_URL}/auth/config`);
      const data = await res.json().catch(() => ({}));
      authRequired = Boolean(data.authRequired);
    } catch {
      authRequired = false;
      hideLoginScreen();
      return true;
    }

    if (!authRequired) {
      hideLoginScreen();
      return true;
    }

    const token = getAuthToken();
    if (token) {
      try {
        const res = await apiFetch("/knowledge");
        if (res.ok) {
          hideLoginScreen();
          return true;
        }
      } catch {
        /* show login below */
      }
    }

    showLoginScreen();
    return false;
  }

  async function submitLogin() {
    const userEl = document.getElementById("login-username");
    const passEl = document.getElementById("login-password");
    const err = document.getElementById("login-error");
    const btn = document.getElementById("login-submit");
    if (!userEl || !passEl || !btn) return;

    const username = userEl.value.trim();
    const password = passEl.value;
    if (!username || !password) {
      if (err) {
        err.textContent = "Enter username and password.";
        err.hidden = false;
      }
      return;
    }

    btn.disabled = true;
    if (err) err.hidden = true;

    try {
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (err) {
          err.textContent = data.error || "Invalid username or password.";
          err.hidden = false;
        }
        return;
      }
      if (data.token) setAuthToken(data.token);
      passEl.value = "";
      hideLoginScreen();
      resolveLoginWaiters();
      fetchKnowledge();
      fetchLibrary();
    } catch {
      if (err) {
        err.textContent = "Could not reach the server. Try again in a moment.";
        err.hidden = false;
      }
    } finally {
      btn.disabled = false;
    }
  }

  function wireAuthUi() {
    document.getElementById("login-submit")?.addEventListener("click", submitLogin);
    document.getElementById("login-password")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitLogin();
    });
    document.getElementById("btn-logout")?.addEventListener("click", () => {
      setAuthToken("");
      showLoginScreen();
    });
  }

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

  const CATEGORY_DESCRIPTIONS = {
    "Treatment / Care quality":
      "Clinical care, exam quality, medications, procedures, or follow-up medical issues.",
    "Provider interaction":
      "How a clinician communicated, listened, or behaved during the visit.",
    "Wait time / Scheduling":
      "Delays, wait times, booking, cancellations, or appointment availability.",
    "Billing / Insurance":
      "Charges, statements, copays, insurance, or payment confusion.",
    "Referral / Orders": "Referrals, labs, imaging, prescriptions, or follow-up orders.",
    "Front desk / Staff":
      "Reception, check-in, phones, or non-clinical staff (when not mainly billing).",
    Other: "Mixed topics, unclear fit, or none of the options above.",
  };

  function normalizeUserCategoryInput(raw) {
    return normalizeCategoryValue(raw);
  }

  function sameCategoryAsReviewerBonus(userCategory, c) {
    if (!userCategory) return 0;
    return coerceCategory(c.category) === userCategory ? 6 : 0;
  }

  const LEGACY_TAG_TO_CATEGORY = {
    Billing: "Billing / Insurance",
    Provider: "Provider interaction",
    Flow: "Wait time / Scheduling",
    Referral: "Referral / Orders",
    Staff: "Front desk / Staff",
  };

  function normalizeCategoryValue(raw) {
    const s = String(raw || "").trim();
    return CATEGORY_VALUE_SET.has(s) ? s : null;
  }

  function coerceCategory(raw) {
    return normalizeCategoryValue(raw) || "Other";
  }

  function inferCategoryFromLegacy(c) {
    const direct = normalizeCategoryValue(c.category);
    if (direct) return direct;
    const fromTitle = normalizeCategoryValue(c.title);
    if (fromTitle) return fromTitle;
    for (const tag of c.tags || []) {
      if (LEGACY_TAG_TO_CATEGORY[tag]) return LEGACY_TAG_TO_CATEGORY[tag];
    }
    const t = String(c.title || "").toLowerCase();
    if (t.includes("bill") || t.includes("charg") || t.includes("insurance")) return "Billing / Insurance";
    if (t.includes("wait") || t.includes("schedul") || t.includes("appoint")) return "Wait time / Scheduling";
    if (t.includes("provider") || t.includes("dr.") || t.includes("doctor") || t.includes("physician")) {
      return "Provider interaction";
    }
    if (t.includes("refer") || t.includes("lab") || t.includes("order")) return "Referral / Orders";
    if (t.includes("front desk") || t.includes("reception")) return "Front desk / Staff";
    if (t.includes("care") || t.includes("treatment") || t.includes("quality") || t.includes("clinical")) {
      return "Treatment / Care quality";
    }
    return "Other";
  }

  function normalizeLibraryCase(c) {
    const category = inferCategoryFromLegacy(c);
    return {
      id: c.id != null ? String(c.id) : "",
      category,
      reviewText: typeof c.reviewText === "string" ? c.reviewText : "",
      contextText: typeof c.contextText === "string" ? c.contextText : "",
      replyText: typeof c.replyText === "string" ? c.replyText : "",
      createdAt: c.createdAt || new Date().toISOString(),
    };
  }

  const FIXED_REPLY_OPTIONS = {
    opening: "Thank you for sharing your experience.",
    closing: "We appreciate your feedback and remain committed to quality care.",
    tone: "professional, empathetic, concise",
  };

  const SEED_CASES = [
    {
      id: "seed-1",
      category: "Wait time / Scheduling",
      reviewText:
        "Waited 45 minutes past my appointment time. Front desk seemed overwhelmed.",
      contextText:
        "Two providers ran late; front desk short-staffed. Policy: acknowledge delay, no excuses about staffing publicly; offer to discuss privately.",
      replyText:
        "Thank you for letting us know. We’re sorry for the delay and are working to improve scheduling and communication so wait times are shorter and clearer.",
      createdAt: new Date().toISOString(),
    },
    {
      id: "seed-2",
      category: "Billing / Insurance",
      reviewText:
        "Got a bill I didn’t understand. Nobody explained the charges.",
      contextText:
        "Patient had lab + visit on same cycle. Policy: direct to billing line; never argue charges in public thread.",
      replyText:
        "We’re sorry for the confusion. Please contact our billing team at the number on your statement so we can walk through each charge and resolve any issues.",
      createdAt: new Date().toISOString(),
    },
    {
      id: "seed-3",
      category: "Provider interaction",
      reviewText:
        "Dr. Smith was kind and thorough. Really listened.",
      contextText:
        "Genuine positive visit. Policy: thank them, name provider, invite continued care—no PHI.",
      replyText:
        "Thank you for your kind words. We’ll share your feedback with Dr. Smith and the team. We’re glad you felt heard and well cared for.",
      createdAt: new Date().toISOString(),
    },
  ];

  let libraryCache = [];
  let libraryUsesRemote = false;

  function loadLibraryFromLocalStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeLibraryCase);
    } catch {
      return [];
    }
  }

  function saveLibraryToLocalStorage(cases) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cases));
  }

  function loadLibrary() {
    return libraryCache.slice();
  }

  async function fetchLibrary() {
    try {
      const res = await apiFetch("/library");
      if (res.status === 503) {
        libraryUsesRemote = false;
        libraryCache = loadLibraryFromLocalStorage();
        if (libraryCache.length === 0) {
          libraryCache = SEED_CASES.map(normalizeLibraryCase);
          saveLibraryToLocalStorage(libraryCache);
        }
        renderLibraryList();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      libraryUsesRemote = true;
      libraryCache = Array.isArray(data.items) ? data.items.map(normalizeLibraryCase) : [];
      await migrateLocalLibraryIfNeeded();
      await ensureSeededRemote();
    } catch (err) {
      if (err && err.message === "Login required") return;
      console.warn("Could not load review library — using browser storage.", err);
      libraryUsesRemote = false;
      libraryCache = loadLibraryFromLocalStorage();
      if (libraryCache.length === 0) {
        libraryCache = SEED_CASES.map(normalizeLibraryCase);
        saveLibraryToLocalStorage(libraryCache);
      }
    }
    renderLibraryList();
  }

  async function saveLibraryRemote(items) {
    const res = await apiFetch("/library", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || "Save failed");
    libraryCache = Array.isArray(data.items) ? data.items.map(normalizeLibraryCase) : items;
    renderLibraryList();
  }

  async function persistLibrary(cases) {
    libraryCache = cases.map(normalizeLibraryCase);
    if (libraryUsesRemote) {
      await saveLibraryRemote(libraryCache);
    } else {
      saveLibraryToLocalStorage(libraryCache);
      renderLibraryList();
    }
  }

  async function migrateLocalLibraryIfNeeded() {
    if (!libraryUsesRemote) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const local = JSON.parse(raw);
      if (!Array.isArray(local) || local.length === 0) return;
      if (libraryCache.length > 0) return;
      libraryCache = local.map(normalizeLibraryCase);
      await saveLibraryRemote(libraryCache);
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.warn("Local library migration skipped:", err);
    }
  }

  async function ensureSeededRemote() {
    if (!libraryUsesRemote || libraryCache.length > 0) return;
    libraryCache = SEED_CASES.map(normalizeLibraryCase);
    await saveLibraryRemote(libraryCache);
  }

  function tokenize(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
  }

  function categoryOverlapBonus(queryTokens, category) {
    const cat = coerceCategory(category);
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
    score += categoryOverlapBonus(queryTokens, c.category);
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

  /** Review + internal context, used only to rank library cases (same idea as the server). */
  function textForMatching(review, situation) {
    const r = typeof review === "string" ? review.trim() : "";
    const s = typeof situation === "string" ? situation.trim() : "";
    if (!r && !s) return "";
    if (!r) return s;
    if (!s) return r;
    return `${r}\n${s}`;
  }

  function applySafetyRules(text) {
    let out = text;
    if (!out.trim()) {
      out =
        "Thank you for your feedback. If you would like to discuss your experience further, please contact our office directly.";
    }
    return out;
  }

  function composeReply(reviewText, references) {
    const parts = [FIXED_REPLY_OPTIONS.opening];
    if (references.length && references[0].case.replyText) {
      const ref = references[0].case;
      parts.push(
        "We take concerns like yours seriously. In similar situations we have responded with care—for example, addressing operational or communication issues promptly."
      );
    } else {
      parts.push(
        "We’re sorry if your experience did not meet expectations. Your comments help us improve."
      );
    }
    parts.push(FIXED_REPLY_OPTIONS.closing);
    return parts.join(" ");
  }

  /** Same case counts as the server: 0, 1, or up to 5 when you have several library entries. */
  function similarCaseDisplayCount(libraryLength) {
    if (libraryLength <= 0) return 0;
    if (libraryLength === 1) return 1;
    return Math.min(5, libraryLength);
  }

  /**
   * Same tiered logic as the server: same library category first when the user picks a category,
   * then fill remaining slots from other categories by similarity.
   */
  function pickCasesTiered(matchingText, library, n, userCat) {
    const top = [];
    if (n <= 0) return top;
    if (userCat) {
      const sameCatLib = library.filter((c) => coerceCategory(c.category) === userCat);
      const otherLib = library.filter((c) => coerceCategory(c.category) !== userCat);
      const rankedSame = findSimilarCases(matchingText, sameCatLib, sameCatLib.length, userCat);
      const rankedOther = findSimilarCases(matchingText, otherLib, otherLib.length, userCat);
      for (let i = 0; i < rankedSame.length && top.length < n; i++) {
        top.push({ ...rankedSame[i], selectionType: "SAME_CATEGORY" });
      }
      for (let i = 0; i < rankedOther.length && top.length < n; i++) {
        top.push({ ...rankedOther[i], selectionType: "FALLBACK" });
      }
      return top;
    }
    const rankedAll = findSimilarCases(matchingText, library, library.length, null);
    for (let i = 0; i < n && i < rankedAll.length; i++) {
      top.push({ ...rankedAll[i], selectionType: "GENERAL" });
    }
    return top;
  }

  function buildTransparency(matchingText, library, matches, userCategory) {
    const userCat = normalizeUserCategoryInput(userCategory);
    const styleRules = [
      `Offline prototype — tone: ${FIXED_REPLY_OPTIONS.tone}.`,
      "Uses a fixed template (opening / body / closing), not Gemini.",
      "Case selection matches the server: same category first when you pick one, then FALLBACK slots from other categories; scoring uses +2/+1/+1/+3/+6.",
    ].join("\n");

    const libLen = library.length;
    const nShow = matches.length;
    const sameN = matches.filter((m) => m.selectionType === "SAME_CATEGORY").length;
    const fbN = matches.filter((m) => m.selectionType === "FALLBACK").length;

    let selectionSummary = "";
    if (libLen === 0) {
      selectionSummary = "No library cases exist yet, so none could be selected.";
    } else if (tokenize(matchingText).length === 0 && !userCat) {
      selectionSummary = `Both the review and context fields were empty; ties are broken by sort order. Showing ${nShow} reference case(s) out of ${libLen}.`;
    } else if (userCat) {
      const inPool = library.filter((c) => coerceCategory(c.category) === userCat).length;
      if (inPool === 0) {
        selectionSummary =
          `You chose “${userCat}”, but no library cases use that category. All ${nShow} pick(s) are FALLBACK from other categories (offline prototype — same rules as the server).`;
      } else if (fbN === 0) {
        selectionSummary =
          `You chose “${userCat}”. Only SAME CATEGORY picks (${sameN}), ranked by similarity to your review + notes. Showing ${nShow} of ${libLen} library case(s).`;
      } else {
        selectionSummary =
          `You chose “${userCat}”: ${sameN} SAME CATEGORY, then ${fbN} FALLBACK to fill slots (offline prototype; mirrors server). Top ${nShow} of ${libLen}.`;
      }
    } else {
      selectionSummary = `No category selected — ranked all ${libLen} case(s) by similarity; showing top ${nShow} (max 5).`;
    }

    const replyNote =
      matches.length && matches[0].score > 0
        ? `Template reply uses your library (strongest match category: “${matches[0].case.category}”). Not generated by an AI model.`
        : "No strong keyword overlap; generic empathetic template was used.";

    const selectedCases = matches.map(({ case: c, score, selectionType }) => {
      const category = coerceCategory(c.category);
      return {
        id: c.id != null ? String(c.id) : "",
        category,
        title: category,
        score,
        selectionType,
        selectedReviewCategory: userCat || "",
        rationale: caseSelectionRationale(matchingText, c, score, userCat, selectionType),
        reviewExcerpt: (c.reviewText || "").slice(0, 200),
        contextExcerpt: (c.contextText || "").slice(0, 160),
      };
    });

    return {
      styleRules,
      selectionSummary,
      replyNote,
      selectedReviewCategory: userCat || "",
      selectedCases,
      matches,
      knowledgeCited: [],
      knowledgeInjectionSummary: "",
    };
  }

  /** Mirrors the server’s per-case rationale (keeps offline transparency consistent). */
  function caseSelectionRationale(matchingText, c, score, userCategory, selectionType) {
    const queryTokens = tokenize(matchingText);
    const userCat = normalizeUserCategoryInput(userCategory);
    const kind = selectionType || "GENERAL";
    const lead = [];
    if (kind === "SAME_CATEGORY" && userCat) {
      lead.push(
        `SAME CATEGORY — library case “${coerceCategory(
          c.category
        )}” matches your selection “${userCat}”; ranked within that group by text similarity.`
      );
    } else if (kind === "FALLBACK" && userCat) {
      lead.push(
        `FALLBACK — either no cases use “${userCat}”, or not enough to fill every slot; this row is from another category, ranked by similarity.`
      );
    } else {
      lead.push(
        "BY SIMILARITY — no category selected; this case ranked high against your text + notes across the library."
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
    const cat = coerceCategory(c.category);
    const catBonus = categoryOverlapBonus(queryTokens, cat);
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
      parts.push(`Category/theme overlap: “${cat}” aligns with words in your new review or notes (+3).`);
    }
    if (sameCatBonus > 0 && userCat) {
      parts.push(`Score includes +6 because this row’s category matches what you selected for this review.`);
    }
    if (!shared.length && catBonus === 0 && !(sameCatBonus > 0 && userCat)) {
      parts.push(`Score ${score} (weak keyword match; order may reflect ties).`);
    } else {
      parts.push(
        `Weighted score ${score} (+2 past review word, +1 reply or context word, +3 category/theme overlap, +6 same category when applicable).`
      );
    }
    return parts.join(" ");
  }

  function generateReplyPrototype(reviewText, situation, library, userCategory) {
    const limit = similarCaseDisplayCount(library.length);
    const matchingText = textForMatching(reviewText, situation);
    const userCat = normalizeUserCategoryInput(userCategory);
    const matches = pickCasesTiered(matchingText, library, limit, userCat);
    const body = composeReply(reviewText, matches);
    const reply = applySafetyRules(body);
    const transparency = buildTransparency(matchingText, library, matches, userCat);
    return { reply, transparency };
  }

  /**
   * Calls the Node.js server POST /generate-reply with:
   * - review: the public review text
   * - context.situation: internal “what happened” notes (not posted as-is)
   * - context.category: optional staff category for this review (same fixed list as the library)
   * - pastCases: your full library (server ranks and sends only top matches to Gemini)
   *
   * The server ranks `pastCases`, sends only the top matches to Gemini, and returns
   * transparency (selectedCases, selectionSummary, styleRules, replyNote).
   * If the server is off or the request fails, we fall back to the in-browser prototype.
   */
  function normalizeServerTransparency(t) {
    const safeT = t && typeof t === "object" ? t : {};
    const rawRows = Array.isArray(safeT.selectedCases) ? safeT.selectedCases : [];
    const selectedCases = rawRows.map((row) => {
      const category = coerceCategory(row.category != null ? row.category : row.title);
      return { ...row, category, title: category };
    });
    return {
      selectedCases,
      selectedReviewCategory:
        safeT.selectedReviewCategory != null && safeT.selectedReviewCategory !== undefined
          ? String(safeT.selectedReviewCategory)
          : "",
      selectionSummary: typeof safeT.selectionSummary === "string" ? safeT.selectionSummary : "",
      styleRules: typeof safeT.styleRules === "string" ? safeT.styleRules : "",
      replyNote: typeof safeT.replyNote === "string" ? safeT.replyNote : "",
      knowledgeUsed:
        Number.isFinite(safeT.knowledgeUsed) ? safeT.knowledgeUsed : 0,
      clarificationsThisTurn:
        Number.isFinite(safeT.clarificationsThisTurn) ? safeT.clarificationsThisTurn : 0,
      round: Number.isFinite(safeT.round) ? safeT.round : 1,
      knowledgeCited: Array.isArray(safeT.knowledgeCited)
        ? safeT.knowledgeCited.filter((x) => x && typeof x === "object")
        : [],
      knowledgeInjectionSummary:
        typeof safeT.knowledgeInjectionSummary === "string" ? safeT.knowledgeInjectionSummary : "",
    };
  }

  /**
   * Two-phase API call. On the first call we send `clarifications: []`. The server
   * returns either:
   *   { status: "questions", questions[], transparency } — render the clarify form.
   *   { status: "reply", reply, transparency }          — show the draft.
   *
   * Older servers may omit `status`; we treat anything with a `reply` as a reply.
   */
  async function generateReplyWithAI(reviewText, library, context, clarifications, round) {
    const situation =
      context && typeof context.situation === "string" ? context.situation : "";
    const category =
      context && typeof context.category === "string" ? context.category : "";
    const payload = {
      review: reviewText,
      context: { situation, category },
      pastCases: library,
      clarifications: Array.isArray(clarifications) ? clarifications : [],
      round: Number.isFinite(round) ? round : clarifications && clarifications.length ? 2 : 1,
    };

    try {
      const res = await apiFetch("/generate-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || res.statusText || "Request failed");
      }

      const transparency = normalizeServerTransparency(data.transparency);
      if (data.status === "questions" && Array.isArray(data.questions)) {
        return {
          status: "questions",
          questions: data.questions
            .map((q) => (typeof q === "string" ? q.trim() : ""))
            .filter(Boolean),
          round: Number.isFinite(data.round) ? data.round : payload.round,
          transparency,
        };
      }

      return {
        status: "reply",
        reply: typeof data.reply === "string" ? data.reply : "",
        transparency,
      };
    } catch (err) {
      if (err && err.message === "Login required") {
        throw err;
      }
      console.warn("Backend unreachable or error — using local prototype.", err);
      const offline = generateReplyPrototype(reviewText, situation, library, category);
      return { status: "reply", reply: offline.reply, transparency: offline.transparency };
    }
  }

  /** Reads the two text areas and calls the server (or offline prototype). */
  function generateReplyFacade(reviewText, library, clarifications, round) {
    const sitEl = document.getElementById("gen-situation");
    const catEl = document.getElementById("gen-category");
    const situation = sitEl && sitEl.value ? sitEl.value.trim() : "";
    const category = catEl && catEl.value ? catEl.value.trim() : "";
    return generateReplyWithAI(
      reviewText,
      library,
      { situation, category },
      clarifications,
      round
    );
  }

  /**
   * Render the clarification questions form. Returns a Promise that resolves to
   * an array of { question, answer } pairs (only those with non-empty answers)
   * once the user submits, or resolves to [] if the user clicks "Skip".
   */
  function renderClarifyForm(questions) {
    const card = document.getElementById("gen-clarify-card");
    const form = document.getElementById("gen-clarify-form");
    const submit = document.getElementById("btn-clarify-submit");
    const skip = document.getElementById("btn-clarify-skip");
    if (!card || !form || !submit || !skip) {
      return Promise.resolve([]);
    }

    form.innerHTML = "";
    const rows = [];
    questions.forEach((q, i) => {
      const row = document.createElement("div");
      row.className = "clarify-q";
      const label = document.createElement("label");
      label.className = "clarify-q-label";
      label.textContent = `${i + 1}. ${q}`;
      const ta = document.createElement("textarea");
      ta.rows = 3;
      ta.placeholder = "Your answer for staff/clinic records (policy or how you operate — saved to clinic knowledge)…";
      ta.dataset.question = q;
      label.appendChild(ta);
      row.appendChild(label);
      form.appendChild(row);
      rows.push(ta);
    });
    card.hidden = false;
    if (rows[0]) rows[0].focus();

    return new Promise((resolve) => {
      function cleanup() {
        submit.removeEventListener("click", onSubmit);
        skip.removeEventListener("click", onSkip);
      }
      function onSubmit() {
        const genCat = document.getElementById("gen-category");
        const kbCatRaw = genCat && genCat.value ? genCat.value.trim() : "";
        const kbCategory = normalizeCategoryValue(kbCatRaw) || "Other";
        const pairs = rows
          .map((ta) => ({
            question: ta.dataset.question || "",
            answer: ta.value.trim(),
            category: kbCategory,
          }))
          .filter((p) => p.question && p.answer);
        cleanup();
        card.hidden = true;
        resolve(pairs);
      }
      function onSkip() {
        cleanup();
        card.hidden = true;
        resolve([]);
      }
      submit.addEventListener("click", onSubmit);
      skip.addEventListener("click", onSkip);
    });
  }

  function hideClarifyForm() {
    const card = document.getElementById("gen-clarify-card");
    const form = document.getElementById("gen-clarify-form");
    if (card) card.hidden = true;
    if (form) form.innerHTML = "";
  }

  // ---- Clinic knowledge UI ---------------------------------------------------

  let knowledgeCache = [];
  let knowledgeEditingId = null;

  async function fetchKnowledge() {
    try {
      const res = await apiFetch("/knowledge");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      knowledgeCache = Array.isArray(data.items) ? data.items : [];
    } catch (err) {
      console.warn("Could not load clinic knowledge — backend may be off.", err);
      knowledgeCache = [];
    }
    renderKnowledge();
  }

  async function saveKnowledgeRemote(items) {
    const res = await apiFetch("/knowledge", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || "Save failed");
    knowledgeCache = Array.isArray(data.items) ? data.items : [];
    renderKnowledge();
  }

  function renderKnowledge() {
    const list = document.getElementById("kb-list");
    if (!list) return;
    list.innerHTML = "";
    const search = (document.getElementById("kb-search") || {}).value || "";
    const q = search.trim().toLowerCase();
    const items = q
      ? knowledgeCache.filter(
          (it) =>
            (it.question || "").toLowerCase().includes(q) ||
            (it.answer || "").toLowerCase().includes(q) ||
            coerceCategory(it.category).toLowerCase().includes(q)
        )
      : knowledgeCache;

    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "kb-empty";
      empty.textContent = q
        ? "No saved entries match that search."
        : "No clinic knowledge saved yet. The AI will ask you when it needs facts; your answers are stored here.";
      list.appendChild(empty);
      return;
    }

    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "kb-row";
      if (knowledgeEditingId === it.id) row.classList.add("kb-row-editing");

      if (knowledgeEditingId === it.id) {
        const formEl = document.createElement("div");
        formEl.className = "kb-edit-form";

        const catLbl = document.createElement("label");
        catLbl.className = "kb-field";
        catLbl.appendChild(document.createTextNode("Category "));
        const catSel = document.createElement("select");
        LIBRARY_CATEGORY_VALUES.forEach((val) => {
          const opt = document.createElement("option");
          opt.value = val;
          opt.textContent = val;
          catSel.appendChild(opt);
        });
        catSel.value = coerceCategory(it.category);
        catLbl.appendChild(catSel);
        formEl.appendChild(catLbl);

        const qLbl = document.createElement("label");
        qLbl.appendChild(document.createTextNode("Question"));
        const qInput = document.createElement("input");
        qInput.type = "text";
        qInput.value = it.question || "";
        qLbl.appendChild(qInput);
        formEl.appendChild(qLbl);

        const aLbl = document.createElement("label");
        aLbl.appendChild(document.createTextNode("Answer"));
        const aInput = document.createElement("textarea");
        aInput.rows = 3;
        aInput.value = it.answer || "";
        aLbl.appendChild(aInput);
        formEl.appendChild(aLbl);

        const actions = document.createElement("div");
        actions.className = "kb-actions";
        const save = document.createElement("button");
        save.type = "button";
        save.className = "btn primary";
        save.textContent = "Save";
        save.addEventListener("click", async () => {
          const next = knowledgeCache.map((k) =>
            k.id === it.id
              ? {
                  ...k,
                  question: qInput.value.trim(),
                  answer: aInput.value.trim(),
                  category: coerceCategory(catSel.value),
                }
              : k
          );
          knowledgeEditingId = null;
          try {
            await saveKnowledgeRemote(next);
          } catch (err) {
            alert("Could not save: " + (err && err.message ? err.message : err));
          }
        });
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => {
          knowledgeEditingId = null;
          const isNewEmpty =
            !it.question && !it.answer && String(it.id || "").startsWith("kb-new-");
          if (isNewEmpty) {
            knowledgeCache = knowledgeCache.filter((k) => k.id !== it.id);
          }
          renderKnowledge();
        });
        actions.appendChild(save);
        actions.appendChild(cancel);
        formEl.appendChild(actions);

        row.appendChild(formEl);
      } else {
        const catRow = document.createElement("p");
        catRow.className = "kb-cat";
        catRow.textContent = `Category: ${coerceCategory(it.category)}`;
        row.appendChild(catRow);
        const qEl = document.createElement("p");
        qEl.className = "kb-q";
        qEl.textContent = `Q: ${it.question || ""}`;
        row.appendChild(qEl);
        const aEl = document.createElement("p");
        aEl.className = "kb-a";
        aEl.textContent = `A: ${it.answer || ""}`;
        row.appendChild(aEl);
        const meta = document.createElement("div");
        meta.className = "kb-meta";
        const updated = it.updatedAt || it.createdAt || "";
        if (updated) meta.textContent = `Updated ${new Date(updated).toLocaleString()}`;
        row.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "kb-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "btn";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => {
          knowledgeEditingId = it.id;
          renderKnowledge();
        });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn danger";
        del.textContent = "Delete";
        del.addEventListener("click", async () => {
          if (!confirm("Delete this knowledge entry?")) return;
          const next = knowledgeCache.filter((k) => k.id !== it.id);
          try {
            await saveKnowledgeRemote(next);
          } catch (err) {
            alert("Could not delete: " + (err && err.message ? err.message : err));
          }
        });
        actions.appendChild(edit);
        actions.appendChild(del);
        row.appendChild(actions);
      }

      list.appendChild(row);
    });
  }

  function startKnowledgeAdd() {
    const tempId = `kb-new-${Date.now()}`;
    knowledgeCache = [
      { id: tempId, question: "", answer: "", createdAt: "", updatedAt: "" },
      ...knowledgeCache,
    ];
    knowledgeEditingId = tempId;
    renderKnowledge();
  }

  function updateCategoryHelper() {
    const sel = document.getElementById("lf-category");
    const help = document.getElementById("lf-category-help");
    if (!sel || !help) return;
    const v = normalizeCategoryValue(sel.value);
    if (!v) {
      help.hidden = true;
      help.textContent = "";
      return;
    }
    help.hidden = false;
    help.textContent = CATEGORY_DESCRIPTIONS[v] || "";
  }

  function setLibraryCategoryForm(value) {
    const sel = document.getElementById("lf-category");
    if (!sel) return;
    const v = normalizeCategoryValue(value);
    sel.value = v || "";
    sel.setCustomValidity("");
    updateCategoryHelper();
  }

  function getLibraryCategoryFromForm() {
    const sel = document.getElementById("lf-category");
    if (!sel || sel.value === "") return null;
    return normalizeCategoryValue(sel.value);
  }

  function openLibraryCaseModal(c) {
    const root = document.getElementById("library-case-modal");
    const bodyEl = document.getElementById("library-case-modal-body");
    const titleEl = document.getElementById("library-case-modal-title");
    if (!root || !bodyEl || !titleEl) return;

    titleEl.textContent = coerceCategory(c.category);
    bodyEl.textContent = "";

    function addSection(heading, text, emptyHint) {
      const sec = document.createElement("section");
      sec.className = "case-modal-section";
      const h = document.createElement("h3");
      h.className = "case-modal-section-title";
      h.textContent = heading;
      const p = document.createElement("p");
      p.className = "case-modal-text";
      const raw = typeof text === "string" ? text : "";
      if (!raw.trim() && emptyHint) {
        p.classList.add("case-modal-text-empty");
        p.textContent = emptyHint;
      } else {
        p.textContent = raw;
      }
      sec.appendChild(h);
      sec.appendChild(p);
      bodyEl.appendChild(sec);
    }

    addSection("Past review we received", c.reviewText || "");
    addSection("Past context (internal)", c.contextText || "", "(none saved)");
    addSection("Published reply", c.replyText || "");

    const actions = document.createElement("div");
    actions.className = "case-modal-actions";
    const kbBtn = document.createElement("button");
    kbBtn.type = "button";
    kbBtn.className = "btn";
    kbBtn.textContent = "Suggest clinic knowledge";
    kbBtn.disabled = !(c.replyText || "").trim();
    if (kbBtn.disabled) kbBtn.title = "Add a published reply to this case first.";
    kbBtn.addEventListener("click", () => {
      if (!(c.replyText || "").trim()) {
        alert("Add a published reply to this case before generating clinic knowledge.");
        return;
      }
      runKnowledgeSuggestForCase(c);
    });
    actions.appendChild(kbBtn);
    bodyEl.appendChild(actions);

    root.hidden = false;
    document.body.style.overflow = "hidden";
    document.getElementById("library-case-modal-close")?.focus();
  }

  function closeLibraryCaseModal() {
    const root = document.getElementById("library-case-modal");
    if (root) root.hidden = true;
    const ks = document.getElementById("knowledge-suggest-modal");
    if (!ks || ks.hidden) {
      document.body.style.overflow = "";
    }
  }

  function ensureKnowledgeSuggestCategorySelect() {
    const sel = document.getElementById("ks-category");
    if (!sel || sel.options.length) return;
    LIBRARY_CATEGORY_VALUES.forEach((val) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = val;
      sel.appendChild(opt);
    });
  }

  function closeKnowledgeSuggestModal() {
    const root = document.getElementById("knowledge-suggest-modal");
    if (root) root.hidden = true;
    const libModal = document.getElementById("library-case-modal");
    if (!libModal || libModal.hidden) {
      document.body.style.overflow = "";
    }
    const status = document.getElementById("knowledge-suggest-status");
    if (status) {
      status.textContent = "";
      status.classList.remove("hint-error");
    }
    const q = document.getElementById("ks-question");
    const a = document.getElementById("ks-answer");
    const cat = document.getElementById("ks-category");
    if (q) {
      q.value = "";
      q.readOnly = false;
    }
    if (a) {
      a.value = "";
      a.readOnly = false;
    }
    if (cat) cat.disabled = false;
    const save = document.getElementById("ks-save");
    if (save) save.disabled = true;
  }

  async function runKnowledgeSuggestForCase(c) {
    ensureKnowledgeSuggestCategorySelect();
    const root = document.getElementById("knowledge-suggest-modal");
    const status = document.getElementById("knowledge-suggest-status");
    const qEl = document.getElementById("ks-question");
    const aEl = document.getElementById("ks-answer");
    const catEl = document.getElementById("ks-category");
    const saveBtn = document.getElementById("ks-save");
    if (!root || !status || !qEl || !aEl || !catEl || !saveBtn) return;

    qEl.value = "";
    aEl.value = "";
    catEl.value = coerceCategory(c.category);
    catEl.disabled = true;
    qEl.readOnly = true;
    aEl.readOnly = true;
    saveBtn.disabled = true;
    status.classList.remove("hint-error");
    status.textContent = "Generating suggestion…";
    root.hidden = false;
    document.body.style.overflow = "hidden";
    document.getElementById("knowledge-suggest-close")?.focus();

    const payload = {
      libraryCase: {
        category: c.category,
        reviewText: c.reviewText,
        contextText: c.contextText,
        replyText: c.replyText,
      },
    };

    try {
      const res = await apiFetch("/suggest-knowledge-from-case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const rawBody = await res.text();
      let data = {};
      try {
        data = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        data = {};
      }
      if (!res.ok) {
        let msg = (data && data.error) || res.statusText || "Request failed";
        if (res.status === 404 && !data.error) {
          msg =
            `Not found (${res.status}). The server on ${API_BASE_URL} may be an old process or a different app — stop it, then run \`cd backend && npm start\` from this project.`;
        }
        throw new Error(msg);
      }
      qEl.value = data.question || "";
      aEl.value = data.answer || "";
      if (data.category) catEl.value = coerceCategory(data.category);
      status.textContent = "Review and edit below, then click Add to clinic knowledge.";
      saveBtn.disabled = false;
    } catch (err) {
      console.warn(err);
      status.textContent =
        (err && err.message ? err.message : "Could not generate suggestion.") + " You can close and try again.";
      status.classList.add("hint-error");
    } finally {
      catEl.disabled = false;
      qEl.readOnly = false;
      aEl.readOnly = false;
    }
  }

  async function deleteLibraryCase(id) {
    const lib = loadLibrary().filter((c) => c.id !== id);
    await persistLibrary(lib);
  }

  async function upsertLibraryCase(entry) {
    const lib = loadLibrary();
    const i = lib.findIndex((c) => c.id === entry.id);
    if (i >= 0) lib[i] = entry;
    else lib.unshift(entry);
    await persistLibrary(lib);
  }

  function renderTransparency(container, transparency) {
    const el = document.getElementById(container);
    if (!el) return;

    const kcEl = document.getElementById("gen-transparency-knowledge");
    if (kcEl) {
      kcEl.innerHTML = "";
      const inj = (transparency.knowledgeInjectionSummary || "").trim();
      if (inj) {
        const injP = document.createElement("p");
        injP.className = "hint kb-injection-summary";
        injP.textContent = inj;
        kcEl.appendChild(injP);
      }
      const cited = Array.isArray(transparency.knowledgeCited) ? transparency.knowledgeCited : [];
      if (!cited.length) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = inj
          ? "No knowledge_refs returned for this step (or empty)."
          : "None cited for this step. After a final reply, entry ids appear here when the model returns knowledge_refs.";
        kcEl.appendChild(p);
      } else {
        cited.forEach((row) => {
          const div = document.createElement("div");
          div.className = "ref-case-mini kb-cite";
          const badge = document.createElement("span");
          let badgeCls = "general";
          let badgeLabel = "SAVED";
          if (row.source === "this_generation") {
            badgeCls = "same";
            badgeLabel = "THIS GENERATION";
          } else if (row.unknown) {
            badgeCls = "fallback";
            badgeLabel = "UNRESOLVED ID";
          }
          badge.className = `trans-selection-badge ${badgeCls}`;
          badge.textContent = badgeLabel;
          div.appendChild(badge);
          const catLine = document.createElement("div");
          catLine.className = "meta";
          catLine.textContent = `Category: ${coerceCategory(row.category)}`;
          div.appendChild(catLine);
          const idLine = document.createElement("div");
          idLine.className = "meta";
          idLine.textContent = `Id: ${row.id != null ? String(row.id) : ""}`;
          div.appendChild(idLine);
          const qEl = document.createElement("div");
          qEl.className = "meta";
          qEl.textContent = `Q: ${(row.question || "").trim() || "—"}`;
          div.appendChild(qEl);
          const aEl = document.createElement("div");
          aEl.textContent = `A: ${(row.answer || "").trim() || "—"}`;
          div.appendChild(aEl);
          kcEl.appendChild(div);
        });
      }
    }

    const styleEl = document.getElementById("gen-transparency-style");
    const selWhyEl = document.getElementById("gen-transparency-selection-why");
    const replyNoteEl = document.getElementById("gen-transparency-why");

    const styleText =
      transparency.styleRules ||
      transparency.style ||
      "";
    const selectionSummary = transparency.selectionSummary || "";
    const replyNote = transparency.replyNote || transparency.why || "";

    if (styleEl) styleEl.textContent = styleText;
    if (selWhyEl) selWhyEl.textContent = selectionSummary;
    if (replyNoteEl) replyNoteEl.textContent = replyNote;

    el.innerHTML = "";

    const selCatRaw =
      transparency.selectedReviewCategory != null
        ? String(transparency.selectedReviewCategory).trim()
        : "";
    const catHead = document.createElement("p");
    catHead.className = "hint trans-selected-category";
    catHead.textContent = selCatRaw
      ? `Selected category for this review: ${selCatRaw}`
      : "Category for this review: not specified — cases ranked by similarity across all library categories.";
    el.appendChild(catHead);

    function badgeForSelectionType(st) {
      if (st === "SAME_CATEGORY") return { cls: "same", label: "SAME CATEGORY" };
      if (st === "FALLBACK") return { cls: "fallback", label: "FALLBACK" };
      return { cls: "general", label: "BY SIMILARITY" };
    }

    function appendViewButton(parent, fullCase, fallbackPartial, missingHint) {
      const actions = document.createElement("div");
      actions.className = "ref-case-actions";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn ref-case-view-btn";
      btn.textContent = "View case";
      const c =
        fullCase ||
        (fallbackPartial
          ? {
              id: fallbackPartial.id || "",
              category: fallbackPartial.category,
              reviewText: fallbackPartial.reviewText || "",
              contextText: fallbackPartial.contextText || "",
              replyText: fallbackPartial.replyText || "",
            }
          : null);
      if (!c) {
        btn.disabled = true;
        btn.title = missingHint || "Case not found in your local library.";
      } else {
        btn.addEventListener("click", () => openLibraryCaseModal(c));
      }
      actions.appendChild(btn);
      if (!fullCase && fallbackPartial) {
        const note = document.createElement("span");
        note.className = "meta ref-case-view-note";
        note.textContent = "Showing only the data sent to the model (full case not in this browser).";
        actions.appendChild(note);
      }
      parent.appendChild(actions);
    }

    function buildRowFromMeta(row) {
      const excerpt = row.reviewExcerpt || "";
      const ctx = row.contextExcerpt || "";
      const catLabel = coerceCategory(row.category != null ? row.category : row.title);
      const { cls: badgeCls, label: badgeLabel } = badgeForSelectionType(row.selectionType);

      const div = document.createElement("div");
      div.className = "ref-case-mini";

      const badge = document.createElement("span");
      badge.className = `trans-selection-badge ${badgeCls}`;
      badge.textContent = badgeLabel;
      div.appendChild(badge);

      const title = document.createElement("strong");
      title.textContent = catLabel;
      div.appendChild(title);

      const pastLabel = document.createElement("div");
      pastLabel.className = "meta trans-past-label";
      pastLabel.textContent = "Past review";
      div.appendChild(pastLabel);

      const review = document.createElement("div");
      review.textContent = `${excerpt}${excerpt.length >= 200 ? "…" : ""}`;
      div.appendChild(review);

      if (ctx) {
        const ctxEl = document.createElement("div");
        ctxEl.className = "meta trans-past-ctx";
        const strong = document.createElement("strong");
        strong.textContent = "Past internal context: ";
        ctxEl.appendChild(strong);
        ctxEl.appendChild(
          document.createTextNode(`${ctx}${ctx.length >= 160 ? "…" : ""}`)
        );
        div.appendChild(ctxEl);
      }

      const score = document.createElement("div");
      score.className = "meta";
      score.textContent = `Score: ${row.score} · Saved category: ${catLabel}`;
      div.appendChild(score);

      const rationale = document.createElement("div");
      rationale.className = "meta trans-rationale";
      rationale.textContent = row.rationale || "";
      div.appendChild(rationale);

      const lib = loadLibrary();
      const fullCase = row.id ? lib.find((x) => String(x.id) === String(row.id)) : null;
      appendViewButton(div, fullCase, row);

      return div;
    }

    const rows = transparency.selectedCases;
    if (rows && rows.length) {
      rows.forEach((row) => el.appendChild(buildRowFromMeta(row)));
      return;
    }

    const fallback = (transparency.matches || []).slice(0, 5);
    if (!fallback.length) {
      const emptyHint = document.createElement("p");
      emptyHint.className = "hint";
      emptyHint.textContent = "No library cases yet.";
      el.appendChild(emptyHint);
      return;
    }
    fallback.forEach(({ case: c, score, selectionType }) => {
      const catLabel = coerceCategory(c.category);
      const st = selectionType || "GENERAL";
      const { cls: bcls, label: badgeLabel } = badgeForSelectionType(st);

      const div = document.createElement("div");
      div.className = "ref-case-mini";

      const badge = document.createElement("span");
      badge.className = `trans-selection-badge ${bcls}`;
      badge.textContent = badgeLabel;
      div.appendChild(badge);

      const title = document.createElement("strong");
      title.textContent = catLabel;
      div.appendChild(title);

      const reviewExcerpt = (c.reviewText || "").slice(0, 160);
      const review = document.createElement("div");
      review.textContent = `${reviewExcerpt}${(c.reviewText || "").length > 160 ? "…" : ""}`;
      div.appendChild(review);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `Match score: ${score} · Category: ${catLabel}`;
      div.appendChild(meta);

      appendViewButton(div, c, null);
      el.appendChild(div);
    });
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function renderLibraryList() {
    const list = document.getElementById("library-list");
    const q = (document.getElementById("library-search") || {}).value?.trim().toLowerCase() || "";
    let lib = loadLibrary();
    if (q) {
      lib = lib.filter(
        (c) =>
          (c.category || "").toLowerCase().includes(q) ||
          (c.reviewText || "").toLowerCase().includes(q) ||
          (c.contextText || "").toLowerCase().includes(q) ||
          (c.replyText || "").toLowerCase().includes(q)
      );
    }
    list.innerHTML = "";
    if (!lib.length) {
      list.innerHTML = '<p class="hint">No cases match.</p>';
      return;
    }
    lib.forEach((c) => {
      const card = document.createElement("div");
      card.className = "lib-card";
      const catLabel = coerceCategory(c.category);
      const ctxRaw = (c.contextText || "").trim();
      const ctxDisplay =
        ctxRaw.length > 0
          ? `${escapeHtml(ctxRaw.slice(0, 100))}${ctxRaw.length > 100 ? "…" : ""}`
          : '<span class="lib-empty-field">(none saved)</span>';
      card.innerHTML = `
        <h3>${escapeHtml(catLabel)}</h3>
        <p class="excerpt"><strong>Review:</strong> ${escapeHtml((c.reviewText || "").slice(0, 100))}${(c.reviewText || "").length > 100 ? "…" : ""}</p>
        <p class="excerpt excerpt-internal"><strong>Past context (internal):</strong> ${ctxDisplay}</p>
        <p class="excerpt"><strong>Published reply:</strong> ${escapeHtml((c.replyText || "").slice(0, 100))}${(c.replyText || "").length > 100 ? "…" : ""}</p>
        <div class="lib-actions">
          <button type="button" class="btn" data-action="view" data-id="${escapeHtml(c.id)}">View full case</button>
          <button type="button" class="btn" data-action="kb-suggest" data-id="${escapeHtml(c.id)}">Suggest clinic knowledge</button>
          <button type="button" class="btn" data-action="ref" data-id="${escapeHtml(c.id)}">Use as reference</button>
          <button type="button" class="btn" data-action="edit" data-id="${escapeHtml(c.id)}">Edit</button>
          <button type="button" class="btn danger" data-action="del" data-id="${escapeHtml(c.id)}">Delete</button>
        </div>`;
      list.appendChild(card);
    });

    list.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        const action = btn.getAttribute("data-action");
        const c = loadLibrary().find((x) => x.id === id);
        if (!c) return;
        if (action === "del") {
          if (confirm("Delete this case from the library?")) {
            deleteLibraryCase(id).catch((err) => alert(err.message || err));
          }
        } else if (action === "view") {
          openLibraryCaseModal(c);
        } else if (action === "edit") {
          document.getElementById("lf-editing-id").value = c.id;
          setLibraryCategoryForm(c.category);
          document.getElementById("lf-review").value = c.reviewText;
          const lfCtx = document.getElementById("lf-context");
          if (lfCtx) lfCtx.value = c.contextText || "";
          document.getElementById("lf-reply").value = c.replyText;
          document.getElementById("library-form-title").textContent = "Edit library case";
          document.getElementById("library-form-submit").textContent = "Update";
          document.getElementById("library-form-cancel").hidden = false;
        } else if (action === "kb-suggest") {
          if (!(c.replyText || "").trim()) {
            alert("Add a published reply to this case before generating clinic knowledge.");
            return;
          }
          runKnowledgeSuggestForCase(c);
        } else if (action === "ref") {
          switchToGenerate();
          document.getElementById("gen-review").value = c.reviewText;
          const sit = document.getElementById("gen-situation");
          if (sit) sit.value = (c.contextText || "").trim();
          const gcat = document.getElementById("gen-category");
          if (gcat) gcat.value = coerceCategory(c.category);
        }
      });
    });
  }

  function switchToGenerate() {
    document.getElementById("tab-generate").classList.add("tab-active");
    document.getElementById("tab-library").classList.remove("tab-active");
    document.getElementById("tab-knowledge").classList.remove("tab-active");
    document.getElementById("tab-generate").setAttribute("aria-selected", "true");
    document.getElementById("tab-library").setAttribute("aria-selected", "false");
    document.getElementById("tab-knowledge").setAttribute("aria-selected", "false");
    document.getElementById("panel-generate").hidden = false;
    document.getElementById("panel-library").hidden = true;
    document.getElementById("panel-knowledge").hidden = true;
  }

  function switchToLibrary() {
    document.getElementById("tab-library").classList.add("tab-active");
    document.getElementById("tab-generate").classList.remove("tab-active");
    document.getElementById("tab-knowledge").classList.remove("tab-active");
    document.getElementById("tab-library").setAttribute("aria-selected", "true");
    document.getElementById("tab-generate").setAttribute("aria-selected", "false");
    document.getElementById("tab-knowledge").setAttribute("aria-selected", "false");
    document.getElementById("panel-library").hidden = false;
    document.getElementById("panel-generate").hidden = true;
    document.getElementById("panel-knowledge").hidden = true;
  }

  function switchToKnowledge() {
    document.getElementById("tab-knowledge").classList.add("tab-active");
    document.getElementById("tab-generate").classList.remove("tab-active");
    document.getElementById("tab-library").classList.remove("tab-active");
    document.getElementById("tab-knowledge").setAttribute("aria-selected", "true");
    document.getElementById("tab-generate").setAttribute("aria-selected", "false");
    document.getElementById("tab-library").setAttribute("aria-selected", "false");
    document.getElementById("panel-knowledge").hidden = false;
    document.getElementById("panel-generate").hidden = true;
    document.getElementById("panel-library").hidden = true;
    fetchKnowledge();
  }

  function resetLibraryForm() {
    document.getElementById("lf-editing-id").value = "";
    document.getElementById("library-form").reset();
    const sel = document.getElementById("lf-category");
    if (sel) sel.setCustomValidity("");
    updateCategoryHelper();
    document.getElementById("library-form-title").textContent = "Add to library";
    document.getElementById("library-form-submit").textContent = "Save";
    document.getElementById("library-form-cancel").hidden = true;
  }

  async function init() {
    wireAuthUi();
    const authed = await bootstrapAuth();
    if (!authed) await waitForLogin();

    await fetchLibrary();
    ensureKnowledgeSuggestCategorySelect();

    document.getElementById("tab-generate").addEventListener("click", switchToGenerate);
    document.getElementById("tab-library").addEventListener("click", switchToLibrary);
    document.getElementById("tab-knowledge").addEventListener("click", switchToKnowledge);

    document.getElementById("library-search").addEventListener("input", renderLibraryList);

    const lfCategorySel = document.getElementById("lf-category");
    if (lfCategorySel) {
      lfCategorySel.addEventListener("change", () => {
        lfCategorySel.setCustomValidity("");
        updateCategoryHelper();
      });
    }
    updateCategoryHelper();

    document.getElementById("library-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const lfCat = document.getElementById("lf-category");
      const category = getLibraryCategoryFromForm();
      if (!category) {
        if (lfCat) {
          lfCat.setCustomValidity("Please select a category.");
          lfCat.reportValidity();
        }
        return;
      }
      if (lfCat) lfCat.setCustomValidity("");
      const editingId = document.getElementById("lf-editing-id").value.trim();
      const lfCtx = document.getElementById("lf-context");
      const entry = {
        id: editingId || "case-" + Date.now(),
        category,
        reviewText: document.getElementById("lf-review").value.trim(),
        contextText: lfCtx ? lfCtx.value.trim() : "",
        replyText: document.getElementById("lf-reply").value.trim(),
        createdAt: editingId
          ? loadLibrary().find((x) => x.id === editingId)?.createdAt || new Date().toISOString()
          : new Date().toISOString(),
      };
      try {
        await upsertLibraryCase(entry);
        resetLibraryForm();
      } catch (err) {
        alert("Could not save: " + (err && err.message ? err.message : err));
      }
    });

    document.getElementById("library-form-cancel").addEventListener("click", () => {
      resetLibraryForm();
    });

    const genOut = document.getElementById("gen-output");
    let lastTransparency = null;

    async function runGenerateFlow(reviewText, lib) {
      genOut.value = "";
      genOut.readOnly = true;
      document.getElementById("btn-copy").disabled = true;
      document.getElementById("btn-save-library").disabled = true;
      hideClarifyForm();

      let clarifications = [];
      let round = 1;
      let lastQuestionsTransparency = null;
      // Up to 2 phases: ask once, then force a draft.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await generateReplyFacade(reviewText, lib, clarifications, round);
        if (result.status === "questions" && result.questions.length && attempt === 0) {
          lastQuestionsTransparency = result.transparency;
          renderTransparency("gen-transparency-matches", result.transparency);
          const answers = await renderClarifyForm(result.questions);
          clarifications = answers;
          round = 2;
          // Refresh saved knowledge view in case the server also persists at this stage.
          fetchKnowledge();
          continue;
        }

        genOut.value = result.reply || "";
        genOut.readOnly = false;
        lastTransparency = result.transparency || lastQuestionsTransparency;
        renderTransparency("gen-transparency-matches", lastTransparency || result.transparency);
        document.getElementById("btn-copy").disabled = !result.reply;
        document.getElementById("btn-save-library").disabled = !result.reply;
        // Saved knowledge may have grown if clarifications were submitted.
        fetchKnowledge();
        return;
      }
    }

    document.getElementById("btn-generate").addEventListener("click", () => {
      const reviewText = document.getElementById("gen-review").value.trim();
      const lib = loadLibrary();
      const btn = document.getElementById("btn-generate");
      btn.disabled = true;
      runGenerateFlow(reviewText, lib).catch((err) => {
        if (err && err.message === "Login required") return;
        console.error(err);
      }).finally(() => {
        btn.disabled = false;
      });
    });

    document.getElementById("kb-search")?.addEventListener("input", () => {
      renderKnowledge();
    });
    document.getElementById("kb-add")?.addEventListener("click", () => {
      startKnowledgeAdd();
    });
    fetchKnowledge();

    document.getElementById("btn-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(genOut.value);
      } catch {
        genOut.select();
        document.execCommand("copy");
      }
    });

    document.getElementById("btn-save-library").addEventListener("click", async () => {
      const reviewText = document.getElementById("gen-review").value.trim();
      const replyText = genOut.value.trim();
      if (!replyText) return;
      const genCat = document.getElementById("gen-category");
      let category = "Other";
      if (genCat && genCat.value && genCat.value.trim()) {
        category = normalizeCategoryValue(genCat.value) || "Other";
      }
      try {
        await upsertLibraryCase({
          id: "case-" + Date.now(),
          category,
          reviewText: reviewText || "(no review text)",
          replyText,
          createdAt: new Date().toISOString(),
        });
        switchToLibrary();
      } catch (err) {
        alert("Could not save: " + (err && err.message ? err.message : err));
      }
    });

    const modalRoot = document.getElementById("library-case-modal");
    const ksModalRoot = document.getElementById("knowledge-suggest-modal");
    document.getElementById("library-case-modal-close")?.addEventListener("click", closeLibraryCaseModal);
    document.getElementById("library-case-modal-backdrop")?.addEventListener("click", closeLibraryCaseModal);
    document.getElementById("knowledge-suggest-close")?.addEventListener("click", closeKnowledgeSuggestModal);
    document.getElementById("knowledge-suggest-backdrop")?.addEventListener("click", closeKnowledgeSuggestModal);
    document.getElementById("ks-cancel")?.addEventListener("click", closeKnowledgeSuggestModal);
    document.getElementById("ks-save")?.addEventListener("click", async () => {
      const qIn = document.getElementById("ks-question");
      const aIn = document.getElementById("ks-answer");
      const catIn = document.getElementById("ks-category");
      if (!qIn || !aIn || !catIn) return;
      const question = qIn.value.trim();
      const answer = aIn.value.trim();
      const category = coerceCategory(catIn.value);
      if (!question || !answer) {
        alert("Question and answer cannot be empty.");
        return;
      }
      try {
        await fetchKnowledge();
        const now = new Date().toISOString();
        const newItem = {
          id: `kb-${Date.now()}`,
          question,
          answer,
          category,
          createdAt: now,
          updatedAt: now,
        };
        await saveKnowledgeRemote([newItem, ...knowledgeCache]);
        closeKnowledgeSuggestModal();
      } catch (err) {
        alert("Could not save: " + (err && err.message ? err.message : err));
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (ksModalRoot && !ksModalRoot.hidden) {
        e.preventDefault();
        closeKnowledgeSuggestModal();
        return;
      }
      if (modalRoot && !modalRoot.hidden) {
        e.preventDefault();
        closeLibraryCaseModal();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      init().catch((err) => console.error(err));
    });
  } else {
    init().catch((err) => console.error(err));
  }
})();
