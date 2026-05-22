#!/usr/bin/env node
/**
 * One-time import: local knowledge.json → Supabase.
 * Usage (from backend/):
 *   node scripts/import-to-supabase.js
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const fs = require("fs");
const { loadKnowledge, saveKnowledge, saveLibrary, isDbEnabled } = require("../db");

async function main() {
  if (!isDbEnabled()) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env first.");
    process.exit(1);
  }

  const knowledgePath = path.join(__dirname, "..", "knowledge.json");
  if (fs.existsSync(knowledgePath)) {
    const raw = fs.readFileSync(knowledgePath, "utf8");
    const items = JSON.parse(raw);
    if (Array.isArray(items) && items.length) {
      const ok = await saveKnowledge(items);
      console.log(ok ? `Imported ${items.length} knowledge entries.` : "Knowledge import failed.");
    } else {
      console.log("knowledge.json empty — skipped.");
    }
  } else {
    console.log("No knowledge.json — skipped.");
  }

  const libraryPath = process.argv[2];
  if (libraryPath && fs.existsSync(libraryPath)) {
    const raw = fs.readFileSync(libraryPath, "utf8");
    const items = JSON.parse(raw);
    if (Array.isArray(items) && items.length) {
      const ok = await saveLibrary(items);
      console.log(ok ? `Imported ${items.length} library cases.` : "Library import failed.");
    }
  } else {
    console.log("Optional: pass path to library JSON export to import review cases.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
