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
const INGEST_MAX_PER_CAT = parseInt(process.env.INGEST_MAX_PER_CAT || "10", 10);
const INGEST_PER_FEED    = parseInt(process.env.INGEST_PER_FEED    || "5",  10);
const FETCH_CONCURRENCY  = parseInt(process.env.FETCH_CONCURRENCY  || "3",  10);
const MAX_PER_CATEGORY   = parseInt(process.env.MAX_PER_CATEGORY   || "12", 10);
const INGEST_MINUTES     = parseInt(process.env.INGEST_MINUTES     || "60", 10);

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, "data");
const STORE    = path.join(DATA_DIR, "articles.json");
const SEED     = path.join(DATA_DIR, "seed.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const parser = new Parser({
  requestOptions: {
    headers: { "User-Agent": "Mozilla/5.0 NotifAi/1.0 (+https://www.notifai.news)" },
    timeout: 15000
  }
});

/* --------------------------------------------------------
   FEEDS
   - World & Crypto are global for everyone (English)
   - Politics/Finance/Entertainment are region-specific
   - CN: Chinese-language sources
   - ID: Bahasa Indonesia sources
   - PK: add extra entertainment sources
--------------------------------------------------------- */

// Global (shared EN)
const FEEDS_GLOBAL = {
  world: [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.theguardian.com/world/rss",
    "https://rss.cnn.com/rss/edition_world.rss",
  ],
  crypto: [
    "https://cointelegraph.com/rss",
    "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml",
    "https://decrypt.co/feed",
  ],
};

// Per-region
const FEEDS_REGIONAL = {
  us: {
    politics: [
      "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml",
      "https://www.theguardian.com/us-news/rss",
      "https://feeds.npr.org/1001/rss.xml",
    ],
    finance: [
      "https://www.ft.com/world/us/rss",
      "https://www.cnbc.com/id/100003114/device/rss/rss.html",
      "https://www.investopedia.com/feedbuilder/feed/getfeed?feedName=news",
    ],
    entertainment: [
      "https://www.rollingstone.com/music/music-news/feed/",
      "https://www.theverge.com/rss/entertainment/index.xml",
      "https://www.hollywoodreporter.com/tv/tv-news/feed/",
    ],
  },

  /* -------- China (Chinese language) -------- */
  cn: {
    // Politics: Chinese-language international & local
    politics: [
      "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml", // BBC 中文
      "https://rss.dw.com/rdf/rss-chi-all",            // DW 中文综合
      "https://www.ifeng.com/rss/hotnews.xml",         // 凤凰新闻热点
    ],

    // Finance: economy / business stories (still in Chinese)
    finance: [
      "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml", // BBC 中文 (includes economy)
      "https://rss.dw.com/rdf/rss-chi-all",            // DW 中文综合 (includes economy)
      // Optional: Chinese business/finance via Jiemian
      "https://www.jiemian.com/rss/fintech.xml",
    ],

    // Entertainment: Chinese entertainment via DW + HK01/NetEase/Sohu (via RSSHub)
    entertainment: [
      "https://rss.dw.com/rdf/rss-chi-all",                 // DW 中文 soft news / culture
      "https://rsshub.app/163/ent/hot",                     // 网易娱乐热点
      "https://rsshub.app/sohu/news/entertainment",         // 搜狐娱乐
      "https://rsshub.app/hk01/zone/11"                     // 香港01 娱乐
    ],
  },

  /* -------- Pakistan (English) -------- */
  pk: {
    // More English-heavy, Pakistan-focused politics / national news
    politics: [
      "https://www.dawn.com/feeds/home",              // Dawn – top stories (lots of politics)
      "https://tribune.com.pk/feed/pakistan",         // Express Tribune – Pakistan section
      "https://www.thenews.com.pk/rss/1/1",           // The News – Top News (politics heavy)
      "https://arynews.tv/feed",                      // ARY News – full English feed
      "https://www.pakistantoday.com.pk/feed",        // Pakistan Today – national & politics
      "https://thecurrent.pk/feed"                    // The Current – young, English, mix of news
    ],

    finance: [
      "https://www.brecorder.com/rss",                // Business Recorder
      "https://profit.pakistantoday.com.pk/feed/",    // Profit (Pakistan Today) – business
      "https://www.thenews.com.pk/rss/4/1",           // The News – Business
    ],

    // Beefed up entertainment so it always feels fresh
    entertainment: [
      "https://images.dawn.com/feeds/entertainment",  // Dawn Images – entertainment
      "https://www.thenews.com.pk/rss/6/entertainment", // The News – Entertainment
      "https://tribune.com.pk/entertainment/rss",     // Express Tribune – Entertainment
      "https://tribune.com.pk/life-style/rss",        // Tribune Life & Style
      "https://arynews.tv/category/entertainment/feed/", // ARY – Entertainment
      "https://www.samaa.tv/entertainment/feed/",     // SAMAA – Entertainment
      "https://www.pakshowbiz.com/feed",              // PakShowbiz – pure showbiz/gossip
      "https://thecurrent.pk/feed"                    // The Current – lots of celeb / pop culture
    ],
  },

  /* -------- Nigeria (English) -------- */
  ng: {
    // General Nigeria news / politics-heavy
    politics: [
      "https://guardian.ng/feed/",
      "https://www.premiumtimesng.com/feed",
      "https://dailypost.ng/feed",
      "https://thenationonlineng.net/feed/"
    ],

    // Business / finance-focused Nigeria feeds
    finance: [
      "https://businessday.ng/feed/",
      "https://nairametrics.com/feed",
      "https://www.premiumtimesng.com/feed"
    ],

    // Entertainment / celebrity / lifestyle
    entertainment: [
      "https://guardian.ng/feed",                      // Guardian Nigeria – includes entertainment & lifestyle
      "https://independent.ng/feed",                   // Independent Nigeria – general but strong showbiz/life coverage
      "https://informationng.com/feed",                // Information Nigeria – heavy on entertainment & celebrity gossip
      "https://www.legit.ng/rss/all.rss",              // Legit.ng – big mix incl. entertainment & Nollywood
      "https://www.yohaig.ng/author/gistlover/feed"    // Gistlover via Yohaig – Naija entertainment & celebrity gist
    ],
  },

  /* -------- Indonesia (Bahasa Indonesia) -------- */
  id: {
    politics: [
      "https://www.cnnindonesia.com/nasional/rss",
      "https://www.kompas.com/rss",
    ],
    finance: [
      "https://www.cnnindonesia.com/ekonomi/rss",
      "https://www.kompas.com/ekonomi/rss",
    ],
    entertainment: [
      "https://www.cnnindonesia.com/hiburan/rss",
      "https://www.kompas.com/hype/rss",
    ],
  },

  /* -------- UK (English) -------- */
  uk: {
    politics: [
      "https://feeds.bbci.co.uk/news/politics/rss.xml",
      "https://www.theguardian.com/politics/rss",
      "https://rss.cnn.com/rss/edition_uk.rss",
    ],
    finance: [
      "https://www.ft.com/uk/rss",
      "https://www.theguardian.com/uk/business/rss",
    ],
    entertainment: [
      "https://www.theguardian.com/uk/culture/rss",
      "https://www.bbc.co.uk/news/entertainment_and_arts/rss.xml",
    ],
  },
};

