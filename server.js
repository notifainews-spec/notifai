import 'dotenv/config';
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import { nanoid } from "nanoid";
import * as cheerio from "cheerio";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* --------------------------------------------------------
   CONFIG
--------------------------------------------------------- */
// How many new items to ingest per category (upper bound)
const INGEST_MAX_PER_CAT = parseInt(process.env.INGEST_MAX_PER_CAT || "12", 10);
// How many items to take from each feed (upper bound)
const INGEST_PER_FEED    = parseInt(process.env.INGEST_PER_FEED    || "5", 10);
// Concurrency limiter for fetching article pages (avoid hammering)
const FETCH_CONCURRENCY  = parseInt(process.env.FETCH_CONCURRENCY  || "3", 10);
// Articles endpoint per-category display cap
const MAX_PER_CATEGORY   = parseInt(process.env.MAX_PER_CATEGORY   || "12", 10);
// Auto-ingest interval (minutes)
const INGEST_MINUTES     = parseInt(process.env.INGEST_MINUTES     || "60", 10);

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, "data");
const STORE    = path.join(DATA_DIR, "articles.json");
const SEED     = path.join(DATA_DIR, "seed.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: "*"}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const parser = new Parser({
  requestOptions: {
    headers: { "User-Agent": "Mozilla/5.0 NotifAi/1.0 (+https://www.notifai.news)" },
    timeout: 15000
  }
});

// Feeds (add more if you like)
const FEEDS = {
  us: [
    "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml",
    "https://rss.cnn.com/rss/edition_us.rss",
    "https://www.npr.org/rss/rss.php?id=1001",
  ],
  world: [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.theguardian.com/world/rss",
    "https://rss.cnn.com/rss/edition_world.rss",
  ],
  entertainment: [
    "https://www.rollingstone.com/music/music-news/feed/",
    "https://www.theverge.com/rss/entertainment/index.xml",
    "https://www.hollywoodreporter.com/tv/tv-news/feed/",
  ],
  finance: [
    "https://www.ft.com/world/us/rss",
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "https://www.investopedia.com/feedbuilder/feed/getfeed?feedName=news",
  ],
};

/* --------------------------------------------------------
   STORAGE
--------------------------------------------------------- */
function loadArticles() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); }
  catch { return []; }
}
function saveArticles(list) {
  fs.writeFileSync(STORE, JSON.stringify(list, null, 2), "utf8");
}

