// server.js — NotifAi News (OpenAI) — FULL FILE

import 'dotenv/config';
import express from "express";
import Parser from "rss-parser";
import fetch from "node-fetch";
import { nanoid } from "nanoid";
import { FEEDS, CATEGORIES } from "./feeds.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import { summarizeWithOpenAI, personaDebate } from "./openaiClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 8080;
const SITE_NAME = process.env.SITE_NAME || "NotifAi News";

// ---- Safe-mode & tuning flags ----
const MAX_PER_CATEGORY  = parseInt(process.env.MAX_PER_CATEGORY || "6", 10);
const DISABLE_DEBATE    = String(process.env.DISABLE_DEBATE || "false").toLowerCase() === "true";
const SAFE_MODE_SUMMARY = String(process.env.SAFE_MODE_SUMMARY || "false").toLowerCase() === "true";
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || "120000", 10);
const RSS_ONLY          = String(process.env.RSS_ONLY || "false").toLowerCase() === "true";

const DATA = path.join(__dirname, "data", "articles.json");
const SEED = path.join(__dirname, "data", "seed.json");

app.use(express.static(path.join(__dirname, "public")));

// ---- Storage helpers ----
function loadArticles() {
  try { return JSON.parse(fs.readFileSync(DATA, "utf-8")); }
  catch { return []; }
}
function saveArticles(arr) {
  fs.writeFileSync(DATA, JSON.stringify(arr, null, 2));
}