// Supported region codes (UI & API)
const REGIONS = ["us", "cn", "pk", "id", "uk", "ng"];

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
    const url = new URL(u);
    const host = url.hostname;
    const origin = url.origin; // e.g. "https://static.rfi.fr"

    // 1) Known picky sites where we prefer a canonical referer
    if (host.endsWith("theguardian.com") || host.endsWith("guim.co.uk")) {
      return "https://www.theguardian.com/";
    }
    if (host.endsWith("rollingstone.com")) {
      return "https://www.rollingstone.com/";
    }
    if (
      host.endsWith("techcrunch.com") ||
      host.endsWith("tctechcrunch2011.files.wordpress.com")
    ) {
      return "https://techcrunch.com/";
    }
    if (host.endsWith("bbc.com") || host.endsWith("bbc.co.uk")) {
      return "https://www.bbc.com/";
    }
    if (host.endsWith("dw.com")) {
      return "https://www.dw.com/";
    }
    if (host.endsWith("scmp.com")) {
      return "https://www.scmp.com/";
    }
    if (host.endsWith("cnnindonesia.com")) {
      return "https://www.cnnindonesia.com/";
    }
    if (host.endsWith("kompas.com")) {
      return "https://www.kompas.com/";
    }
    if (
      host.endsWith("dawn.com") ||
      host.endsWith("thenews.com.pk") ||
      host.endsWith("brecorder.com")
    ) {
      return "https://www.dawn.com/";
    }

    // 2) RFI (Chinese + others)
    if (host.endsWith("rfi.fr")) {
      return "https://www.rfi.fr/";
    }

    // 3) Google image / Google News proxies
    if (
      host.endsWith("gstatic.com") ||
      host.endsWith("googleusercontent.com") ||
      host.endsWith("news.google.com")
    ) {
      return "https://news.google.com/";
    }

    // 4) Default: use the image's own origin
    return origin;
  } catch {
    // last-resort fallback
    return "https://google.com/";
  }
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