/* --------------------------------------------------------
   HELPERS
--------------------------------------------------------- */
function looksLikeUrl(u = "") { return typeof u === "string" && /^https?:\/\//i.test(u); }
function upgradeHttps(u) { try { return new URL(u).toString().replace(/^http:\/\//i, "https://"); } catch { return ""; } }
function absoluteUrlMaybe(src, pageUrl) { try { return new URL(src, pageUrl).toString(); } catch { return src; } }

function getImageReferer(u) {
  try {
    const host = new URL(u).hostname;
    if (host.endsWith("theguardian.com") || host.endsWith("guim.co.uk")) return "https://www.theguardian.com/";
    if (host.endsWith("rollingstone.com")) return "https://www.rollingstone.com/";
    if (host.endsWith("techcrunch.com") || host.endsWith("tctechcrunch2011.files.wordpress.com")) return "https://techcrunch.com/";
    return "https://google.com/";
  } catch { return "https://google.com/"; }
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

/* --------------------------------------------------------
   OpenAI
--------------------------------------------------------- */
async function summarizeWithOpenAI(title, text) {
  const messages = [
    { role: "system", content: "You are a sharp news summarizer. Be neutral, clear, and concise (~120 words)." },
    { role: "user", content: `Title: ${title}\nArticle text (may be partial): ${text.slice(0, 4000)}\nWrite a concise paragraph for general readers.` }
  ];
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.4,
    max_tokens: 220,
  });
  return r.choices?.[0]?.message?.content?.trim() || "";
}

const SOCIALIST_SYS = `You are Jessica Rebella. Left-wing, pro-labor, anti-corporate. No slurs. Keep to the article’s topic.`;
const RIGHTWING_SYS = `You are John Davis. Hardline conservative: pro-GOP, hawkish, pro-market. No slurs. Keep to the article’s topic.`;
const CONSP_SYS     = `You are Joe Musk. Conspiracy-minded. Pick ONE angle (CIA/MI5/Mossad/elites/aliens) relevant to the article. No slurs. 1–3 sentences.`;

async function personaDebate(title, text) {
  const prompt = `Article Title: ${title}\nContext: ${text.slice(0,1200)}\nRespond in 1–3 sentences.`;
  const run = async (sys) => {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 180
    });
    return r.choices?.[0]?.message?.content?.trim() || "";
  };
  const [s, r, c] = await Promise.all([run(SOCIALIST_SYS), run(RIGHTWING_SYS), run(CONSP_SYS)]);
  return {
    socialist:   { name: "Jessica Rebella", open: s },
    rightwing:   { name: "John Davis",      open: r },
    conspiracy:  { name: "Joe Musk",        open: c }
  };
}

/* --------------------------------------------------------
   HTML extraction
--------------------------------------------------------- */
function extractText(html) {
  const $ = cheerio.load(html || "");
  $("script, style, noscript").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

function pickOgImage(html, pageUrl) {
  const $ = cheerio.load(html || "");
  const candidates = [
    $('meta[property="og:image:secure_url"]').attr("content"),
    $('meta[property="og:image"]').attr("content"),
    $('meta[name="og:image"]').attr("content"),
    $('meta[property="twitter:image"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content"),
    $('link[rel="image_src"]').attr("href"),
    $('meta[name="thumbnail"]').attr("content"),
  ].filter(Boolean);

  let found = candidates.find(Boolean);
  if (!found) {
    const first = $("img[src]").first();
    found = first.attr("src") || first.attr("data-src") || "";
    if (!found && first.attr("srcset")) {
      const set = first.attr("srcset").split(",").map(s => s.trim().split(" ")[0]);
      found = set[set.length - 1] || "";
    }
  }
  if (!found) return "";

  if (found.startsWith("//")) found = "https:" + found;
  found = absoluteUrlMaybe(found, pageUrl);
  found = upgradeHttps(found);
  return looksLikeUrl(found) ? found : "";
}

/* --------------------------------------------------------
   INGEST (MULTI-ITEM)
--------------------------------------------------------- */
async function fetchArticlePage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 NotifAi/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { html: "", text: "", image: "" };
    const html = await res.text();
    const text = extractText(html).slice(0, 7000);
    const image = pickOgImage(html, url);
    return { html, text, image };
  } catch {
    return { html: "", text: "", image: "" };
  }
}

async function fetchItemsFromFeed(feedUrl, takeN) {
  try {
    const feed = await parser.parseURL(feedUrl);
    const items = (feed.items || [])
      .filter(i => i.link && i.title)
      .slice(0, takeN);

    // Concurrency limiter
    const out = [];
    for (let i = 0; i < items.length; i += FETCH_CONCURRENCY) {
      const batch = items.slice(i, i + FETCH_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async it => {
          const url = new URL(it.link).toString();
          const page = await fetchArticlePage(url);
          return {
            url,
            title: String(it.title || "").trim(),
            source: new URL(feedUrl).hostname,
            publishedAt: it.isoDate ? new Date(it.isoDate).toISOString() : new Date().toISOString(),
            ...page
          };
        })
      );
      settled.forEach(s => { if (s.status === "fulfilled" && s.value) out.push(s.value); });
    }
    return out;
  } catch (e) {
    console.error("Feed error", feedUrl, e.message || e);
    return [];
  }
}

async function ingestCategory(cat) {
  const feeds = FEEDS[cat] || [];
  let collected = [];
  for (const f of feeds) {
    const list = await fetchItemsFromFeed(f, INGEST_PER_FEED);
    collected = collected.concat(list);
    if (collected.length >= INGEST_MAX_PER_CAT) break;
  }
  // uniq by URL & trim
  collected = uniqBy(collected, x => x.url).slice(0, INGEST_MAX_PER_CAT);
  return collected;
}

