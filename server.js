// server.js — NotifAi (OpenAI) — CORS on, robust RSS ingest, no dynamic imports

import 'dotenv/config';
import express from "express";
import cors from "cors";
import Parser from "rss-parser";
import fetch from "node-fetch";
import { nanoid } from "nanoid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

import { FEEDS, CATEGORIES } from "./feeds.js";
import { summarizeWithOpenAI, personaDebate } from "./openaiClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app  = express();
const PORT = process.env.PORT || 8080;
const SITE_NAME = process.env.SITE_NAME || "NotifAi News";

app.use(cors({ origin: "*" }));
app.use(express.static(path.join(__dirname, "public")));

const DATA = path.join(__dirname, "data", "articles.json");
const SEED = path.join(__dirname, "data", "seed.json");

const parser = new Parser({
  requestOptions: {
    headers: { "User-Agent": "Mozilla/5.0 NotifAi/1.0" },
    timeout: 15000
  },
  customFields: {
    item: [
      ['media:content',   'mediaContent',    { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail',  { keepArray: true }],
      ['content:encoded', 'contentEncoded']
    ]
  }
});

function loadArticles() {
  try { return JSON.parse(fs.readFileSync(DATA, "utf-8")); }
  catch { return []; }
}
function saveArticles(arr) {
  fs.writeFileSync(DATA, JSON.stringify(arr, null, 2));
}
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
  try { return new URL(maybeUrl, base).toString(); } catch { return null; }
}
function parseSrcset(srcset) {
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

async function tryParseFeed(url, attempts = 2) {
  let last;
  for (let i=0;i<attempts;i++) {
    try { return await parser.parseURL(url); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 600)); }
  }
  throw last;
}

function pickImageFromItem(it){
  const encUrl = it?.enclosure?.url || it?.enclosure?.link;
  if (looksLikeImageUrl(encUrl)) return encUrl;

  const mcs = it.mediaContent;
  const mcList = Array.isArray(mcs) ? mcs : (mcs ? [mcs] : []);
  if (mcList.length) {
    const ranked = mcList
      .map(m => {
        const url  = m?.$?.url || m?.url;
        const type = m?.$?.type || m?.type || "";
        const w = parseInt(m?.$?.width || m?.width || "0", 10) || 0;
        const h = parseInt(m?.$?.height || m?.height || "0", 10) || 0;
        return { url, type, score: Math.max(w, h) };
      })
      .filter(x => x.url && (looksLikeImageUrl(x.url) || String(x.type).startsWith("image/")))
      .sort((a, b) => b.score - a.score);
    if (ranked.length) return ranked[0].url;
  }

  const mts = it.mediaThumbnail;
  const mtList = Array.isArray(mts) ? mts : (mts ? [mts] : []);
  if (mtList.length) {
    const ranked = mtList
      .map(m => m?.$?.url || m?.url)
      .filter(u => looksLikeImageUrl(u));
    if (ranked.length) return ranked[0];
  }

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

function getFeedPool(items) {
  const seen = new Set();
  const pool = (items || [])
    .filter(i => i.link && i.title)
    .map(i => ({ link: new URL(i.link).toString(), item: i }))
    .filter(({link}) => {
      if (seen.has(link)) return false;
      seen.add(link); return true;
    })
    .map(({item}) => item);

  return pool.sort((a,b) => {
    const da = a.isoDate ? new Date(a.isoDate).getTime() : 0;
    const db = b.isoDate ? new Date(b.isoDate).getTime() : 0;
    return db - da;
  });
}

const MAX_PER_CATEGORY = parseInt(process.env.MAX_PER_CATEGORY || "6", 10);

async function ingestOnce(){
  console.log("Starting ingestOnce...");
  let articles = loadArticles();
  if (!Array.isArray(articles)) articles = [];
  const byUrl = new Map(articles.map(a => [a.url, a]));
  const results = [];
  const detail  = {};

  for (const { key: cat } of CATEGORIES) {
    let saved = 0, tried = 0;
    const bucket = [];

    for (const feedUrl of FEEDS[cat]) {
      try {
        const feed = await tryParseFeed(feedUrl, 2);
        bucket.push(...(feed.items || []).slice(0, 24));
      } catch (e) {
        console.error("Feed error", cat, feedUrl, e.message || e);
      }
    }

    const items = getFeedPool(bucket);
    for (const it of items) {
      if (saved >= MAX_PER_CATEGORY) break;
      tried++;
      try {
        const url   = new URL(it.link).toString();
        if (byUrl.has(url)) continue;

        const title = it.title?.trim() || "(untitled)";
        let image   = pickImageFromItem(it);
        if (image) {
          const abs = resolveUrl(image, url);
          if (abs) image = abs;
        }
        if (!image) image = "/cover.jpg";

        const source = (new URL(url)).hostname.replace(/^www\./, "");
        const publishedAt = it.isoDate ? new Date(it.isoDate).toISOString() : new Date().toISOString();

        const rssText = (it.contentSnippet || it.content || it.summary || "").toString();
        const text = htmlToText(rssText).slice(0, 4000);

        let summary = "";
        try {
          summary = await summarizeWithOpenAI(title, text || title);
        } catch {
          const words = (text || title).split(/\s+/).slice(0, 120);
          summary = words.join(" ") + (words.length >= 120 ? "…" : "");
        }

        let debateJson = "{}";
        try {
          const debate = await personaDebate(title, (text || title).slice(0, 600));
          debateJson = JSON.stringify(debate);
        } catch {}

        const row = {
          id: nanoid(),
          url, title, source, image,
          category: cat,
          publishedAt,
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

  if (results.length) saveArticles(articles);
  else {
    try {
      const seed = JSON.parse(fs.readFileSync(SEED, "utf-8"));
      const seeded = loadArticles();
      for (const s of seed) {
        if (!seeded.find(x => x.url === s.url)) {
          seeded.push({ id: nanoid(), ...s, createdAt: new Date().toISOString() });
        }
      }
      saveArticles(seeded);
      console.warn("No new items saved — seeded sample articles.");
    } catch (e) {
      console.error("Seed load failed:", e.message || e);
    }
  }

  console.log("ingestOnce complete");
  return { added: results.length, detail };
}

// ===== API =====
app.get("/api/articles", (req, res) => {
  try {
    const articles = loadArticles();
    const out = {};
    for (const { key } of CATEGORIES) {
      out[key] = articles
        .filter(a => a.category === key)
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
        .slice(0, 24);
    }
    res.json({ site: SITE_NAME, categories: out });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
app.get("/api/article/:id", (req, res) => {
  const row = loadArticles().find(a => a.id === req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});
app.get("/api/cron", async (req, res) => {
  try {
    const r = await ingestOnce();
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});
app.get("/api/cron-bg", (req, res) => {
  setTimeout(() => { ingestOnce().catch(e => console.error("bg ingest:", e.message || e)); }, 10);
  res.json({ queued: true });
});
app.get("/api/selftest", (req, res) => {
  res.json({ site: SITE_NAME, hasKey: !!process.env.OPENAI_API_KEY, maxPerCategory: MAX_PER_CATEGORY });
});

setInterval(() => {
  ingestOnce().catch(e => console.error("timer ingest error:", e.message || e));
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`▶ NotifAi (OpenAI) on http://localhost:${PORT}`);
  ingestOnce().catch(e => console.error("startup ingest error:", e.message || e));
});
