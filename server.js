import 'dotenv/config';
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import { nanoid } from "nanoid";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: "*"}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, "data");
const STORE = path.join(DATA_DIR, "articles.json");
const SEED  = path.join(DATA_DIR, "seed.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadArticles() {
  try {
    const t = fs.readFileSync(STORE, "utf8");
    return JSON.parse(t);
  } catch {
    return [];
  }
}
function saveArticles(list) {
  fs.writeFileSync(STORE, JSON.stringify(list, null, 2), "utf8");
}
function looksLikeImageUrl(u = "") {
  const s = u.toLowerCase();
  return s.startsWith("http://") || s.startsWith("https://");
}

const parser = new Parser({
  requestOptions: {
    headers: { "User-Agent": "Mozilla/5.0 NotifAi/1.0 (+https://notifainews1.onrender.com)" },
    timeout: 15000
  }
});

// ---- FEEDS (keep yours here or import from feeds.js) ----
const FEEDS = {
  us: [
    "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml",
    "https://rss.cnn.com/rss/edition_us.rss"
  ],
  world: [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.theguardian.com/world/rss"
  ],
  entertainment: [
    "https://www.rollingstone.com/music/music-news/feed/",
    "https://www.theverge.com/rss/entertainment/index.xml"
  ],
  finance: [
    "https://www.ft.com/world/us/rss",
    "https://www.cnbc.com/id/100003114/device/rss/rss.html"
  ],
};

// ---------- OpenAI helpers ----------
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function summarizeWithOpenAI(title, text) {
  const body = [
    { role: "system", content: "You are a sharp news summarizer. Be neutral, clear, and concise (~120 words)." },
    { role: "user", content: `Title: ${title}\nArticle text (may be partial): ${text.slice(0, 4000)}\nWrite a concise paragraph for general readers.` }
  ];
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: body,
    temperature: 0.4,
    max_tokens: 220,
  });
  return r.choices?.[0]?.message?.content?.trim() || "";
}

const SOCIALIST_SYS = `You are Jessica Rebella. Left-wing, pro-labor, anti-corporate. No slurs. Keep to the article’s topic.`;
const RIGHTWING_SYS = `You are John Davis. Hardline conservative: pro-GOP, hawkish, pro-market. No slurs. Keep to the article’s topic.`;
const CONSP_SYS     = `You are Joe Musk. Conspiracy-minded. You may reference CIA/MI5/Mossad, elites, aliens—but pick ONE angle related to the article. No slurs. 1–3 sentences.`;

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

// ---------- HTML extraction helpers ----------
function extractText(html) {
  const $ = cheerio.load(html || "");
  $("script, style, noscript").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  return bodyText;
}
function pickOgImage(html, pageUrl) {
  const $ = cheerio.load(html || "");
  const og = $('meta[property="og:image"]').attr("content")
        || $('meta[name="og:image"]').attr("content")
        || $('meta[property="twitter:image"]').attr("content");
  if (og && looksLikeImageUrl(og)) return og;
  // Try first <img>
  const first = $("img[src]").first().attr("src");
  if (first && looksLikeImageUrl(first)) return first;
  // Resolve protocol-relative
  if (first && first.startsWith("//")) return "https:" + first;
  return "";
}

// ---------- INGEST ----------
async function fetchTopItem(feedUrl) {
  try {
    const feed = await parser.parseURL(feedUrl);
    const item = feed.items.find(i => i.link && i.title);
    if (!item) return null;

    const url = new URL(item.link).toString();
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 NotifAi/1.0" }, redirect: "follow" });
    if (!res.ok) return { url, title: item.title, html: "", text: "", image: "", source: new URL(feedUrl).hostname };
    const html = await res.text();
    const text = extractText(html).slice(0, 6000);
    const img  = pickOgImage(html, url);
    return {
      url,
      title: item.title.trim(),
      html,
      text,
      image: img || "",
      source: new URL(feedUrl).hostname,
      publishedAt: item.isoDate ? new Date(item.isoDate).toISOString() : new Date().toISOString()
    };
  } catch (e) {
    console.error("Feed item error", feedUrl, e.message || e);
    return null;
  }
}

async function ingestCategory(cat) {
  for (const f of FEEDS[cat]) {
    const one = await fetchTopItem(f);
    if (one) return one;
  }
  return null;
}

async function ingestOnce() {
  const cats = Object.keys(FEEDS);
  const out  = [];
  for (const c of cats) {
    const top = await ingestCategory(c);
    if (!top) continue;

    // Skip if already stored
    const existing = loadArticles();
    if (existing.find(x => x.url === top.url)) continue;

    const summary = await summarizeWithOpenAI(top.title, top.text);
    const debate  = await personaDebate(top.title, top.text);

    const row = {
      id: nanoid(),
      url: top.url,
      title: top.title,
      source: top.source,
      image: top.image,
      category: c,
      publishedAt: top.publishedAt,
      summary,
      debateJson: JSON.stringify(debate),
      createdAt: new Date().toISOString()
    };
    existing.push(row);
    saveArticles(existing);
    out.push(row);
  }

  // If nothing ingested, ensure seed fills UI
  if (out.length === 0) {
    try {
      const seed = JSON.parse(fs.readFileSync(SEED, "utf-8"));
      const cur  = loadArticles();
      let added = 0;
      for (const s of seed) {
        if (!cur.find(x => x.url === s.url)) {
          cur.push({ id: nanoid(), ...s, createdAt: new Date().toISOString() });
          added++;
        }
      }
      if (added>0) saveArticles(cur);
    } catch (e) {
      console.warn("Seed load skipped:", e.message || e);
    }
  }

  return out;
}

// ---------- API ----------
app.get("/api/selftest", (req, res) => {
  res.json({
    ok: true,
    site: process.env.SITE_NAME || "NotifAi News",
    node: process.version,
    env: {
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      MAX_PER_CATEGORY: process.env.MAX_PER_CATEGORY || "6"
    }
  });
});

app.get("/api/articles", (req, res) => {
  const all = loadArticles().sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
  const group = { us:[], world:[], entertainment:[], finance:[] };
  for (const a of all) {
    if (group[a.category] && group[a.category].length < (parseInt(process.env.MAX_PER_CATEGORY||"6",10))) {
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

// ---------- NEW: Image proxy to defeat hotlink protection ----------
app.get("/img", async (req, res) => {
  try {
    const u = req.query.u;
    if (!u || typeof u !== "string") return res.status(400).send("missing u");
    if (!/^https?:\/\//i.test(u)) return res.status(400).send("bad url");

    const upstream = await fetch(u, {
      redirect: "follow",
      headers: {
        // pretend to be a normal browser
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://google.com/"
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
  } catch (e) {
    res.status(500).send("proxy error");
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`▶ NotifAi News on http://localhost:${PORT}`);
});