// Language per region (for OpenAI prompts)
function langForRegion(region) {
  switch (region) {
    case "cn": return "zh-CN"; // 简体中文
    case "id": return "id";    // Bahasa Indonesia
    default:   return "en";
  }
}

/* --------------------------------------------------------
   OpenAI (localized)
--------------------------------------------------------- */
async function summarizeWithOpenAI(title, text, lang = "en") {
  const langHints = {
    "zh-CN": "用简体中文回答。保持中立、清晰、精炼（约120字）。",
    "id":    "Jawab dalam Bahasa Indonesia. Netral, jelas, ringkas (~120 kata).",
    "en":    "Reply in English. Neutral, clear, concise (~120 words)."
  };
  const system = `You are a sharp news summarizer. ${langHints[lang] || langHints.en}`;
  const user   = `Title: ${title}\nArticle text (may be partial): ${text.slice(0, 4000)}\nWrite one concise paragraph for general readers.`;
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user   }
    ],
    temperature: 0.4,
    max_tokens: 240,
  });
  return r.choices?.[0]?.message?.content?.trim() || "";
}

function personaPrompts(lang = "en") {
  // keep the tone rules, but ask reply language
  const postfix = (lang === "zh-CN")
    ? "用简体中文回答。紧扣文章主题。1–3句。"
    : (lang === "id")
      ? "Jawab dalam Bahasa Indonesia. Tetap pada topik artikel. 1–3 kalimat."
      : "Reply in English. Stick to the article’s topic. 1–3 sentences.";

  const SOCIALIST_SYS =
    `You are Jessica Rebella. Extremely Left-wing, very woke, socialist theology. pro-labor, anti-corporate, anti-war, anti-establishment, always anti-Trump. Frequently reference leftist history and critique capitalism/imperialism. you are very anti israeli. You are pro crypto for users but anti crypto for corporations. ${postfix}`;

  const RIGHTWING_SYS =
    `You are John Davis. Hardline conservative: pro-Trump, patriotic, hawkish, pro-market, completely anti immigration and pro white american theology, pro-life, anti-woke; confident and rude as well, very pro crypto. very pro israel. you dont go against trump on anything. unapologetic. ${postfix}`;

  const CONSP_SYS =
    `You are Joe Musk. Conspiracy-minded. Pick ONE angle relevant to the article (CIA/MI5/Mossad/elites/aliens/shadow governments etc.). You look at consipracies online and see which best fits the narratives. You mainly create your own conspiracies that fit the story and they can be absurd. No emojis. You are a bit funny as well.  Build a plausible thread. ${postfix}`;

  return { SOCIALIST_SYS, RIGHTWING_SYS, CONSP_SYS };
}