async function ingestOnce() {
  const cats = Object.keys(FEEDS);
  const created = [];
  const all = loadArticles();

  for (const c of cats) {
    const many = await ingestCategory(c);
    for (const art of many) {
      if (all.find(x => x.url === art.url)) continue;

      const summary = await summarizeWithOpenAI(art.title, art.text);
      const debate  = await personaDebate(art.title, art.text);

      const row = {
        id: nanoid(),
        url: art.url,
        title: art.title,
        source: art.source,
        image: art.image,
        category: c,
        publishedAt: art.publishedAt,
        summary,
        debateJson: JSON.stringify(debate),
        createdAt: new Date().toISOString()
      };
      all.push(row);
      created.push(row);
    }
  }

  if (created.length > 0) saveArticles(all);

  if (created.length === 0) {
    // seed fallback
    try {
      const seed = JSON.parse(fs.readFileSync(SEED, "utf-8"));
      let added = 0;
      for (const s of seed) {
        if (!all.find(x => x.url === s.url)) {
          all.push({ id: nanoid(), ...s, createdAt: new Date().toISOString() });
          added++;
        }
      }
      if (added>0) saveArticles(all);
    } catch {}
  }

  return created;
}

/* --------------------------------------------------------
   API
--------------------------------------------------------- */
app.get("/api/selftest", (req, res) => {
  res.json({
    ok: true,
    site: process.env.SITE_NAME || "NotifAi News",
    node: process.version,
    env: {
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      MAX_PER_CATEGORY,
      INGEST_MAX_PER_CAT,
      INGEST_PER_FEED,
      FETCH_CONCURRENCY,
      INGEST_MINUTES
    }
  });
});

app.get("/api/articles", (req, res) => {
  const limit = parseInt(req.query.limit || String(MAX_PER_CATEGORY), 10);
  const all = loadArticles().sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
  const group = { us:[], world:[], entertainment:[], finance:[] };
  for (const a of all) {
    if (group[a.category] && group[a.category].length < limit) {
      group[a.category].push(a);
    }
  }
  res.json({ site: process.env.SITE_NAME || "NotifAi News", categories: group });
});

app.get("/api/article/:id", (req, res) => {
  const id = req.params.id;
  const all = loadArticles();
  const found = all.find(x => x.id === id);
  if (!found) return res.status(404).json({ error: "not found" });
  res.json(found);
});

app.get("/api/cron", async (req, res) => {
  const r = await ingestOnce();
  res.json({ ingested: r.length });
});

app.get("/api/cron-bg", (req, res) => {
  setTimeout(()=>{ ingestOnce().catch(()=>{}); }, 10);
  res.json({ queued:true });
});

app.get("/api/diagnose", async (req, res) => {
  const report = {};
  for (const [cat, feeds] of Object.entries(FEEDS)) {
    report[cat] = [];
    for (const f of feeds) {
      try {
        const r = await parser.parseURL(f);
        report[cat].push({ feed: f, ok: !!(r.items && r.items.length), items: (r.items||[]).length });
      } catch (e) {
        report[cat].push({ feed: f, ok: false, error: e.message||String(e) });
      }
    }
  }
  res.json(report);
});

/* --------------------------------------------------------
   IMAGE PROXY
--------------------------------------------------------- */
app.get("/img", async (req, res) => {
  try {
    const u = req.query.u;
    if (!u || typeof u !== "string") return res.status(400).send("missing u");
    if (!looksLikeUrl(u)) return res.status(400).send("bad url");
    const referer = getImageReferer(u);

    const upstream = await fetch(u, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": referer,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!upstream.ok) {
      res.setHeader("Cache-Control","no-cache");
      return res.status(502).send("bad upstream");
    }
    const ct = upstream.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch {
    res.status(500).send("proxy error");
  }
});

/* --------------------------------------------------------
   START + AUTO-INGEST
--------------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`▶ NotifAi News on http://localhost:${PORT}`);
});

(async () => {
  try {
    console.time("first-ingest");
    console.log("Kicking off first ingest…");
    await ingestOnce();
    console.timeEnd("first-ingest");
  } catch (e) {
    console.error("First ingest failed:", e?.message || e);
  }
  console.log(`Auto-ingest interval set to ${INGEST_MINUTES} minute(s).`);
  setInterval(() => {
    console.time("auto-ingest");
    console.log("Auto-ingest tick…");
    ingestOnce()
      .then(() => console.timeEnd("auto-ingest"))
      .catch(err => console.error("Auto-ingest failed:", err?.message || err));
  }, INGEST_MINUTES * 60 * 1000);
})();