// ---- RSS parser (with media fields) ----
const parser = new Parser({
  requestOptions: {
    headers: { "User-Agent": "Mozilla/5.0 NotifAi/1.0" },
    timeout: 15000,
  },
  customFields: {
    item: [
      ['media:content',   'mediaContent',    { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail',  { keepArray: true }],
      ['content:encoded', 'contentEncoded']
    ]
  }
});

// ---- Utilities ----
function htmlToText(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function looksLikeImageUrl(u){
  return typeof u === "string" && /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(u);
}
function resolveUrl(maybeUrl, base) {
  try { return new URL(maybeUrl, base).toString(); }
  catch { return null; }
}

// --- srcset helpers (pick sharpest image) ---
function parseSrcset(srcset) {
  // e.g. "https://a.jpg 320w, https://b.jpg 640w"
  return String(srcset || "")
    .split(',')
    .map(s => s.trim())
    .map(entry => {
      const m = entry.match(/(\S+)\s+(\d+)w$/);
      return m ? { url: m[1], w: parseInt(m[2], 10) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.w - a.w);
}
function pickLargestFromSrcset($img, baseUrl) {
  const ss = $img.attr('srcset') || $img.attr('data-srcset');
  const list = parseSrcset(ss);
  if (list.length) {
    const best = resolveUrl(list[0].url, baseUrl);
    if (best && looksLikeImageUrl(best)) return best;
  }
  return null;
}

// Prefer highest-res media content / thumbnails / srcset
function pickImageFromItem(it){
  // enclosure
  const encUrl = it?.enclosure?.url || it?.enclosure?.link;
  if (looksLikeImageUrl(encUrl)) return encUrl;

  // media:content (prefer largest by width/height if present)
  const mcs = it.mediaContent;
  const mcList = Array.isArray(mcs) ? mcs : (mcs ? [mcs] : []);
  if (mcList.length) {
    const ranked = mcList
      .map(m => {
        const url = m?.$?.url || m?.url;
        const type = m?.$?.type || m?.type || "";
        const w = parseInt(m?.$?.width || m?.width || "0", 10) || 0;
        const h = parseInt(m?.$?.height || m?.height || "0", 10) || 0;
        return { url, type, score: Math.max(w, h) };
      })
      .filter(x => x.url && (looksLikeImageUrl(x.url) || String(x.type).startsWith("image/")))
      .sort((a, b) => b.score - a.score);
    if (ranked.length) return ranked[0].url;
  }

  // media:thumbnail
  const mts = it.mediaThumbnail;
  const mtList = Array.isArray(mts) ? mts : (mts ? [mts] : []);
  if (mtList.length) {
    const ranked = mtList
      .map(m => m?.$?.url || m?.url)
      .filter(u => looksLikeImageUrl(u));
    if (ranked.length) return ranked[0];
  }

  // content:encoded — first <img> with largest srcset, else src
  if (it.contentEncoded) {
    try {
      const $ = cheerio.load(it.contentEncoded);
      const firstImg = $("img[src],img[data-src],img[srcset],img[data-srcset]").first();
      if (firstImg.length) {
        const ssBest = pickLargestFromSrcset(firstImg, "");
        if (ssBest) return ssBest;
        const src = firstImg.attr("src") || firstImg.attr("data-src");
        if (src && looksLikeImageUrl(src)) return src;
      }
    } catch {}
  }

  return null;
}

async function fetchTextWithTimeout(url, ms){
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// simple retry for RSS parsing
async function tryParseFeed(parser, feedUrl, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await parser.parseURL(feedUrl);
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 600)); // tiny backoff
    }
  }
  throw lastErr;
}

async function extractOgImage(html, pageUrl){
  try {
    const $ = cheerio.load(html);
    const candidates = [
      $('meta[property="og:image:secure_url"]').attr("content"),
      $('meta[property="og:image"]').attr("content"),
      $('meta[name="og:image"]').attr("content"),
      $('meta[name="twitter:image"]').attr("content"),
      $('meta[property="twitter:image"]').attr("content"),
      $('link[rel="image_src"]').attr("href")
    ].filter(Boolean);

    for (const c of candidates) {
      const abs = resolveUrl(c, pageUrl);
      if (abs && looksLikeImageUrl(abs)) return abs;
    }

    // fallback: first <img> with largest srcset
    const firstImg = $("img[src],img[data-src],img[srcset],img[data-srcset]").first();
    if (firstImg.length) {
      const best = pickLargestFromSrcset(firstImg, pageUrl);
      if (best) return best;
      const src = firstImg.attr("src") || firstImg.attr("data-src");
      const abs = resolveUrl(src, pageUrl);
      if (abs && looksLikeImageUrl(abs)) return abs;
    }
  } catch {}
  return null;
}

// ---- AI wrappers (respect safe-mode flags) ----
async function summarize(title, text){
  if (SAFE_MODE_SUMMARY) {
    // Fast local fallback: first ~120 words from text
    const raw = (text || title || "").trim();
    if (!raw) return "Summary unavailable.";
    const words = raw.split(/\s+/).slice(0, 120);
    return words.join(" ") + (words.length >= 120 ? "…" : "");
  }
  return summarizeWithOpenAI(title, text);
}

async function makeDebate(title, excerpt){
  if (DISABLE_DEBATE) {
    return {
      socialist:  { name: "Jessica Rebella", open: "" },
      rightwing:  { name: "John Davis",      open: "" },
      conspiracy: { name: "Joe Musk",        open: "" }
    };
  }
  return personaDebate(title, excerpt);
}

// ---- Ingestion core ----
function getFeedPoolForCategory(feedItems) {
  // De-dupe & sort by date desc
  const pool = [...feedItems];
  const seen = new Set();
  const deduped = pool.filter(it => {
    const link = it.link ? new URL(it.link).toString() : "";
    if (!link || seen.has(link)) return false;
    seen.add(link);
    return true;
  }).sort((a, b) => {
    const da = a.isoDate ? new Date(a.isoDate).getTime() : 0;
    const db = b.isoDate ? new Date(b.isoDate).getTime() : 0;
    return db - da;
  });
  return deduped;
}

async function ingestOnce(){
  console.log("Starting ingestOnce...");
  const articles = loadArticles();
  const byUrl = new Map(articles.map(a => [a.url, a]));
  const results = [];
  const detail  = {};

  for (const { key: cat } of CATEGORIES) {
    let saved = 0, tried = 0;
    const bucket = [];

    // Collect items from all feeds in this category
    for (const feedUrl of FEEDS[cat]) {
      try {
        const feed = await tryParseFeed(parser, feedUrl, 2);
        bucket.push(...(feed.items || []).slice(0, 24));
      } catch (e) {
        console.error("Feed error", cat, feedUrl, e.message || e);
      }
    }

    const items = getFeedPoolForCategory(bucket);
    for (const it of items) {
      if (saved >= MAX_PER_CATEGORY) break;
      tried++;

      try {
        if (!it.link || !it.title) continue;
        const url = new URL(it.link).toString();
        if (byUrl.has(url)) continue;

        const title = it.title.trim();
        let image = pickImageFromItem(it);

        // Fetch article HTML best-effort to extract text & OG image (unless RSS_ONLY)
        let text = "";
        if (!RSS_ONLY) {
          try {
            const html = await fetchTextWithTimeout(url, 10000);
            text = htmlToText(html).slice(0, 4000);
            if (!image) {
              const og = await extractOgImage(html, url);
              if (og) image = og;
            }
          } catch {}
        }

        // Normalize/resolve image against the page URL
        if (image) {
          const abs = resolveUrl(image, url);
          if (abs) image = abs;
        }

        // RSS fallback text
        if (!text) {
          const rssText = (it.contentSnippet || it.content || it.summary || "").toString();
          text = htmlToText(rssText).slice(0, 4000);
        }
        if (!image) image = "/cover.jpg";

        // Summary (fast-local or OpenAI)
        let summary = "";
        try {
          summary = await summarize(title, text || title);
        } catch (e) {
          const rssDesc = (it.contentSnippet || it.content || it.summary || "").toString().trim();
          const base = (rssDesc || text || title || "").trim();
          summary = base ? base.slice(0, 380) + (base.length > 380 ? "…" : "") : "Summary unavailable.";
          console.error("Summarize failed, used fallback:", e.message || e);
        }

        // Debate openings only (optional; skips in safe mode)
        let debateJson = "{}";
        try {
          const debate = await makeDebate(title, (text || title).slice(0, 600));
          debateJson = JSON.stringify(debate);
        } catch (e) {
          console.error("Debate failed:", e.message || e);
        }

        const row = {
          id: nanoid(),
          url,
          title,
          source: (new URL(url)).hostname.replace(/^www\./, ""),
          image,
          category: cat,
          publishedAt: it.isoDate ? new Date(it.isoDate).toISOString() : new Date().toISOString(),
          summary,
          debateJson,
          createdAt: new Date().toISOString()
        };

        articles.push(row);
        byUrl.set(url, row);
        results.push(row);
        saved++;
      } catch (e) {
        console.error("Item error", cat, e.message || e);
      }
    }

    detail[cat] = { tried, saved };
  }

  // Always seed if this run saved nothing (keeps UI non-empty)
  if (results.length === 0) {
    try {
      const seed = JSON.parse(fs.readFileSync(SEED, "utf-8"));
      for (const s of seed) {
        if (!byUrl.has(s.url)) {
          const row = { id: nanoid(), ...s, createdAt: new Date().toISOString() };
          articles.push(row);
          byUrl.set(s.url, row);
          results.push(row);
        }
      }
      console.warn("No new items saved — seeded sample articles.");
    } catch (e) {
      console.error("Seed load failed:", e.message || e);
    }
  }

  saveArticles(articles);
  console.log("ingestOnce complete:", { added: results.length, detail });
  return { total: results.length, detail };
}

// ---- API routes ----

// Home data
app.get("/api/articles", (req, res) => {
  const articles = loadArticles();
  const out = {};
  for (const { key } of CATEGORIES) {
    out[key] = articles
      .filter(a => a.category === key)
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 24);
  }
  res.json({ site: SITE_NAME, categories: out });
});

// Article detail
app.get("/api/article/:id", (req, res) => {
  const articles = loadArticles();
  const row = articles.find(a => a.id === req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

// Blocking cron (runs end-to-end before responding)
app.get("/api/cron", async (req, res) => {
  try {
    console.time("ingestOnce");
    const result = await ingestOnce();
    console.timeEnd("ingestOnce");
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Non-blocking cron: returns immediately; ingestion runs in background
app.get("/api/cron-bg", (req, res) => {
  console.log("Queueing background ingest...");
  const label = `ingestOnce(bg) ${Date.now()}`;
  setTimeout(() => {
    console.time(label);
    ingestOnce()
      .then(r => { console.log("Background ingest result:", r); })
      .catch(e => { console.error("Background ingest error:", e.message || e); })
      .finally(() => console.timeEnd(label));
  }, 10);
  res.json({ queued: true });
});

// Lightweight self-test (key + config visibility)
app.get("/api/selftest", (req, res) => {
  res.json({
    openaiKey: !!process.env.OPENAI_API_KEY,
    models: {
      summary: process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini",
      debate:  process.env.OPENAI_DEBATE_MODEL  || "gpt-4o-mini"
    },
    flags: { DISABLE_DEBATE, SAFE_MODE_SUMMARY, MAX_PER_CATEGORY, OPENAI_TIMEOUT_MS, RSS_ONLY }
  });
});

// Background hourly ingest
setInterval(() => {
  console.log("Hourly ingest tick...");
  ingestOnce().catch(err => console.error("background ingest error:", err.message || err));
}, 60 * 60 * 1000);

// Start server
app.listen(PORT, () => {
  console.log(`▶ NotifAi News (OpenAI) on http://localhost:${PORT}`);
});