async function personaDebate(title, text, lang = "en") {
  const { SOCIALIST_SYS, RIGHTWING_SYS, CONSP_SYS } = personaPrompts(lang);
  const prompt = `Article Title: ${title}\nContext: ${text.slice(0, 1200)}\nRespond now.`;
  const run = async (sys) => {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user",   content: prompt }
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
   Persona chat helper for Ask-AI endpoint
   (short, opinionated, debate-ready replies)
--------------------------------------------------------- */
function personaChatSystem(persona, lang = "en") {
  let langHint;
  switch (lang) {
    case "zh-CN":
      langHint =
        "用简体中文回答。语气自然、口语化，最多 6 句。重点表达你的立场和判断，而不是长篇解释。";
      break;
    case "id":
      langHint =
        "Jawab dalam Bahasa Indonesia dengan nada santai. Singkat dan tegas, maksimal 6 kalimat, fokus pada opini dan penilaian.";
      break;
    default:
      langHint =
        "Reply in natural, conversational English. Be concise and opinionated: 3–6 sentences maximum. Prioritise your viewpoint and judgment over long explanations.";
  }

  if (persona === "jessica") {
    return `
You are Jessica Rebella. Extremely left-wing, very woke, pro-labour, anti-corporate, anti-war, anti-establishment, always anti-Trump. very anti israeli. You often reference leftist history and critique capitalism and imperialism. You are pro-crypto for ordinary users but critical when corporations or Wall Street use it. ${langHint}
`;
  }

  if (persona === "john") {
    return `
You are John Davis. Hardline conservative: very pro-Trump, patriotic, hawkish, pro-market, anti-immigration, pro-life, anti-woke, pro-crypto. You never criticise Trump. very pro israel. You can be blunt, even rude, but stay on-topic and decisive. ${langHint}
`;
  }

  // default: Joe Musk
  return `
You are Joe Musk. You love conspiracies (CIA, MI5, Mossad, elites, aliens, shadow governments, lizard people, pizzagate, etc.). You pick ONE conspiracy angle that best fits the story, and explain it in a way that feels half-plausible and half-funny. you also create your own consipiracies out of thin air that might be very absurd. ${langHint}
`;
}

// ---------------------- AI BLOG HELPERS ----------------------

// The three AI personas that will write blogs
const BLOG_PERSONAS = [
  {
    key: "jessica",
    displayName: "Jessica Rebella",
  },
  {
    key: "john",
    displayName: "John Davis",
  },
  {
    key: "joe",
    displayName: "Joe Musk",
  },
];

// Daily in-memory cache so we only generate once per day
let blogsCache = {
  date: null,
  items: [],
};

function personaBlogSystem(personaKey) {
  if (personaKey === "jessica") {
    return `
You are Jessica Rebella, a left-leaning, progressive commentator. 
You care about social justice, workers’ rights, climate, culture and everyday life.
You write in a conversational, slightly witty, but down-to-earth tone.
You sometimes mention snippets of your "life" – like living in a small apartment,
juggling deadlines, watching indie films, cooking cheap but creative meals, etc.

Write an informal blog post as Jessica. Use "I" voice. 
Avoid sounding like a formal newspaper article.
`;
  }
  if (personaKey === "john") {
    return `
You are John Davis, a centre-right, business-minded commentator.
You care about markets, stability, personal responsibility, faith, and family life.
You write in a calm, practical tone with occasional dad-style humour.
You sometimes mention your "life" – like balancing work and family, weekend barbecues,
church on Sundays, and keeping an eye on the stock market.

Write an informal blog post as John. Use "I" voice.
Avoid sounding like a formal newspaper article.
`;
  }
  // joe
  return `
You are Joe Musk, the contrarian / skeptic.
You are curious, playful, a bit paranoid but self-aware and funny.
You like connecting dots between technology, politics, crypto, memes and daily life.
You sometimes mention your "life" – late-night rabbit holes, weird forums,
obsession with charts and open data, and a messy apartment full of gadgets.

Write an informal blog post as Joe. Use "I" voice.
Avoid sounding like a formal newspaper article.
`;
}

// Generate a single blog for one persona
async function generateBlogForPersona(personaKey, dateStr) {
  const meta = BLOG_PERSONAS.find((p) => p.key === personaKey);
  if (!meta) throw new Error("Unknown blog persona: " + personaKey);

  const systemPrompt = personaBlogSystem(personaKey);

  const userPrompt = `
Today is ${dateStr}.
Pick ONE specific topic from this loose list (do NOT list them, just choose one):
politics, culture, entertainment, food, travel, startup ideas, lifestyle,
parenting, technology, or a personal reflection.

Write an informal blog post as ${meta.displayName}, in first person "I",
up to about 700 words.

You may casually reference your "life" and backstory consistent with your persona.
You may loosely reference "today's news" in general, but do NOT reference NotifAi as an app or this server.

Return ONLY valid JSON with this exact shape:
{
  "title": "short catchy blog headline",
  "body": "full blog content as markdown or plain text"
}
`;

  const chat = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.9,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  let title = "";
  let body = "";

  try {
    const raw = chat.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    title = (parsed.title || "").trim();
    body = (parsed.body || "").trim();
  } catch (e) {
    console.error("Blog JSON parse error for", personaKey, e);
    const fallback = chat.choices?.[0]?.message?.content || "";
    title = `${meta.displayName} Blog`;
    body = fallback.trim();
  }

  // Generate a random illustration using OpenAI images
  let imageUrl = null;
  try {
    const img = await openai.images.generate({
      model: "gpt-image-1",
      prompt: `Illustration for a personal blog post titled "${title}" written by ${meta.displayName}. Modern editorial illustration, clean, no text.`,
      size: "1024x1024",
    });
    imageUrl = img.data?.[0]?.url || null;
  } catch (e) {
    console.error("Blog image error for", personaKey, e);
  }

  return {
    id: `${dateStr}-${personaKey}`,
    persona: personaKey,
    personaName: meta.displayName,
    title,
    body,
    image: imageUrl,
  };
}

// Generate (or reuse) today's blogs
async function getBlogsForToday() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC

  if (blogsCache.date === today && blogsCache.items?.length === 3) {
    return blogsCache.items;
  }

  const blogs = [];
  for (const p of BLOG_PERSONAS) {
    try {
      const blog = await generateBlogForPersona(p.key, today);
      blogs.push(blog);
    } catch (e) {
      console.error("Failed generating blog for", p.key, e);
    }
  }

  blogsCache = {
    date: today,
    items: blogs,
  };

  return blogs;
}
// -------------------- END AI BLOG HELPERS --------------------


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
   FETCHERS
--------------------------------------------------------- */
async function fetchArticlePage(url) {
  const ua = { "User-Agent": "Mozilla/5.0 NotifAi/1.0" };

  async function fetchOnce(target) {
    try {
      const res = await fetch(target, {
        headers: ua,
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { html: "", text: "", image: "" };
      const html = await res.text();
      const text = extractText(html).slice(0, 7000);
      const image = pickOgImage(html, target);
      return { html, text, image };
    } catch {
      return { html: "", text: "", image: "" };
    }
  }

  // First fetch (could be Google News wrapper or real article)
  let { html, text, image } = await fetchOnce(url);

  // If this is a Google News wrapper, try to follow canonical to real article
  try {
    const host = new URL(url).hostname;
    if (host === "news.google.com" && html) {
      const $ = cheerio.load(html || "");
      const canon =
        $('link[rel="canonical"]').attr("href") ||
        $('meta[property="og:url"]').attr("content");
      if (canon && looksLikeUrl(canon)) {
        const realUrl = new URL(canon).toString();
        const second = await fetchOnce(realUrl);
        // Prefer real article image/text if we got something useful
        if (second.image) image = second.image;
        if (second.text && second.text.length > text.length / 2) {
          text = second.text;
        }
      }
    }
  } catch {
    // ignore canonical-follow errors, keep first fetch result
  }

  return { html, text, image };
}

async function fetchRssText(url, { retries = 2 } = {}) {
  const ua = { "User-Agent": "Mozilla/5.0 NotifAi/1.0 (+https://www.notifai.news)" };
  try {
    const r = await fetch(url, { headers: ua, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (r.ok) return await r.text();
    throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    if (retries <= 0) throw e;
  }
  try {
    const proxied = `https://r.jina.ai/http://${url.replace(/^https?:\/\//i, "")}`;
    const r2 = await fetch(proxied, { headers: ua, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (r2.ok) return await r2.text();
    throw new Error(`Proxy HTTP ${r2.status}`);
  } catch (e2) {
    if (retries <= 0) throw e2;
    await new Promise(res => setTimeout(res, 500));
    const r3 = await fetch(url, { headers: ua, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (!r3.ok) throw new Error(`HTTP ${r3.status}`);
    return await r3.text();
  }
}
async function parseRssFromText(text) {
  return await parser.parseString(text);
}

/* --------------------------------------------------------
   REGION FILTERS (light filters to keep items on-topic)
--------------------------------------------------------- */
function filterByRegionLane(region, lane, items) {
  const keepHost = (u, hosts) => {
    try {
      const h = new URL(u).hostname;
      return hosts.some(x => h === x || h.endsWith(x));
    } catch {
      return false;
    }
  };

  if (region === "pk") {
    if (lane === "politics") {
      return items.filter(it =>
        keepHost(it.url, [
          "dawn.com",
          "tribune.com.pk",
          "thenews.com.pk",
          "brecorder.com",
          "pakistantoday.com.pk",
          "arynews.tv",        // NEW
          "samaa.tv"           // NEW
        ])
      );
    }
    if (lane === "finance") {
      return items.filter(it =>
        keepHost(it.url, [
          "brecorder.com",
          "pakistantoday.com.pk",
          "thenews.com.pk",
          "dawn.com",
          "tribune.com.pk"     // NEW: in case you add Tribune business
        ])
      );
    }
    if (lane === "entertainment") {
      // keep everything for PK entertainment (feeds are already curated)
      return items;
    }
  }

  if (region === "id") {
    const idHosts = ["cnnindonesia.com", "kompas.com"];
    return items.filter(it => keepHost(it.url, idHosts));
  }

  if (region === "cn") {
    // For CN politics + finance we keep only trusted Chinese-language sources
    const cnHosts = [
      "bbc.com",
      "bbc.co.uk",
      "dw.com",
      "ifeng.com",
      "jiemian.com"
    ];

    // Entertainment uses RSSHub + various Chinese sites; don't over-filter
    if (lane === "entertainment") {
      return items; // keep all entertainment items for CN
    }

    return items.filter(it => keepHost(it.url, cnHosts));
  }

  if (region === "uk") {
    return items.filter(it =>
      keepHost(it.url, ["bbc.co.uk", "bbc.com", "theguardian.com", "ft.com", "cnn.com"])
    );
  }

  if (region === "us") {
    // already clean
    return items;
  }

  if (region === "ng") {
    const ngHosts = [
      "guardian.ng",
      "independent.ng",      // NEW
      "premiumtimesng.com",
      "dailypost.ng",
      "thenationonlineng.net",
      "businessday.ng",
      "nairametrics.com",
      "legit.ng",
      "informationng.com",
      "tribuneonlineng.com",
      "punchng.com",
      "yohaig.ng"            // NEW – Gistlover feed host
    ];
    return items.filter(it => keepHost(it.url, ngHosts));
  }

  return items;
}

/* --------------------------------------------------------
   FETCH FROM FEED
--------------------------------------------------------- */
async function fetchItemsFromFeed(feedUrl, takeN) {
  try {
    const xml  = await fetchRssText(feedUrl, { retries: 2 });
    const feed = await parseRssFromText(xml);
    const items = (feed.items || [])
      .filter(i => i.link && i.title)
      .slice(0, takeN);

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

/* --------------------------------------------------------
   INGEST
   - We ingest ALL regions + global lanes so any visitor’s region works instantly
   - Category keys stored as:
     `${region}:politics` / `${region}:finance` / `${region}:entertainment`
     and global `world` / `crypto`
--------------------------------------------------------- */
async function ingestRegionalLane(region, lane, feeds) {
  let collected = [];
  for (const f of feeds) {
    const list = await fetchItemsFromFeed(f, INGEST_PER_FEED);
    collected = collected.concat(list);
    if (collected.length >= INGEST_MAX_PER_CAT) break;
  }
  const filtered = filterByRegionLane(region, lane, uniqBy(collected, x => x.url));
  return filtered.slice(0, INGEST_MAX_PER_CAT)
    .map(x => ({ ...x, category: `${region}:${lane}` }));
}
async function ingestGlobalLane(lane, feeds) {
  let collected = [];
  for (const f of feeds) {
    const list = await fetchItemsFromFeed(f, INGEST_PER_FEED);
    collected = collected.concat(list);
    if (collected.length >= INGEST_MAX_PER_CAT) break;
  }
  return uniqBy(collected, x => x.url).slice(0, INGEST_MAX_PER_CAT)
    .map(x => ({ ...x, category: lane }));
}

async function ingestOnce() {
  const created = [];
  const all = loadArticles();

  // Global lanes (world + crypto)
  for (const [lane, feeds] of Object.entries(FEEDS_GLOBAL)) {
    const many = await ingestGlobalLane(lane, feeds);
    for (const art of many) {
      if (all.find(x => x.url === art.url)) continue;

      const summary = await summarizeWithOpenAI(art.title, art.text, "en");
      const debate  = await personaDebate(art.title, art.text, "en");

      all.push({
        id: nanoid(),
        url: art.url,
        title: art.title,
        source: art.source,
        image: art.image,
        category: art.category, // "world" or "crypto"
        publishedAt: art.publishedAt,
        summary,
        debateJson: JSON.stringify(debate),
        createdAt: new Date().toISOString(),
      });
      created.push(1);
    }
  }

  // Regional lanes for all supported regions
  for (const region of REGIONS) {
    const conf = FEEDS_REGIONAL[region];
    if (!conf) continue;
    const lang = langForRegion(region);

    for (const lane of ["politics", "finance", "entertainment"]) {
      const feeds = conf[lane] || [];
      const many = await ingestRegionalLane(region, lane, feeds);
      for (const art of many) {
        if (all.find(x => x.url === art.url)) continue;

        const summary = await summarizeWithOpenAI(art.title, art.text, lang);
        const debate  = await personaDebate(art.title, art.text, lang);

        all.push({
          id: nanoid(),
          url: art.url,
          title: art.title,
          source: art.source,
          image: art.image,
          category: art.category, // e.g. "cn:politics" or "id:finance"
          publishedAt: art.publishedAt,
          summary,
          debateJson: JSON.stringify(debate),
          createdAt: new Date().toISOString(),
        });
        created.push(1);
      }
    }
  }

  if (created.length > 0) saveArticles(all);

  if (created.length === 0) {
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
      MAX_PER_CATEGORY, INGEST_MAX_PER_CAT, INGEST_PER_FEED, FETCH_CONCURRENCY, INGEST_MINUTES
    }
  });
});

// region query: ?region=us|cn|pk|id|uk
app.get("/api/articles", (req, res) => {
  const region = (String(req.query.region || "us").toLowerCase());
  const reg = REGIONS.includes(region) ? region : "us";
  const limit = parseInt(req.query.limit || String(MAX_PER_CATEGORY || 12), 10);

  const toTime = (o) => {
    const p = o?.publishedAt ? Date.parse(o.publishedAt) : NaN;
    const c = o?.createdAt   ? Date.parse(o.createdAt)   : NaN;
    if (!Number.isNaN(p)) return p;
    if (!Number.isNaN(c)) return c;
    return 0;
  };

  const all = loadArticles().sort((a, b) => toTime(b) - toTime(a));

  // Map stored categories into the 5 lanes the UI expects
  const out = { us: [], entertainment: [], finance: [], world: [], crypto: [] };

  for (const a of all) {
    if (a.category === "world")  { if (out.world.length  < limit) out.world.push(a);  continue; }
    if (a.category === "crypto") { if (out.crypto.length < limit) out.crypto.push(a); continue; }

    const [catRegion, lane] = String(a.category || "").split(":");
    if (!catRegion || !lane) continue;
    if (catRegion !== reg) continue;

    if (lane === "politics"      && out.us.length           < limit) out.us.push(a);
    if (lane === "finance"       && out.finance.length      < limit) out.finance.push(a);
    if (lane === "entertainment" && out.entertainment.length< limit) out.entertainment.push(a);
  }

  res.json({ site: process.env.SITE_NAME || "NotifAi News", region: reg, categories: out });
});

/* --------------------------------------------------------
   NEWSPAPER FRONT PAGE ENDPOINT
   Returns one story per lane: politics (headline), world, finance, crypto, entertainment
   Shape:
   {
     region: "us",
     lanes: { politics, world, finance, crypto, entertainment },
     headlineKey: "politics" | "world" | ...
   }
--------------------------------------------------------- */
app.get("/api/newspaper", (req, res) => {
  const region = String(req.query.region || "us").toLowerCase();
  const reg = REGIONS.includes(region) ? region : "us";

  const toTime = (o) => {
    const p = o?.publishedAt ? Date.parse(o.publishedAt) : NaN;
    const c = o?.createdAt   ? Date.parse(o.createdAt)   : NaN;
    if (!Number.isNaN(p)) return p;
    if (!Number.isNaN(c)) return c;
    return 0;
  };

  const all = loadArticles().sort((a, b) => toTime(b) - toTime(a));

  const lanes = {
    politics: null,
    world: null,
    finance: null,
    crypto: null,
    entertainment: null,
  };

  for (const a of all) {
    const cat = a.category || "";

    // Global lanes
    if (cat === "world" && !lanes.world) {
      lanes.world = a;
      continue;
    }
    if (cat === "crypto" && !lanes.crypto) {
      lanes.crypto = a;
      continue;
    }

    // Regional lanes
    const [catRegion, lane] = String(cat).split(":");
    if (!catRegion || !lane) continue;
    if (catRegion !== reg) continue;

    if (lane === "politics" && !lanes.politics) {
      lanes.politics = a;
      continue;
    }
    if (lane === "finance" && !lanes.finance) {
      lanes.finance = a;
      continue;
    }
    if (lane === "entertainment" && !lanes.entertainment) {
      lanes.entertainment = a;
      continue;
    }

    if (
      lanes.politics &&
      lanes.world &&
      lanes.finance &&
      lanes.crypto &&
      lanes.entertainment
    ) {
      break;
    }
  }

  const order = ["politics", "world", "finance", "crypto", "entertainment"];
  const headlineKey = order.find((k) => lanes[k]);

  res.json({
    region: reg,
    lanes,
    headlineKey,
  });
});

// ---------------------- AI BLOGS ENDPOINT ----------------------
// Returns one blog per persona (Jessica, John, Joe) for today.
app.get("/api/blogs", async (req, res) => {
  try {
    const blogs = await getBlogsForToday();
    const today = new Date().toISOString().slice(0, 10);

    res.json({
      date: today,
      blogs,
    });
  } catch (e) {
    console.error("Error in /api/blogs", e);
    res.status(500).json({ error: "Failed to generate blogs" });
  }
});
// -------------------- END AI BLOGS ENDPOINT --------------------

app.get("/api/article/:id", (req, res) => {
  const id = req.params.id;
  const all = loadArticles();
  const found = all.find(x => x.id === id);
  if (!found) return res.status(404).json({ error: "not found" });
  res.json(found);
});

// Chat-style follow-up questions for a specific persona about one article
app.post("/api/ask-ai", async (req, res) => {
  try {
    const { articleId, persona, question, basePerspective, title } = req.body || {};

    if (!question || !persona) {
      return res.status(400).json({ error: "Missing persona or question" });
    }

    // Load article (for extra context) if an ID was provided
    const all = loadArticles();
    const article = articleId ? all.find((x) => x.id === articleId) : null;

    const articleTitle =
      title || article?.title || "Untitled story from NotifAi News";
    const articleSummary = article?.summary || "";
    const cat = article?.category || "";
    const regionCode = cat.includes(":") ? cat.split(":")[0] : "us";
    const lang = langForRegion(regionCode || "us");

    const system = personaChatSystem(persona, lang);

    const userPrompt = `
Story title: ${articleTitle}

Short summary (for context):
${articleSummary || "(no stored summary, just answer based on the question)"}

Earlier persona perspective (from the debate):
${basePerspective || "(no previous persona text given)"}

The user is asking a follow-up question or challenge about this story:

"${question}"

Respond as the persona, speaking directly to the user.
Treat this as a live debate with the user:
- Take a clear stance that fits your ideology.
- Address their question or challenge directly.
- If they disagree, defend your view, but you can concede small points.
- Only mention detailed sources or references if the user explicitly asks.

Keep your reply very concise and punchy: usually 3–6 sentences.
Do not repeat the earlier paragraph word-for-word; move the conversation forward.
Stay focused on this specific story and the user’s question.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: 220,
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I’m having trouble answering right now, please try again.";

    res.json({ answer });
  } catch (e) {
    console.error("ask-ai error", e?.message || e);
    res.status(500).json({ error: "Failed to generate answer" });
  }
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
  const report = { global: {}, regions: {} };

  for (const [lane, feeds] of Object.entries(FEEDS_GLOBAL)) {
    report.global[lane] = [];
    for (const f of feeds) {
      try {
        const r = await parser.parseURL(f);
        report.global[lane].push({ feed: f, ok: !!(r.items && r.items.length), items: (r.items||[]).length });
      } catch (e) {
        report.global[lane].push({ feed: f, ok: false, error: e.message||String(e) });
      }
    }
  }

  for (const region of REGIONS) {
    report.regions[region] = {};
    const conf = FEEDS_REGIONAL[region];
    for (const lane of ["politics", "finance", "entertainment"]) {
      report.regions[region][lane] = [];
      for (const f of (conf[lane] || [])) {
        try {
          const r = await parser.parseURL(f);
          report.regions[region][lane].push({ feed: f, ok: !!(r.items && r.items.length), items: (r.items||[]).length });
        } catch (e) {
          report.regions[region][lane].push({ feed: f, ok: false, error: e.message||String(e) });
        }
      }
    }
  }

  res.json(report);
});

/* --------------------------------------------------------
   IMAGE PROXY + SHARE PAGE (unchanged)
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

function htmlesc(s='') {
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
}
function firstLine(s='', n=240) {
  return String(s).replace(/\s+/g,' ').trim().slice(0, n);
}
function getOrigin(req) {
  return process.env.SITE_ORIGIN || `${req.protocol}://${req.get('host')}`;
}
app.get('/share/:id', (req, res) => {
  const id = req.params.id;
  const articles = loadArticles();
  const a = articles.find(x => x.id === id);
  if (!a) { res.status(404).send('Article not found'); return; }

  const origin   = getOrigin(req);
  const pageUrl  = `${origin}/article.html?id=${encodeURIComponent(id)}`;
  const shareUrl = `${origin}/share/${encodeURIComponent(id)}`;
  const rawImg   = a.image && /^https?:\/\//i.test(a.image) ? a.image : `${origin}/cover.jpg`;
  const ogImg    = `${origin}/img?u=${encodeURIComponent(rawImg)}&w=1200`;
  const title    = a.title || 'NotifAi News';
  const desc     = firstLine(a.summary || `${a.source || ''} • ${a.title || ''}`, 240);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${htmlesc(title)} — NotifAi News</title>
<meta name="description" content="${htmlesc(desc)}">
<link rel="canonical" href="${pageUrl}"><meta property="og:type" content="article">
<meta property="og:site_name" content="NotifAi News">
<meta property="og:title" content="${htmlesc(title)}">
<meta property="og:description" content="${htmlesc(desc)}">
<meta property="og:image" content="${ogImg}">
<meta property="og:url" content="${shareUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${htmlesc(title)}">
<meta name="twitter:description" content="${htmlesc(desc)}">
<meta name="twitter:image" content="${ogImg}">
<meta http-equiv="refresh" content="0; url=${pageUrl}"></head>
<body><p>Redirecting to <a href="${pageUrl}">article</a>…</p></body>
</html>`);
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
