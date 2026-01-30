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
import admin from "firebase-admin";
import rateLimit from "express-rate-limit";
import bcrypt from 'bcryptjs';  // ADD THIS
import jwt from 'jsonwebtoken';  // ADD THIS
import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY 
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

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
// If you are behind Render/Proxy/CDN, enable this for correct IP
app.set("trust proxy", 1);

// Temporary abuse controls (no app update required)
const rewardsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,  // Reduced from 30
  standardHeaders: true,
  legacyHeaders: false,
});

const rewardsWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,   // Reduced from 10
  standardHeaders: true,
  legacyHeaders: false,
});

/* --------------------------------------------------------
   AD-BASED REWARDS CONFIGURATION
--------------------------------------------------------- */
const AD_REWARDS_CONFIG = {
  TOKENS_PER_AD: 1,
  DAILY_TOKEN_CAP: 300,
  AD_COOLDOWN_MS: 30 * 1000,
  MAX_ADS_PER_HOUR: 60,
  INVITE: {
    REQUIRED_ADS: 10,
    BONUS_TOKENS: 1,
    COMMISSION_RATE: 0.10,
  }
};

const adRewardsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests' }
});

app.use(express.static(path.join(__dirname, "public")));

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const JWT_EXPIRY = '7d';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const parser = new Parser({
  requestOptions: {
    headers: { "User-Agent": "Mozilla/5.0 NotifAi/1.0 (+https://www.notifai.news)" },
    timeout: 15000
  }
});

/* --------------------------------------------------------
   FIREBASE ADMIN / FIRESTORE (REWARDS + REFERRALS)
--------------------------------------------------------- */

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    console.warn(
      "[FIREBASE] Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY env. " +
        "Rewards & referrals API will NOT work until these are set."
    );
  } else {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
    console.log("[FIREBASE] Admin initialized");
  }
}

const db = admin.apps.length ? admin.firestore() : null;
const USERS_COL = db ? db.collection("notifaiUsers") : null;
const REFERRALS_COL = db ? db.collection("notifaiReferralProgress") : null;

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
    "https://www.aljazeera.com/xml/rss/all.xml",
  ],
  crypto: [
    "https://cointelegraph.com/rss",
    "https://decrypt.co/feed",
    "https://www.coindesk.com/arc/outboundfeeds/rss/"
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

  /* -------- China (Chinese + English) -------- */
  cn: {
    politics: [
      "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml",
      "https://rss.dw.com/rdf/rss-chi-all",
      "https://www.scmp.com/rss/4/feed",     // SCMP – China (English)
    ],

    finance: [
      "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml",
      "https://rss.dw.com/rdf/rss-chi-all",
      "https://www.scmp.com/rss/92/feed",   // SCMP – Business (English)
    ],

    entertainment: [
      "https://rss.dw.com/rdf/rss-chi-all",
      "https://www.scmp.com/rss/82/feed",   // SCMP – Culture / entertainment
      "https://www.scmp.com/rss/94/feed",   // SCMP – Lifestyle (lots of entertainment topics)
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
      "https://thecurrent.pk/feed",                   // The Current – young, English, mix of news
    ],

    finance: [
      "https://www.brecorder.com/rss",                // Business Recorder – main RSS
      "https://profit.pakistantoday.com.pk/feed/",    // Profit – works and has images
      "https://www.thenews.com.pk/rss/1/6",           // The News – Business
      "http://feeds.feedburner.com/dawn-news-business"// Dawn Business (feedburner)
    ],

    entertainment: [
      "https://arynews.tv/category/entertainment/feed/", // ARY – Entertainment
      "https://www.pakshowbiz.com/feed",                 // PakShowbiz – pure showbiz
      // You can re-add more once you confirm their XML is valid.
    ],
  },

  /* -------- Nigeria (English) -------- */
  ng: {
    // General Nigeria news / politics-heavy
    politics: [
      "https://guardian.ng/feed/",
      "https://www.premiumtimesng.com/feed",
      "https://dailypost.ng/feed",
      "https://thenationonlineng.net/feed/",
    ],

    // Business / finance-focused Nigeria feeds
    finance: [
      "https://businessday.ng/feed/",
      "https://nairametrics.com/feed",
      "https://www.premiumtimesng.com/feed",
    ],

    // Entertainment / celebrity / lifestyle
    entertainment: [
      "https://guardian.ng/feed",                      // Guardian Nigeria – includes entertainment & lifestyle
      "https://independent.ng/feed",                   // Independent Nigeria – general but strong showbiz/life coverage
      "https://informationng.com/feed",                // Information Nigeria – heavy on entertainment & celebrity gossip
      "https://www.legit.ng/rss/all.rss",              // Legit.ng – big mix incl. entertainment & Nollywood
      "https://www.yohaig.ng/author/gistlover/feed",   // Gistlover via Yohaig – Naija entertainment & celebrity gist
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

import crypto from "crypto";

// -------------------- TRANSLATION CACHE --------------------
const TRANSLATION_MEM = new Map(); // key -> { text, ts }
const TRANSLATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// -------------------- REWARDS CACHE --------------------
const USER_CACHE = new Map(); // userId -> { data, ts }
const USER_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const REFERRAL_CACHE = new Map(); // userId -> { data, ts }
const REFERRAL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const PENDING_REQUESTS = new Map(); // key -> Promise

const DASHBOARD_CACHE = new Map();
const DASHBOARD_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// -------------------- VERIFICATION CACHE (reduces Firestore reads) --------------------
const VERIFIED_USER_CACHE = new Map(); // userId -> { isVerified, email, ts }
const VERIFIED_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const DEVICE_MAP_CACHE = new Map(); // deviceId -> { linkedUserId, ts }
const DEVICE_MAP_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// -------------------- ME ENDPOINT CACHE --------------------
const ME_CACHE = new Map(); // oduserId -> { data, ts }
const ME_CACHE_TTL = 2 * 60 * 1000; // 2 minutes (short so users see updates)

// -------------------- AD REWARDS CACHE --------------------
const AD_TRACKING = new Map(); // userId -> { dayKey, tokensToday, lastAdAt, hourlyTimestamps }

// -------------------- END REWARDS CACHE --------------------

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || ""), "utf8").digest("hex");
}

function normLang(lang) {
  const x = String(lang || "en").toLowerCase();
  // Google translate uses "zh-CN"/"zh-TW" sometimes; you use "zh". Keep simple:
  if (x === "cn") return "zh";
  return x;
}

async function firestoreGetTranslation(db, key) {
  try {
    if (!db) return null;
    
    // Deduplicate concurrent requests
    const pendingKey = `translate:${key}`;
    if (PENDING_REQUESTS.has(pendingKey)) {
      console.log(`[DEDUP] Reusing pending request for ${key.slice(0, 20)}...`);
      return await PENDING_REQUESTS.get(pendingKey);
    }
    
    const promise = (async () => {
      const ref = db.collection("translations_v1").doc(key);
      const snap = await ref.get();
      if (!snap.exists) return null;
      const data = snap.data();
      if (!data?.text) return null;
      if (data.ts && Date.now() - data.ts > TRANSLATION_TTL_MS) return null;
      return data.text;
    })();
    
    PENDING_REQUESTS.set(pendingKey, promise);
    const result = await promise;
    PENDING_REQUESTS.delete(pendingKey);
    
    return result;
  } catch {
    return null;
  }
}

async function firestoreSetTranslation(db, key, text) {
  try {
    if (!db) return;
    await db.collection("translations_v1").doc(key).set({
      text,
      ts: Date.now(),
    }, { merge: true });
  } catch {
    // ignore
  }
}

async function googleTranslateText(text, target) {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) throw new Error("Missing GOOGLE_TRANSLATE_API_KEY");

  const body = {
    q: [String(text || "")],
    target: normLang(target),
    format: "text",
  };

  const maxRetries = 3;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        
        // If rate limited, wait and retry
        if (res.status === 403 && (t.includes("Rate Limit") || t.includes("userRateLimitExceeded"))) {
          const waitMs = Math.min(1000 * Math.pow(2, attempt), 8000); // 1s, 2s, 4s, max 8s
          console.warn(`[TRANSLATE] Rate limited, waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          lastError = new Error(`Translate HTTP ${res.status}: Rate limit exceeded`);
          continue; // Retry
        }
        
        // Other errors, throw immediately
        throw new Error(`Translate HTTP ${res.status}: ${t.slice(0, 250)}`);
      }

      const json = await res.json();
      const translated = json?.data?.translations?.[0]?.translatedText || "";
      return translated;
      
    } catch (err) {
      lastError = err;
      if (err.message && err.message.includes("Rate Limit") && attempt < maxRetries - 1) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[TRANSLATE] Error, waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}:`, err.message);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

async function translateTextCached(db, targetLang, text) {
  const target = normLang(targetLang);
  const raw = String(text || "").trim();

  if (!raw) return raw;
  if (!target || target === "en") return raw;

  const key = `${target}:${sha1(raw)}`;

  // memory cache
  const m = TRANSLATION_MEM.get(key);
  if (m && Date.now() - m.ts < TRANSLATION_TTL_MS) return m.text;

  // firestore cache
  const fromFs = await firestoreGetTranslation(db, key);
  if (fromFs) {
    TRANSLATION_MEM.set(key, { text: fromFs, ts: Date.now() });
    return fromFs;
  }

  // translate with error handling - never crash the server
  try {
    const translated = await googleTranslateText(raw, target);
    TRANSLATION_MEM.set(key, { text: translated, ts: Date.now() });
    await firestoreSetTranslation(db, key, translated);
    return translated;
  } catch (err) {
    console.error(`[TRANSLATE] Failed for "${raw.slice(0, 50)}..." to ${target}:`, err.message);
    // CRITICAL: Return original English text as fallback - don't crash the server
    return raw;
  }
}

async function translateArticleForLang(db, lang, article) {
  if (!article || !lang || lang === "en") return article;

  // Translate the fields your UI actually displays in lists and article view:
  const title = await translateTextCached(db, lang, article.title || "");
  const summary = await translateTextCached(db, lang, article.summary || "");

  // Translate debate JSON (AI perspectives) if it exists
  let debateJson = article.debateJson;
  if (article.debateJson) {
    try {
      const debate = JSON.parse(article.debateJson);
      
      // Translate each persona's perspective
      if (debate.socialist?.open) {
        debate.socialist.open = await translateTextCached(db, lang, debate.socialist.open);
      }
      if (debate.rightwing?.open) {
        debate.rightwing.open = await translateTextCached(db, lang, debate.rightwing.open);
      }
      if (debate.conspiracy?.open) {
        debate.conspiracy.open = await translateTextCached(db, lang, debate.conspiracy.open);
      }
      
      debateJson = JSON.stringify(debate);
    } catch (e) {
      console.error("Error translating debate:", e);
      // Keep original if translation fails
    }
  }

  return {
    ...article,
    title,
    summary,
    debateJson,
    // keep url/image/category/publishedAt etc unchanged
  };
}

async function translateBlogForLang(db, lang, blog) {
  if (!blog || !lang || lang === "en") return blog;

  return {
    ...blog,
    title: await translateTextCached(db, lang, blog.title || ""),
    body: await translateTextCached(db, lang, blog.body || ""),
  };
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
    if (
      host.endsWith("pakistantoday.com.pk") ||
      host.endsWith("profit.pakistantoday.com.pk")
    ) {
      return "https://profit.pakistantoday.com.pk/";
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

// --- LANGUAGE: requested lang support ---
const SUPPORTED_LANGS = new Set([
  "en",
  "zh", "zh-CN",
  "ur",
  "ar",
  "es",
  "de",
  "nl",
  "fr",
  "hi",
  "id",
]);

function normalizeLang(input) {
  const raw = String(input || "").trim();
  if (!raw) return "en";

  // normalize common variants
  const lower = raw.toLowerCase();
  if (lower === "cn" || lower === "zh-hans" || lower === "zh") return "zh-CN";
  if (lower === "id-id") return "id";
  if (lower === "ar-sa") return "ar";
  if (lower === "ur-pk") return "ur";

  // keep case for zh-CN; otherwise use lowercase
  const normalized = raw === "zh-CN" ? "zh-CN" : lower;

  return SUPPORTED_LANGS.has(normalized) ? normalized : "en";
}

function getRequestedLang(req, fallback = "en") {
  // priority: explicit request > fallback
  const q = req?.query?.lang;
  const b = req?.body?.lang;
  const picked = normalizeLang(q || b || fallback);
  return picked;
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
   IP-BASED USER DEDUPLICATION (No app update needed)
--------------------------------------------------------- */

// Map IP addresses to stable user IDs
const ipToUserIdMap = new Map(); // ip -> userId
const userIdToIpMap = new Map(); // userId -> ip

// Cleanup old mappings every hour
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const [ip, data] of ipToUserIdMap.entries()) {
    if (data.lastSeen < oneHourAgo) {
      const userId = data.userId;
      ipToUserIdMap.delete(ip);
      userIdToIpMap.delete(userId);
    }
  }
}, 3600000);

/**
 * Get stable userId for an IP address
 * If IP has been seen before, reuse the same userId
 * This prevents creating multiple users from same device
 */
function getStableUserIdForIp(ip, providedUserId) {
  const now = Date.now();
  
  // Check if we've seen this IP before
  const existing = ipToUserIdMap.get(ip);
  if (existing) {
    existing.lastSeen = now;
    return existing.userId;
  }
  
  // Check if this userId is already mapped to a different IP
  const existingIp = userIdToIpMap.get(providedUserId);
  if (existingIp && existingIp !== ip) {
    // This userId is being used from a different IP - it's likely spam
    // Create a new mapping for this IP
    const newUserId = `ip_${ip.replace(/\./g, '_')}_${nanoid(8)}`;
    ipToUserIdMap.set(ip, { userId: newUserId, lastSeen: now });
    userIdToIpMap.set(newUserId, ip);
    console.log(`[DEDUP] Assigning new userId ${newUserId} for IP ${ip}`);
    return newUserId;
  }
  
  // New IP + new userId - create mapping
  ipToUserIdMap.set(ip, { userId: providedUserId, lastSeen: now });
  userIdToIpMap.set(providedUserId, ip);
  return providedUserId;
}

/**
 * Get client IP address from request
 */
function getClientIp(req) {
  // Check various headers for real IP (Render, CloudFlare, etc.)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(ip => ip.trim());
    return ips[0]; // First IP is the client
  }
  
  return req.headers['x-real-ip'] || 
         req.headers['cf-connecting-ip'] || 
         req.connection?.remoteAddress || 
         req.socket?.remoteAddress || 
         'unknown';
}

/* --------------------------------------------------------
   REWARDS / REFERRALS HELPERS - PASTE THIS TO REPLACE OLD SECTION
   Starting around line 665 in your server.js
--------------------------------------------------------- */

function getWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const da = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function getDayKey(d = new Date()) {
  return d.toISOString().split('T')[0];
}

const REFERRAL_REQUIRED_SECONDS = 10 * 60;     // 10 minutes
const REFERRAL_INVITE_TOKENS    = 1;
const REFERRAL_COMMISSION_RATE  = 0.1;        // 10%

const MAX_INVITES_PER_WEEK = 200;
const MAX_TOKENS_PER_WEEK  = 300;
const MAX_SECONDS_PER_WEEK = 7 * 24 * 60 * 60;
const MAX_SECONDS_PER_CALL = 6 * 60 * 60;
const MIN_MS_BETWEEN_CALLS = 10000;

// Cache variables are declared earlier in the file (around line 269-273)

async function getOrCreateUser(userId) {
  if (!db || !USERS_COL) throw new Error("Firestore not configured");
  const docRef = USERS_COL.doc(userId);
  const snap = await docRef.get();
  if (snap.exists) {
    return { ref: docRef, data: snap.data() };
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  const weekKey = getWeekKey();
  const dayKey = getDayKey();
  const referralCode = nanoid(7);
  const data = {
    userId, createdAt: now, updatedAt: now,
    email: null, emailVerified: false, walletAddress: null,
    referralCode, referredByCode: null, referredByUserId: null,
    totalAdsWatched: 0,
    tokensTotal: 0,
    tokensToday: 0,
    tokensThisWeek: 0,
    tokensLastWeek: 0,
    tokensFromAds: 0,
    tokensFromInvites: 0,
    tokensFromCommission: 0,
    dayKey,
    weekKey,
    lastAdAt: null,
    invitesCompleted: 0,
    invitesStarted: 0,
    totalSeconds: 0,
    weeklySeconds: 0,
  };
  await docRef.set(data);
  return { ref: docRef, data };
}

async function ensureWeek(docRef, data) {
  const currentWeekKey = getWeekKey();
  if (data.weekKey === currentWeekKey) return data;
  const lastWeekTokens = data.tokensThisWeek || 0;
  const updated = {
    ...data, weekKey: currentWeekKey,
    weeklySeconds: 0, tokensThisWeek: 0, tokensLastWeek: lastWeekTokens,
  };
  await scheduleBatchedWrite(data.userId, {
    weekKey: currentWeekKey,
    weeklySeconds: 0,
    tokensThisWeek: 0,
    tokensLastWeek: lastWeekTokens,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  USER_CACHE.delete(updated.userId);
  return updated;
}

async function ensureDay(docRef, data) {
  const currentDayKey = getDayKey();
  const currentWeekKey = getWeekKey();
  const updates = {};
  let needsUpdate = false;
  if (data.dayKey !== currentDayKey) {
    updates.dayKey = currentDayKey;
    updates.tokensToday = 0;
    needsUpdate = true;
  }
  if (data.weekKey !== currentWeekKey) {
    updates.weekKey = currentWeekKey;
    updates.tokensLastWeek = data.tokensThisWeek || 0;
    updates.tokensThisWeek = 0;
    needsUpdate = true;
  }
  if (needsUpdate) {
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await docRef.update(updates);
    USER_CACHE.delete(data.userId);
    return { ...data, ...updates };
  }
  return data;
}

function getAdTracking(userId) {
  const dayKey = getDayKey();
  let tracking = AD_TRACKING.get(userId);
  if (!tracking || tracking.dayKey !== dayKey) {
    tracking = { dayKey, tokensToday: 0, lastAdAt: 0, hourlyTimestamps: [] };
    AD_TRACKING.set(userId, tracking);
  }
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  tracking.hourlyTimestamps = tracking.hourlyTimestamps.filter(ts => ts > oneHourAgo);
  return tracking;
}

async function processAdReward(userId) {
  if (!db || !USERS_COL) return { ok: false, error: 'Database not configured' };
  const config = AD_REWARDS_CONFIG;
  const tracking = getAdTracking(userId);
  const now = Date.now();
  if (tracking.hourlyTimestamps.length >= config.MAX_ADS_PER_HOUR) {
    return { ok: false, error: 'Hourly limit reached', hourlyLimit: true };
  }
  if (tracking.lastAdAt && (now - tracking.lastAdAt) < config.AD_COOLDOWN_MS) {
    const wait = Math.ceil((config.AD_COOLDOWN_MS - (now - tracking.lastAdAt)) / 1000);
    return { ok: false, error: `Wait ${wait}s`, cooldown: wait };
  }
  const docRef = USERS_COL.doc(userId);
  const snap = await docRef.get();
  if (!snap.exists) {
    await getOrCreateUser(userId);
    return processAdReward(userId);
  }
  let userData = snap.data();
  userData = await ensureDay(docRef, userData);
  const currentTokensToday = userData.tokensToday || 0;
  if (currentTokensToday >= config.DAILY_TOKEN_CAP) {
    return { ok: false, error: 'Daily limit reached', dailyLimit: true, tokensToday: currentTokensToday, dailyCap: config.DAILY_TOKEN_CAP };
  }
  const tokensToAward = Math.min(config.TOKENS_PER_AD, config.DAILY_TOKEN_CAP - currentTokensToday);
  if (tokensToAward <= 0) return { ok: false, error: 'Daily limit reached', dailyLimit: true };
  tracking.tokensToday += tokensToAward;
  tracking.lastAdAt = now;
  tracking.hourlyTimestamps.push(now);
  AD_TRACKING.set(userId, tracking);
  const dayKey = getDayKey();
  await docRef.update({
    totalAdsWatched: admin.firestore.FieldValue.increment(1),
    tokensTotal: admin.firestore.FieldValue.increment(tokensToAward),
    tokensToday: admin.firestore.FieldValue.increment(tokensToAward),
    tokensThisWeek: admin.firestore.FieldValue.increment(tokensToAward),
    tokensFromAds: admin.firestore.FieldValue.increment(tokensToAward),
    lastAdAt: admin.firestore.FieldValue.serverTimestamp(),
    [`adHistory.${dayKey}`]: admin.firestore.FieldValue.increment(1),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  USER_CACHE.delete(userId);
  ME_CACHE.delete(userId);
  DASHBOARD_CACHE.delete(userId);
  let inviterRewarded = false, inviterBonus = 0, commission = 0;
  if (userData.referredByUserId) {
    const result = await handleAdInviteRewards(userId, userData, tokensToAward);
    inviterRewarded = result.inviterRewarded;
    inviterBonus = result.inviterBonus;
    commission = result.commission;
  }
  const newTokensToday = currentTokensToday + tokensToAward;
  console.log(`[AD_REWARD] User ${userId} earned ${tokensToAward} (${newTokensToday}/${config.DAILY_TOKEN_CAP})`);
  return {
    ok: true, tokensAwarded: tokensToAward,
    totalTokens: (userData.tokensTotal || 0) + tokensToAward,
    totalAdsWatched: (userData.totalAdsWatched || 0) + 1,
    tokensToday: newTokensToday,
    tokensRemaining: config.DAILY_TOKEN_CAP - newTokensToday,
    dailyCap: config.DAILY_TOKEN_CAP,
    inviterRewarded, inviterBonus, commission,
  };
}

async function handleAdInviteRewards(inviteeUserId, inviteeData, tokensEarned) {
  const config = AD_REWARDS_CONFIG.INVITE;
  const inviterUserId = inviteeData.referredByUserId;
  if (!inviterUserId || !REFERRALS_COL) return { inviterRewarded: false, inviterBonus: 0, commission: 0 };
  const refDoc = REFERRALS_COL.doc(inviteeUserId);
  const refSnap = await refDoc.get();
  let refData;
  if (refSnap.exists) {
    refData = refSnap.data();
    if (refData.adsWatched === undefined) refData.adsWatched = 0;
  } else {
    refData = {
      inviteeUserId, inviterUserId,
      inviterReferralCode: inviteeData.referredByCode || null,
      adsWatched: 0, completed: false,
      tokensEarnedByInvitee: 0, commissionPaidToInviter: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  }
  const newAdsWatched = (refData.adsWatched || 0) + 1;
  const newTokensEarned = (refData.tokensEarnedByInvitee || 0) + tokensEarned;
  let inviterRewarded = false, inviterBonus = 0, commission = 0;
  const justCompletedInvite = !refData.completed && newAdsWatched >= config.REQUIRED_ADS;
  const inviterRef = USERS_COL.doc(inviterUserId);
  const inviterSnap = await inviterRef.get();
  if (!inviterSnap.exists) {
    await refDoc.set({ ...refData, adsWatched: newAdsWatched, tokensEarnedByInvitee: newTokensEarned, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { inviterRewarded: false, inviterBonus: 0, commission: 0 };
  }
  let inviterData = inviterSnap.data();
  inviterData = await ensureDay(inviterRef, inviterData);
  const inviterTokensToday = inviterData.tokensToday || 0;
  const inviterDailyRoom = AD_REWARDS_CONFIG.DAILY_TOKEN_CAP - inviterTokensToday;
  if (inviterDailyRoom <= 0) {
    await refDoc.set({ ...refData, adsWatched: newAdsWatched, tokensEarnedByInvitee: newTokensEarned, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { inviterRewarded: false, inviterBonus: 0, commission: 0 };
  }
  if (justCompletedInvite) {
    inviterBonus = Math.min(config.BONUS_TOKENS, inviterDailyRoom);
    inviterRewarded = true;
    refData.completed = true;
    refData.completedAt = admin.firestore.FieldValue.serverTimestamp();
  }
  if (refData.completed || justCompletedInvite) {
    const potentialCommission = Math.floor(tokensEarned * config.COMMISSION_RATE * 100) / 100;
    commission = Math.min(potentialCommission, Math.max(0, inviterDailyRoom - inviterBonus));
  }
  if (inviterBonus > 0 || commission > 0) {
    const totalToAdd = inviterBonus + commission;
    const inviterUpdate = {
      tokensTotal: admin.firestore.FieldValue.increment(totalToAdd),
      tokensToday: admin.firestore.FieldValue.increment(totalToAdd),
      tokensThisWeek: admin.firestore.FieldValue.increment(totalToAdd),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (inviterBonus > 0) {
      inviterUpdate.tokensFromInvites = admin.firestore.FieldValue.increment(inviterBonus);
      inviterUpdate.invitesCompleted = admin.firestore.FieldValue.increment(1);
    }
    if (commission > 0) {
      inviterUpdate.tokensFromCommission = admin.firestore.FieldValue.increment(commission);
    }
    await inviterRef.update(inviterUpdate);
    USER_CACHE.delete(inviterUserId);
    DASHBOARD_CACHE.delete(inviterUserId);
    console.log(`[INVITE] Inviter ${inviterUserId}: bonus=${inviterBonus}, commission=${commission}`);
  }
  await refDoc.set({
    ...refData, adsWatched: newAdsWatched, tokensEarnedByInvitee: newTokensEarned,
    commissionPaidToInviter: (refData.commissionPaidToInviter || 0) + commission,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  REFERRAL_CACHE.delete(inviteeUserId);
  return { inviterRewarded, inviterBonus, commission };
}

const WRITE_QUEUE = new Map();
const WRITE_BATCH_DELAY = 30000; // 30 seconds

async function scheduleBatchedWrite(userId, updates) {
  if (!USERS_COL) return;
  
  const existing = WRITE_QUEUE.get(userId);
  
  if (existing) {
    // Merge updates - this is the magic that saves writes!
    Object.assign(existing.updates, updates);
    console.log(`[BATCH] Merged update for ${userId}`);
    return;
  }
  
  // Schedule new write
  WRITE_QUEUE.set(userId, {
    updates,
    scheduledTime: Date.now() + WRITE_BATCH_DELAY
  });
  
  console.log(`[BATCH] Scheduled write for ${userId} in ${WRITE_BATCH_DELAY}ms`);
  
  // Execute after delay
  setTimeout(async () => {
    const queued = WRITE_QUEUE.get(userId);
    if (!queued) return;
    
    WRITE_QUEUE.delete(userId);
    
    try {
      const docRef = USERS_COL.doc(userId);
      await docRef.update(queued.updates);
      USER_CACHE.delete(userId);
      console.log(`[BATCH] ✅ Wrote ${Object.keys(queued.updates).length} fields for ${userId}`);
    } catch (err) {
      console.error(`[BATCH] ❌ Write failed for ${userId}:`, err.message);
    }
  }, WRITE_BATCH_DELAY);
}

async function trackUsageForUser(userId, seconds, { region, screen }) {
  if (!db || !USERS_COL) return;
  const docRef = USERS_COL.doc(userId);
  
  let cached = USER_CACHE.get(userId);
  let data;
  if (cached && Date.now() - cached.ts < USER_CACHE_TTL) {
    data = cached.data;
  } else {
    const snap = await docRef.get();
    if (!snap.exists) {
      const base = await getOrCreateUser(userId);
      data = base.data;
    } else {
      data = snap.data();
    }
    USER_CACHE.set(userId, { data, ts: Date.now() });
  }
  
  data = await ensureWeek(docRef, data);
  const nowMs = Date.now();
  const lastMs = Number(data.lastUsageAtMs || 0);
  
  // CRITICAL: Extend minimum time from 10s to 30s
  if (lastMs && (nowMs - lastMs < 30000)) {  // Was: MIN_MS_BETWEEN_CALLS (10000)
    console.log(`[TRACK] ⏭️ Skipping write for ${userId} - too soon (${Math.floor((nowMs - lastMs) / 1000)}s ago)`);
    return;
  }
  
  const rawInc = Number(seconds) || 0;
  if (!Number.isFinite(rawInc) || rawInc <= 0) return;
  let elapsedSec = lastMs ? Math.floor((nowMs - lastMs) / 1000) : rawInc;
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) elapsedSec = 0;
  const allowedByElapsed = elapsedSec + 3;
  let increment = Math.min(rawInc, allowedByElapsed, MAX_SECONDS_PER_CALL);
  if (increment <= 0) return;
  
  const prevWeeklySeconds = data.weeklySeconds || 0;
  const roomThisWeek = Math.max(0, MAX_SECONDS_PER_WEEK - prevWeeklySeconds);
  increment = Math.min(increment, roomThisWeek);
  if (increment <= 0) {
  // Use batched write even for timestamp-only updates
  await scheduleBatchedWrite(userId, {
    lastUsageAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return;
}
  
  const prevTotalSeconds = data.totalSeconds || 0;
  const totalSeconds = prevTotalSeconds + increment;
  const weeklySeconds = prevWeeklySeconds + increment;
  
  const hoursBefore = Math.floor(prevWeeklySeconds / 3600);
  const hoursAfter = Math.floor(weeklySeconds / 3600);
  const deltaUsageTokens = Math.max(0, hoursAfter - hoursBefore);
  
  let tokensTotal = data.tokensTotal || 0;
  let tokensThisWeek = data.tokensThisWeek || 0;
  let tokensEarnedThisCall = 0;
  
  if (deltaUsageTokens > 0) {
    const remaining = Math.max(0, MAX_TOKENS_PER_WEEK - tokensThisWeek);
    const mint = Math.min(deltaUsageTokens, remaining);
    if (mint > 0) {
      tokensTotal += mint;
      tokensThisWeek += mint;
      tokensEarnedThisCall += mint;
    }
  }
  
  const updatePayload = {
    totalSeconds, weeklySeconds, lastUsageAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastRegion: region || data.lastRegion || null,
    lastScreen: screen || data.lastScreen || null,
  };
  if (deltaUsageTokens > 0) {
    updatePayload.tokensTotal = tokensTotal;
    updatePayload.tokensThisWeek = tokensThisWeek;
  }
  const shouldWrite = true;
  if (shouldWrite) {
    await scheduleBatchedWrite(userId, updatePayload);
  
  // Update cache immediately for next request
  const updatedData = { ...data, ...updatePayload };
  USER_CACHE.set(userId, { data: updatedData, ts: Date.now() });
  
  // Clear dashboard cache so user sees updated stats
  DASHBOARD_CACHE.delete(userId);
  ME_CACHE && ME_CACHE.delete(userId);
  }
  
  if (data.referredByUserId && REFERRALS_COL) {
    await handleReferralRewards(
      userId, data, increment, totalSeconds,
      tokensEarnedThisCall, USERS_COL, REFERRALS_COL
    );
  }
}

async function handleReferralRewards(
  inviteeUserId, inviteeData, secondsIncrement, newTotalSeconds,
  inviteeTokensEarnedThisCall, USERS_COL, REFERRALS_COL
) {
  const refDoc = REFERRALS_COL.doc(inviteeUserId);
  let cachedRef = REFERRAL_CACHE.get(inviteeUserId);
  let refData;
  if (cachedRef && Date.now() - cachedRef.ts < REFERRAL_CACHE_TTL) {
    refData = cachedRef.data;
  } else {
    const refSnap = await refDoc.get();
    refData = refSnap.exists ? refSnap.data() : null;
    REFERRAL_CACHE.set(inviteeUserId, { data: refData, ts: Date.now() });
  }
  if (!refData) {
    refData = {
      userId: inviteeUserId,
      inviterUserId: inviteeData.referredByUserId,
      inviterReferralCode: inviteeData.referredByCode || null,
      totalSeconds: 0, completed: false,
      tokensEarnedByInvitee: 0, commissionPaidToInviter: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  }
  refData.totalSeconds = newTotalSeconds;
  refData.tokensEarnedByInvitee = (refData.tokensEarnedByInvitee || 0) + inviteeTokensEarnedThisCall;
  
  const inviterRef = USERS_COL.doc(inviteeData.referredByUserId);
  const inviterSnap = await inviterRef.get();
  if (!inviterSnap.exists) return;
  const inviterData = inviterSnap.data();
  const weekAdjustedInviter = await ensureWeek(inviterRef, inviterData);
  
  let inviterTokensTotal = weekAdjustedInviter.tokensTotal || 0;
  let inviterTokensThisWeek = weekAdjustedInviter.tokensThisWeek || 0;
  let inviterTokensFromInvites = weekAdjustedInviter.tokensFromInvites || 0;
  let inviterTokensFromCommission = weekAdjustedInviter.tokensFromCommission || 0;
  let inviterInvitesCompleted = weekAdjustedInviter.invitesCompleted || 0;
  
  let tokensToCredit = 0;
  let inviteTokens = 0;
  let commissionTokens = 0;
  
  const eligibleNow = newTotalSeconds >= REFERRAL_REQUIRED_SECONDS;
  let completedThisCall = false;
  if (!refData.completed && eligibleNow) {
    refData.completed = true;
    completedThisCall = true;
    refData.completedAt = admin.firestore.FieldValue.serverTimestamp();
    if (inviterTokensThisWeek < MAX_TOKENS_PER_WEEK) {
      tokensToCredit += REFERRAL_INVITE_TOKENS;
      inviteTokens += REFERRAL_INVITE_TOKENS;
      inviterInvitesCompleted += 1;
    }
  }
  
  if (inviteeTokensEarnedThisCall > 0) {
    const commission = Math.floor(inviteeTokensEarnedThisCall * REFERRAL_COMMISSION_RATE * 10) / 10;
    if (commission > 0) {
      const remaining = Math.max(0, MAX_TOKENS_PER_WEEK - (inviterTokensThisWeek + tokensToCredit));
      const mint = Math.min(commission, remaining);
      if (mint > 0) {
        tokensToCredit += mint;
        commissionTokens += mint;
        refData.commissionPaidToInviter = (refData.commissionPaidToInviter || 0) + mint;
      }
    }
  }
  
  await refDoc.set(refData, { merge: true });
  REFERRAL_CACHE.delete(inviteeUserId);
  
  if (tokensToCredit > 0) {
    inviterTokensTotal += tokensToCredit;
    inviterTokensThisWeek += tokensToCredit;
    inviterTokensFromInvites += inviteTokens;
    inviterTokensFromCommission += commissionTokens;
    await inviterRef.update({
      tokensTotal: inviterTokensTotal,
      tokensThisWeek: inviterTokensThisWeek,
      tokensFromInvites: inviterTokensFromInvites,
      tokensFromCommission: inviterTokensFromCommission,
      invitesCompleted: inviterInvitesCompleted,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    // Multi-level commission
    if (weekAdjustedInviter.referredByUserId && tokensToCredit > 0) {
      const grandInviterRef = USERS_COL.doc(weekAdjustedInviter.referredByUserId);
      const grandInviterSnap = await grandInviterRef.get();
      if (grandInviterSnap.exists) {
        const grandInviterData = grandInviterSnap.data();
        const weekAdjustedGrandInviter = await ensureWeek(grandInviterRef, grandInviterData);
        const grandCommission = Math.floor(tokensToCredit * REFERRAL_COMMISSION_RATE * 10) / 10;
        const grandRemaining = Math.max(0, MAX_TOKENS_PER_WEEK - (weekAdjustedGrandInviter.tokensThisWeek || 0));
        const grandMint = Math.min(grandCommission, grandRemaining);
        if (grandMint > 0) {
          await grandInviterRef.update({
            tokensTotal: admin.firestore.FieldValue.increment(grandMint),
            tokensThisWeek: admin.firestore.FieldValue.increment(grandMint),
            tokensFromCommission: admin.firestore.FieldValue.increment(grandMint),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    }
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

CRITICAL: This is a PERSONAL OPINION BLOG, NOT a news article or news summary.
Do NOT write about breaking news, current events, or news stories.
Do NOT report on what happened today in the news.

Instead, write a personal, opinion-based blog post from ${meta.displayName}'s perspective.

Pick ONE specific topic for a personal essay:
- A personal opinion or hot take on something
- A life experience, story, or reflection
- Food, travel, or lifestyle thoughts
- Technology or culture commentary (opinions, not news)
- Parenting, work, or daily life musings
- A controversial opinion or unpopular take

Write in first person "I", conversational and informal tone, up to 700 words.
Share YOUR thoughts, YOUR experiences, YOUR opinions - NOT news reports or summaries.

You may mention snippets of "your life" consistent with your persona backstory.
Do NOT reference NotifAi as an app or this server.

Return ONLY valid JSON with this exact shape:
{
  "title": "catchy personal blog headline (NOT a news headline)",
  "body": "full blog content as personal opinion essay"
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
    // For CN politics + finance we keep only trusted sources
    const cnHosts = [
      "bbc.com",
      "bbc.co.uk",
      "dw.com",
      "ifeng.com",
      "jiemian.com",
      // English-language China coverage
      "scmp.com",
      "reuters.com"
    ];

    // Entertainment: allow both Chinese + English feeds
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
   FETCH FROM FEED  (fixed + image fallback)
--------------------------------------------------------- */
async function fetchItemsFromFeed(feedUrl, takeN) {
  try {
    const xml  = await fetchRssText(feedUrl, { retries: 2 });
    const feed = await parseRssFromText(xml);
    const items = (feed.items || [])
      .filter((i) => i.link && i.title)
      .slice(0, takeN);

    const out = [];

    for (let i = 0; i < items.length; i += FETCH_CONCURRENCY) {
      const batch = items.slice(i, i + FETCH_CONCURRENCY);

      const settled = await Promise.allSettled(
        batch.map(async (it) => {
          // Canonical URL for this item
          const url = new URL(it.link, feedUrl).toString();

          // Try to extract an image from RSS enclosure / media tags
          let enclosureUrl =
            (it.enclosure &&
              (it.enclosure.url ||
                (Array.isArray(it.enclosure) ? it.enclosure[0]?.url : undefined))) ||
            (it["media:content"] &&
              (it["media:content"].url ||
                (it["media:content"]["$"] && it["media:content"]["$"].url))) ||
            (it["media:thumbnail"] &&
              (it["media:thumbnail"].url ||
                (it["media:thumbnail"]["$"] && it["media:thumbnail"]["$"].url)));

          if (enclosureUrl) {
            enclosureUrl = absoluteUrlMaybe(enclosureUrl, url);
            enclosureUrl = upgradeHttps(enclosureUrl);
          }

          const page = await fetchArticlePage(url);

          // Prefer article-page image, fall back to RSS enclosure if needed
          const image = page.image || enclosureUrl || "";

          return {
            url,
            title: String(it.title || "").trim(),
            source: new URL(feedUrl).hostname,
            publishedAt: it.isoDate
              ? new Date(it.isoDate).toISOString()
              : new Date().toISOString(),
            text: page.text || "",
            image,
          };
        })
      );

      settled.forEach((s) => {
        if (s.status === "fulfilled" && s.value) out.push(s.value);
      });
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

  // Fallback for China finance/entertainment:
  // if nothing came back from CN feeds, pull from global "world" lane
  if (
    region === "cn" &&
    (lane === "finance" || lane === "entertainment") &&
    filtered.length === 0
  ) {
    console.warn(`No CN ${lane} items found – falling back to world lane`);
    const worldItems = await ingestGlobalLane("world", FEEDS_GLOBAL.world);
    return worldItems
      .slice(0, INGEST_MAX_PER_CAT)
      .map(x => ({ ...x, category: `${region}:${lane}` }));
  }

  return filtered
    .slice(0, INGEST_MAX_PER_CAT)
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

// region query: ?region=us|cn|pk|id|uk|ng
app.get("/api/articles", async (req, res) => {
  const region = String(req.query.region || "us").toLowerCase();
  const reg = REGIONS.includes(region) ? region : "us";
  const limit = parseInt(req.query.limit || String(MAX_PER_CATEGORY || 12), 10);
  const lang = normLang(req.query.lang || "en"); // Get language parameter

  const toTime = (o) => {
    const p = o?.publishedAt ? Date.parse(o.publishedAt) : NaN;
    const c = o?.createdAt ? Date.parse(o.createdAt) : NaN;
    if (!Number.isNaN(p)) return p;
    if (!Number.isNaN(c)) return c;
    return 0;
  };

  const all = loadArticles().sort((a, b) => toTime(b) - toTime(a));

  // Map stored categories into the 5 lanes the UI expects
  const out = { us: [], entertainment: [], finance: [], world: [], crypto: [] };

// STEP 1: Collect articles first (don't translate yet)
  for (const a of all) {
    if (a.category === "world") {
      if (out.world.length < limit) out.world.push(a);
      continue;
    }
    if (a.category === "crypto") {
      if (out.crypto.length < limit) out.crypto.push(a);
      continue;
    }

    const [catRegion, lane] = String(a.category || "").split(":");
    if (!catRegion || !lane) continue;
    if (catRegion !== reg) continue;

    if (lane === "politics" && out.us.length < limit) out.us.push(a);
    if (lane === "finance" && out.finance.length < limit) out.finance.push(a);
    if (lane === "entertainment" && out.entertainment.length < limit) out.entertainment.push(a);
  }

  // STEP 2: Now translate ONLY what we're sending (if not English)
  if (lang !== "en") {
    console.log(`[API] Starting translation to ${lang}...`);
    const startTime = Date.now();

    // Collect all texts that need translation
    const translationTasks = [];
    const taskMeta = [];

    for (const [category, articles] of Object.entries(out)) {
      for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        
        // Add title translation task
        if (article.title) {
          translationTasks.push(translateTextCached(db, lang, article.title));
          taskMeta.push({ category, index: i, field: 'title' });
        }
        
        // Add summary translation task
        if (article.summary) {
          translationTasks.push(translateTextCached(db, lang, article.summary));
          taskMeta.push({ category, index: i, field: 'summary' });
        }
      }
    }

    console.log(`[API] Translating ${translationTasks.length} texts in parallel...`);

    // Execute all translations in parallel
    const translations = await Promise.all(translationTasks);

    // Apply translations back to articles
    translations.forEach((translatedText, idx) => {
      const meta = taskMeta[idx];
      out[meta.category][meta.index][meta.field] = translatedText;
    });

    const elapsed = Date.now() - startTime;
    console.log(`[API] Translation completed in ${elapsed}ms`);
  }
  
  res.json({ site: process.env.SITE_NAME || "NotifAi News", region: reg, categories: out });
});

app.post("/api/translate-ui", async (req, res) => {
  try {
    const { lang, items } = req.body || {};
    const target = normLang(lang);
    if (!target || target === "en") return res.json({ ok: true, map: {} });

    const inItems = Array.isArray(items) ? items : [];
    const out = {};

    for (const it of inItems) {
      const k = String(it?.key || "").trim();
      const v = String(it?.text || "").trim();
      if (!k || !v) continue;
      out[k] = await translateTextCached(db, target, v);
    }

    return res.json({ ok: true, map: out });
  } catch (e) {
    console.error("/api/translate-ui error", e?.message || e);
    return res.status(500).json({ ok: false, error: "Translate failed" });
  }
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
    const lang = normLang(req.query.lang || "en");  // ← ADD THIS LINE
    
    const blogs = await getBlogsForToday();
    const today = new Date().toISOString().slice(0, 10);

    // Translate blogs if not English
    const translatedBlogs = await Promise.all(
      blogs.map((b) => translateBlogForLang(db, lang, b))
    );

    res.json({
      date: today,
      blogs: translatedBlogs,  // ← CHANGED from 'blogs'
    });
  } catch (e) {
    console.error("Error in /api/blogs", e);
    res.status(500).json({ error: "Failed to generate blogs" });
  }
});
// -------------------- END AI BLOGS ENDPOINT --------------------

app.get("/api/article/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const all = loadArticles();
    const found = all.find((x) => x.id === id);
    if (!found) return res.status(404).json({ error: "not found" });

    const cat = found?.category || "";
    const regionCode = cat.includes(":") ? cat.split(":")[0] : "us";
    const fallbackLang = langForRegion(regionCode || "us");
    const lang = getRequestedLang(req, fallbackLang);

    const out = lang === "en" ? found : await translateArticleForLang(db, lang, found);
    return res.json(out);
  } catch (e) {
    console.error("GET /api/article/:id error", e?.message || e);
    return res.status(500).json({ error: "Failed to load article" });
  }
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
const fallbackLang = langForRegion(regionCode || "us");

// IMPORTANT: user-selected language overrides region language
const lang = getRequestedLang(req, fallbackLang);

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
   REWARDS / REFERRALS API
--------------------------------------------------------- */

// 1) Register / update user profile
app.post("/api/rewards/register", rewardsWriteLimiter, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: "Firestore not configured" });
    }

    const { userId: providedUserId, walletAddress, invitedByCode } = req.body || {};
    if (!providedUserId) {
      return res.status(400).json({ ok: false, error: "Missing userId" });
    }

    // Get client IP and deduplicate
    const clientIp = getClientIp(req);
    const userId = getStableUserIdForIp(clientIp, providedUserId);
    
    // Log if we're deduplicating
    if (userId !== providedUserId) {
      console.log(`[DEDUP] Changed userId from ${providedUserId} to ${userId} for IP ${clientIp}`);
    }

    const { ref, data } = await getOrCreateUser(userId);
    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Wallet update (no validation beyond "starts with 0x")
if (walletAddress && walletAddress !== data.walletAddress) {
  // archive old stats into walletHistory array
  const historyEntry = {
  wallet: data.walletAddress || null,
  tokensTotal: data.tokensTotal || 0,
  tokensThisWeek: data.tokensThisWeek || 0,
  tokensLastWeek: data.tokensLastWeek || 0,
  invitesCompleted: data.invitesCompleted || 0,
  totalSeconds: data.totalSeconds || 0,
  at: new Date(),
};

updates.walletAddress = walletAddress;
updates.walletHistory = admin.firestore.FieldValue.arrayUnion(historyEntry);
// temporary: do not reset reward counters on wallet change
}

    // If new user enters "invitedByCode" and they don't already have one
    if (invitedByCode && !data.referredByCode) {
      const inviterSnap = await USERS_COL.where("referralCode", "==", invitedByCode)
        .limit(1)
        .get();
      if (!inviterSnap.empty) {
        const inviterDoc = inviterSnap.docs[0];
        const inviterUserId = inviterDoc.id;
        updates.referredByCode = invitedByCode;
        updates.referredByUserId = inviterUserId;

        // increment invitesStarted for inviter
        const inviterRef = USERS_COL.doc(inviterUserId);
        await inviterRef.update({
          invitesStarted: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    await ref.set(updates, { merge: true });
    const updatedSnap = await ref.get();
    const updated = updatedSnap.data();

    // Return updated user properly
const fresh = (await ref.get()).data();
return res.json({
  ok: true,
  user: {
    userId: fresh.userId,
    walletAddress: fresh.walletAddress || null,
    referralCode: fresh.referralCode,
    referredByCode: fresh.referredByCode || null,
    totalSeconds: fresh.totalSeconds || 0,
    weeklySeconds: fresh.weeklySeconds || 0,
    tokensTotal: fresh.tokensTotal || 0,
    tokensThisWeek: fresh.tokensThisWeek || 0,
    tokensLastWeek: fresh.tokensLastWeek || 0,   // You wanted this – now valid
    invitesCompleted: fresh.invitesCompleted || 0,
    invitesStarted: fresh.invitesStarted || 0,
  }
});
  } catch (err) {
    console.error("POST /api/rewards/register error", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// 2) Track usage - DISABLED (kept for backwards compatibility)
app.post("/api/rewards/track-usage", rewardsWriteLimiter, async (req, res) => {
  return res.json({ ok: true, message: 'Watch ads to earn tokens!', tokensAwarded: 0, minted: 0 });
});

/* --------------------------------------------------------
   AD REWARDS API ENDPOINTS
--------------------------------------------------------- */
app.post('/api/rewards/ad-watched', adRewardsLimiter, authenticateTokenOptional, async (req, res) => {
  try {
    const { userId: bodyUserId, adUnitId } = req.body;
    const userId = req.user?.userId || bodyUserId;
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId' });
    let isVerified = req.user?.verified === true;
    if (!isVerified) {
      const cached = VERIFIED_USER_CACHE.get(userId);
      if (cached && Date.now() - cached.ts < VERIFIED_CACHE_TTL) {
        isVerified = cached.isVerified;
      } else if (db && USERS_COL) {
        const userDoc = await USERS_COL.doc(userId).get();
        if (userDoc.exists) {
          isVerified = userDoc.data().emailVerified === true;
          VERIFIED_USER_CACHE.set(userId, { isVerified, ts: Date.now() });
        }
      }
    }
    if (!isVerified) {
      return res.status(403).json({ ok: false, error: 'Email verification required', requiresVerification: true });
    }
    const result = await processAdReward(userId);
    if (result.ok) console.log(`[AD] User ${userId} watched ad`);
    return res.json(result);
  } catch (error) {
    console.error('POST /api/rewards/ad-watched error:', error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/rewards/ad-status', rewardsLimiter, authenticateTokenOptional, async (req, res) => {
  try {
    const userId = req.user?.userId || req.query.userId;
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId' });
    const tracking = getAdTracking(userId);
    const now = Date.now();
    const config = AD_REWARDS_CONFIG;
    const cooldownRemaining = tracking.lastAdAt ? Math.max(0, config.AD_COOLDOWN_MS - (now - tracking.lastAdAt)) : 0;
    let tokensTotal = 0, tokensToday = 0, tokensFromAds = 0, tokensFromInvites = 0, tokensFromCommission = 0;
    let totalAdsWatched = 0, invitesCompleted = 0, referralCode = null, emailVerified = false;
    if (db && USERS_COL) {
      const userDoc = await USERS_COL.doc(userId).get();
      if (userDoc.exists) {
        const data = userDoc.data();
        tokensToday = data.dayKey !== getDayKey() ? 0 : (data.tokensToday || 0);
        tokensTotal = data.tokensTotal || 0;
        tokensFromAds = data.tokensFromAds || 0;
        tokensFromInvites = data.tokensFromInvites || 0;
        tokensFromCommission = data.tokensFromCommission || 0;
        totalAdsWatched = data.totalAdsWatched || 0;
        invitesCompleted = data.invitesCompleted || 0;
        referralCode = data.referralCode || null;
        emailVerified = data.emailVerified === true;
      }
    }
    const canWatchAd = cooldownRemaining === 0 && tokensToday < config.DAILY_TOKEN_CAP && emailVerified;
    return res.json({
      ok: true, canWatchAd, emailVerified,
      rewards: {
        tokensPerAd: config.TOKENS_PER_AD, dailyCap: config.DAILY_TOKEN_CAP,
        tokensToday, tokensRemaining: Math.max(0, config.DAILY_TOKEN_CAP - tokensToday),
        cooldownMs: cooldownRemaining, cooldownSeconds: Math.ceil(cooldownRemaining / 1000),
      },
      totals: { tokensTotal, tokensFromAds, tokensFromInvites, tokensFromCommission, totalAdsWatched, invitesCompleted, referralCode },
      invite: { requiredAds: config.INVITE.REQUIRED_ADS, bonusTokens: config.INVITE.BONUS_TOKENS, commissionRate: `${config.INVITE.COMMISSION_RATE * 100}%` }
    });
  } catch (error) {
    console.error('GET /api/rewards/ad-status error:', error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

const SSV_PROCESSED = new Map();
app.get('/api/admob-ssv', async (req, res) => {
  try {
    const { user_id, transaction_id, timestamp } = req.query;
    if (!user_id || !transaction_id) return res.status(400).send('Invalid');
    const callbackTime = parseInt(timestamp) || 0;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - callbackTime) > 86400) return res.status(400).send('Expired');
    if (SSV_PROCESSED.has(transaction_id)) return res.status(200).send('OK');
    SSV_PROCESSED.set(transaction_id, Date.now());
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [txId, ts] of SSV_PROCESSED) { if (ts < oneHourAgo) SSV_PROCESSED.delete(txId); }
    const result = await processAdReward(user_id);
    console.log(`[SSV] User ${user_id}: ${result.ok ? '+1' : result.error}`);
    res.status(200).send('OK');
  } catch (error) {
    console.error('[SSV] Error:', error);
    res.status(500).send('Error');
  }
});

// 3) Get current user's rewards dashboard
app.get("/api/rewards/me", rewardsLimiter, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res
        .status(500)
        .json({ ok: false, error: "Firestore not configured" });
    }

    const providedUserId = req.query.userId;
    if (!providedUserId) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing userId" });
    }

    // Get client IP and deduplicate
    const clientIp = getClientIp(req);
    const userId = getStableUserIdForIp(clientIp, providedUserId);

    // Check cache first (short TTL so users see updates quickly)
    const cached = ME_CACHE.get(userId);
    if (cached && Date.now() - cached.ts < ME_CACHE_TTL) {
      return res.json(cached.data);
    }

    const { ref, data } = await getOrCreateUser(userId);
    const ensured = await ensureWeek(ref, data);

    const responseData = {
      ok: true,
      user: {
        userId: ensured.userId,
        walletAddress: ensured.walletAddress || null,
        referralCode: ensured.referralCode,
        referredByCode: ensured.referredByCode || null,
        totalSeconds: ensured.totalSeconds || 0,
        weeklySeconds: ensured.weeklySeconds || 0,
        tokensTotal: ensured.tokensTotal || 0,
        tokensThisWeek: ensured.tokensThisWeek || 0,
        tokensLastWeek: ensured.tokensLastWeek || 0,
        invitesCompleted: ensured.invitesCompleted || 0,
        invitesStarted: ensured.invitesStarted || 0,
      },
    };

    // Cache for 2 minutes
    ME_CACHE.set(userId, { data: responseData, ts: Date.now() });

    return res.json(responseData);
  } catch (err) {
    console.error("GET /api/rewards/me error", err);
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Server error",
    });
  }
});

app.get("/api/debug/firestore", async (req, res) => {
  try {
    if (!db) {
      return res.json({
        ok: false,
        error: "db is null (admin not initialized)",
      });
    }
    const collections = await db.listCollections();
    return res.json({
      ok: true,
      collections: collections.map((c) => c.id),
    });
  } catch (err) {
    console.error("DEBUG /api/debug/firestore error", err);
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Unknown error",
    });
  }
});


/* --------------------------------------------------------
   ADMIN: CLEANUP GHOST USERS
--------------------------------------------------------- */

app.post("/api/admin/cleanup-ghosts", async (req, res) => {
  const adminSecret = req.headers['x-admin-secret'];
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!db || !USERS_COL) {
    return res.status(500).json({ error: "Firestore not configured" });
  }

  try {
    // Only delete users with < 60 seconds activity, no wallet, no tokens
    const allUsers = await USERS_COL.get();
    const batch = db.batch();
    let deleteCount = 0;
    const BATCH_SIZE = 500;

    for (const doc of allUsers.docs) {
      const data = doc.data();
      
      const isGhost = (
        (data.totalSeconds || 0) < 60 &&
        !data.walletAddress &&
        (data.tokensTotal || 0) === 0 &&
        (data.invitesCompleted || 0) === 0
      );

      if (isGhost) {
        batch.delete(doc.ref);
        deleteCount++;

        if (deleteCount % BATCH_SIZE === 0) {
          await batch.commit();
          console.log(`Deleted ${deleteCount} ghost users...`);
        }
      }
    }

    if (deleteCount % BATCH_SIZE !== 0) {
      await batch.commit();
    }

    // Cleanup orphaned referral docs
    if (REFERRALS_COL) {
      const allRefs = await REFERRALS_COL.get();
      const refBatch = db.batch();
      let refDelCount = 0;

      for (const doc of allRefs.docs) {
        const userId = doc.id;
        const userExists = await USERS_COL.doc(userId).get();
        
        if (!userExists.exists) {
          refBatch.delete(doc.ref);
          refDelCount++;

          if (refDelCount % BATCH_SIZE === 0) {
            await refBatch.commit();
          }
        }
      }

      if (refDelCount % BATCH_SIZE !== 0) {
        await refBatch.commit();
      }

      console.log(`Deleted ${refDelCount} orphaned referral docs`);
    }

    res.json({
      success: true,
      deletedUsers: deleteCount,
      message: `Cleaned up ${deleteCount} ghost users`
    });

  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message });
  }
});

/* --------------------------------------------------------
   AUTHENTICATION ROUTES - PASTE THIS BEFORE THE "START + AUTO-INGEST" SECTION
   Around line 2360 in your server.js
--------------------------------------------------------- */

// Authentication rate limiter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: 'Too many authentication attempts'
});

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ ok: false, error: 'No token provided' });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ ok: false, error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

function authenticateTokenOptional(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  // If no token, allow anonymous - don't return error
  if (!token) {
    return next();
  }
  
  // If token exists, verify it
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      // Invalid token - return error
      return res.status(403).json({ ok: false, error: 'Invalid or expired token' });
    }
    // Valid token - attach user to request
    req.user = user;
    next();
  });
}

// POST /api/auth/register
// POST /api/auth/register - Step 1: Send verification code
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    const { email, password, userId } = req.body;
    if (!email || !password || !userId) {
      return res.status(400).json({ ok: false, error: 'Email, password, and userId required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email format' });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: 'Password must be 8+ characters' });
    }
    
    const emailLower = email.toLowerCase().trim();
    
    // Block disposable email domains
    const disposableDomains = ['tempmail.com', 'throwaway.email', 'guerrillamail.com', 'mailinator.com', '10minutemail.com', 'temp-mail.org', 'fakeinbox.com', 'trashmail.com', 'yopmail.com', 'sharklasers.com', 'guerrillamail.info', 'grr.la', 'spam4.me'];
    const emailDomain = emailLower.split('@')[1];
    if (disposableDomains.some(d => emailDomain?.includes(d))) {
      return res.status(400).json({ ok: false, error: 'Please use a valid email address' });
    }
    
    const authCol = db.collection('notifaiUserAuth');
    const existingAuth = await authCol.doc(emailLower).get();
    if (existingAuth.exists) {
      return res.status(400).json({ ok: false, error: 'Email already registered' });
    }
    let userDoc = await USERS_COL.doc(userId).get();
    if (!userDoc.exists) {
      await getOrCreateUser(userId);
      userDoc = await USERS_COL.doc(userId).get();
    }
    const userData = userDoc.data();
    
    // Check rate limit - 5 minutes between verification emails
    const lastSent = verificationEmailsSent.get(emailLower);
    const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
    if (lastSent && Date.now() - lastSent < RATE_LIMIT_MS) {
      const waitSeconds = Math.ceil((RATE_LIMIT_MS - (Date.now() - lastSent)) / 1000);
      const waitMinutes = Math.floor(waitSeconds / 60);
      const waitSecs = waitSeconds % 60;
      return res.status(429).json({ 
        ok: false, 
        error: `Please wait ${waitMinutes}:${waitSecs.toString().padStart(2, '0')} before requesting another code`,
        retryAfter: waitSeconds
      });
    }
    
    // Generate 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + VERIFICATION_CODE_EXPIRY;
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Store pending registration
    verificationCodes.set(emailLower, {
      code,
      expiresAt,
      userId,
      passwordHash
    });
    
    // Send verification email
    try {
      if (resend) {
        await resend.emails.send({
          from: 'NotifAi <noreply@notifai.news>',
          to: emailLower,
          subject: 'Verify your NotifAi account',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #000000;">Welcome to NotifAi! 🎉</h2>
              <p>Your verification code is:</p>
              <div style="background: #000000; color: #ffffff; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; border-radius: 8px; margin: 20px 0;">
                ${code}
              </div>
              <p style="color: #6b7280;">This code expires in 15 minutes.</p>
              <p style="color: #6b7280;">Enter this code in the app to complete your registration.</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
              <p style="color: #9ca3af; font-size: 12px;">NotifAi News - Earn rewards for reading news</p>
            </div>
          `
        });
        console.log(`[VERIFY] Sent verification email to ${emailLower}`);
      } else {
        // Fallback: log to console if Resend not configured
        console.log(`[VERIFY] Resend not configured. Code for ${emailLower}: ${code}`);
      }
    } catch (emailError) {
      console.error('[VERIFY] Email send error:', emailError);
      // Still return success - code is stored
      console.log(`[VERIFY] Fallback - Code for ${emailLower}: ${code}`);
    }

    console.log(`[VERIFY] Sent verification email to ${emailLower}`);
        verificationEmailsSent.set(emailLower, Date.now()); // Track when email was sent
    
    res.json({
      ok: true,
      message: 'Verification code sent to your email',
      requiresVerification: true
    });
    
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ ok: false, error: 'Registration failed' });
  }
});

// POST /api/auth/verify-email - Step 2: Verify code and complete registration
app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ ok: false, error: 'Email and code required' });
    }
    
    const emailLower = email.toLowerCase().trim();
    const pending = verificationCodes.get(emailLower);
    
    if (!pending) {
      return res.status(400).json({ ok: false, error: 'No pending registration. Please register again.' });
    }
    
    if (Date.now() > pending.expiresAt) {
      verificationCodes.delete(emailLower);
      return res.status(400).json({ ok: false, error: 'Code expired. Please register again.' });
    }
    
    if (pending.code !== code.trim()) {
      return res.status(400).json({ ok: false, error: 'Invalid verification code' });
    }
    
    // Code is valid - complete registration
    const { userId, passwordHash } = pending;
    
    const authCol = db.collection('notifaiUserAuth');
    
    // Double-check email isn't taken (race condition protection)
    const existingAuth = await authCol.doc(emailLower).get();
    if (existingAuth.exists) {
      verificationCodes.delete(emailLower);
      return res.status(400).json({ ok: false, error: 'Email already registered' });
    }
    
    // Create the auth record
    await authCol.doc(emailLower).set({
      email: emailLower,
      passwordHash,
      userId,
      emailVerified: true,
      verifiedAt: new Date(),
      createdAt: new Date(),
      lastLogin: new Date()
    });
    
    // Update user record
    await USERS_COL.doc(userId).update({
      email: emailLower,
      emailVerified: true,
      updatedAt: new Date()
    });
    
    // Clear pending registration
    verificationCodes.delete(emailLower);
    
    // Get user data for response
    const userDoc = await USERS_COL.doc(userId).get();
    const userData = userDoc.data();
    
    // Generate JWT token
    const token = jwt.sign({ email: emailLower, userId }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    
    console.log(`[VERIFY] Email verified and account created: ${emailLower}`);
    
    res.json({
      ok: true,
      token,
      user: {
        email: emailLower,
        userId,
        walletAddress: userData.walletAddress || null,
        referralCode: userData.referralCode,
        tokensTotal: userData.tokensTotal || 0
      }
    });
    
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({ ok: false, error: 'Verification failed' });
  }
});

// POST /api/auth/resend-verification - Resend verification code
app.post('/api/auth/resend-verification', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ ok: false, error: 'Email required' });
    }
    
    const emailLower = email.toLowerCase().trim();
    const pending = verificationCodes.get(emailLower);
    
    if (!pending) {
      return res.status(400).json({ ok: false, error: 'No pending registration. Please register again.' });
    }

// Check rate limit - 5 minutes between verification emails
    const lastSent = verificationEmailsSent.get(emailLower);
    const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
    if (lastSent && Date.now() - lastSent < RATE_LIMIT_MS) {
      const waitSeconds = Math.ceil((RATE_LIMIT_MS - (Date.now() - lastSent)) / 1000);
      const waitMinutes = Math.floor(waitSeconds / 60);
      const waitSecs = waitSeconds % 60;
      return res.status(429).json({ 
        ok: false, 
        error: `Please wait ${waitMinutes}:${waitSecs.toString().padStart(2, '0')} before requesting another code`,
        retryAfter: waitSeconds
      });
    }
    
    // Generate new code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + VERIFICATION_CODE_EXPIRY;
    
    // Update stored registration with new code
    verificationCodes.set(emailLower, {
      ...pending,
      code,
      expiresAt
    });
    
    // Send new verification email
    try {
      if (resend) {
        await resend.emails.send({
          from: 'NotifAi <noreply@notifai.news>',
          to: emailLower,
          subject: 'Your new NotifAi verification code',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #000000;">New Verification Code</h2>
              <p>Your new verification code is:</p>
              <div style="background: #000000; color: #ffffff; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; border-radius: 8px; margin: 20px 0;">
                ${code}
              </div>
              <p style="color: #6b7280;">This code expires in 15 minutes.</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
              <p style="color: #9ca3af; font-size: 12px;">NotifAi News - Earn rewards for reading news</p>
            </div>
          `
        });
        console.log(`[VERIFY] Resent verification email to ${emailLower}`);
      } else {
        console.log(`[VERIFY] Resend not configured. New code for ${emailLower}: ${code}`);
      }
    } catch (emailError) {
      console.error('[VERIFY] Email resend error:', emailError);
      console.log(`[VERIFY] Fallback - New code for ${emailLower}: ${code}`);
    }

    console.log(`[VERIFY] Resent verification email to ${emailLower}`);
        verificationEmailsSent.set(emailLower, Date.now()); // Track when email was sent
    
    res.json({
      ok: true,
      message: 'New verification code sent'
    });
    
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ ok: false, error: 'Failed to resend code' });
  }
});

// POST /api/auth/cancel-registration - Allow user to try different email
app.post('/api/auth/cancel-registration', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ ok: false, error: 'Email required' });
    const emailLower = email.toLowerCase().trim();
    if (verificationCodes.has(emailLower)) {
      verificationCodes.delete(emailLower);
      console.log(`[AUTH] Cancelled registration for ${emailLower}`);
    }
    res.json({ ok: true, message: 'You can now try with a different email.' });
  } catch (error) {
    console.error('Cancel registration error:', error);
    res.status(500).json({ ok: false, error: 'Failed to cancel' });
  }
});

// POST /api/auth/send-verification
app.post('/api/auth/send-verification', authLimiter, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ ok: false, error: 'Email required' });
    }
    
    const emailLower = email.toLowerCase().trim();
    
    // Check if user exists in auth collection
    const authCol = db.collection('notifaiUserAuth');
    const authDoc = await authCol.doc(emailLower).get();
    
    if (!authDoc.exists) {
      // Don't reveal if email exists
      return res.json({ ok: true, message: 'If that email is registered, a verification code has been sent' });
    }
    
    const authData = authDoc.data();
    
    // Check if already verified
    if (authData.emailVerified === true) {
      return res.json({ ok: true, alreadyVerified: true, message: 'Email already verified' });
    }

// Check rate limit - 5 minutes between verification emails
    const lastSent = verificationEmailsSent.get(emailLower);
    const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
    if (lastSent && Date.now() - lastSent < RATE_LIMIT_MS) {
      const waitSeconds = Math.ceil((RATE_LIMIT_MS - (Date.now() - lastSent)) / 1000);
      const waitMinutes = Math.floor(waitSeconds / 60);
      const waitSecs = waitSeconds % 60;
      return res.status(429).json({ 
        ok: false, 
        error: `Please wait ${waitMinutes}:${waitSecs.toString().padStart(2, '0')} before requesting another code`,
        retryAfter: waitSeconds
      });
    }
    
    // Generate 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + VERIFICATION_CODE_EXPIRY;
    
    // Store verification code for existing user
    verificationCodes.set(emailLower, {
      code,
      expiresAt,
      userId: authData.userId,
      isExistingUser: true
    });
    
    // Send verification email
    try {
      if (resend) {
        await resend.emails.send({
          from: 'NotifAi <noreply@notifai.news>',
          to: emailLower,
          subject: 'Verify your NotifAi email',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #000000;">Verify Your Email</h2>
              <p>To continue earning rewards, please verify your email address.</p>
              <p>Your verification code is:</p>
              <div style="background: #000000; color: #ffffff; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; border-radius: 8px; margin: 20px 0;">
                ${code}
              </div>
              <p style="color: #6b7280;">This code expires in 15 minutes.</p>
              <p style="color: #6b7280;">Enter this code in the app to verify your email and continue earning tokens.</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
              <p style="color: #9ca3af; font-size: 12px;">NotifAi News - Earn rewards for reading news</p>
            </div>
          `
        });
        console.log(`[VERIFY] Sent verification email to existing user ${emailLower}`);
      } else {
        console.log(`[VERIFY] Resend not configured. Code for ${emailLower}: ${code}`);
      }
    } catch (emailError) {
      console.error('[VERIFY] Email send error:', emailError);
      console.log(`[VERIFY] Fallback - Code for ${emailLower}: ${code}`);
    }

console.log(`[VERIFY] Sent verification email to existing user ${emailLower}`);
        verificationEmailsSent.set(emailLower, Date.now()); // Track when email was sent
    
    res.json({
      ok: true,
      message: 'Verification code sent to your email'
    });
    
  } catch (error) {
    console.error('Send verification error:', error);
    res.status(500).json({ ok: false, error: 'Failed to send verification code' });
  }
});

// POST /api/auth/verify-existing - Verify email for EXISTING registered user
app.post('/api/auth/verify-existing', authLimiter, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ ok: false, error: 'Email and code required' });
    }
    
    const emailLower = email.toLowerCase().trim();
    const pending = verificationCodes.get(emailLower);
    
    if (!pending) {
      return res.status(400).json({ ok: false, error: 'No verification pending. Request a new code.' });
    }
    
    if (Date.now() > pending.expiresAt) {
      verificationCodes.delete(emailLower);
      return res.status(400).json({ ok: false, error: 'Code expired. Request a new code.' });
    }
    
    if (pending.code !== code.trim()) {
      return res.status(400).json({ ok: false, error: 'Invalid verification code' });
    }
    
    // Code is valid - mark user as verified
    const { userId } = pending;
    
    const authCol = db.collection('notifaiUserAuth');
    
    // Update auth record
    await authCol.doc(emailLower).update({
      emailVerified: true,
      verifiedAt: new Date()
    });
    
    // Update user record
    await USERS_COL.doc(userId).update({
      emailVerified: true,
      verifiedAt: new Date(),
      updatedAt: new Date()
    });
    
    // Clear pending verification
    verificationCodes.delete(emailLower);
    
    console.log(`[VERIFY] Existing user verified: ${emailLower} (${userId})`);
    
    // Generate new token with verified status
    const token = jwt.sign({ email: emailLower, userId, verified: true }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    
    res.json({
      ok: true,
      token,
      message: 'Email verified successfully! You can now earn tokens.'
    });
    
  } catch (error) {
    console.error('Verify existing error:', error);
    res.status(500).json({ ok: false, error: 'Verification failed' });
  }
});

// GET /api/auth/verification-status - Check if user's email is verified
app.get('/api/auth/verification-status', authenticateToken, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    
    const { userId, email } = req.user;
    
    const userDoc = await USERS_COL.doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    
    const userData = userDoc.data();
    
    res.json({
      ok: true,
      email: email,
      emailVerified: userData.emailVerified === true,
      verifiedAt: userData.verifiedAt || null
    });
    
  } catch (error) {
    console.error('Verification status error:', error);
    res.status(500).json({ ok: false, error: 'Failed to check status' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    const { email, password, deviceUserId } = req.body; // Accept deviceUserId from app
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password required' });
    }
    const emailLower = email.toLowerCase().trim();
    const authCol = db.collection('notifaiUserAuth');
    const authDoc = await authCol.doc(emailLower).get();
    if (!authDoc.exists) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }
    const authData = authDoc.data();
    const isValid = await bcrypt.compare(password, authData.passwordHash);
    if (!isValid) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }
    
    // SERVER-ONLY FIX: Link deviceUserId to this account if provided
    if (deviceUserId && deviceUserId !== authData.userId) {
      // Store device mapping so track-usage can find the right account
      const deviceMapCol = db.collection('notifaiDeviceMap');
      await deviceMapCol.doc(deviceUserId).set({
        linkedUserId: authData.userId,
        email: emailLower,
        linkedAt: new Date()
      }, { merge: true });
      console.log(`[LOGIN] Linked device ${deviceUserId} to user ${authData.userId} (${emailLower})`);
    }
    
    await authCol.doc(emailLower).update({ lastLogin: new Date() });
    const userDoc = await USERS_COL.doc(authData.userId).get();
    const userData = userDoc.data();
    const isVerified = userData.emailVerified === true || authData.emailVerified === true;
    const token = jwt.sign({ email: emailLower, userId: authData.userId, verified: isVerified }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({
      ok: true, token,
      user: {
        email: emailLower, 
        userId: authData.userId,
        walletAddress: userData.walletAddress,
        referralCode: userData.referralCode,
        tokensTotal: userData.tokensTotal || 0,
        emailVerified: isVerified
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    const { currentPassword, newPassword } = req.body;
    const { email } = req.user;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: 'Current and new password required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ ok: false, error: 'New password must be 8+ characters' });
    }
    const authCol = db.collection('notifaiUserAuth');
    const authDoc = await authCol.doc(email).get();
    if (!authDoc.exists) {
      return res.status(404).json({ ok: false, error: 'Account not found' });
    }
    const authData = authDoc.data();
    const isValid = await bcrypt.compare(currentPassword, authData.passwordHash);
    if (!isValid) {
      return res.status(401).json({ ok: false, error: 'Current password incorrect' });
    }
    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    await authCol.doc(email).update({
      passwordHash: newPasswordHash,
      updatedAt: new Date()
    });
    await USERS_COL.doc(authData.userId).update({
      passwordHash: newPasswordHash,
      updatedAt: new Date()
    });
    res.json({ ok: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ ok: false, error: 'Failed to change password' });
  }
});

/* --------------------------------------------------------
   DASHBOARD ROUTES - PASTE THIS AFTER AUTHENTICATION SECTION
   Around line 2360 in your server.js
--------------------------------------------------------- */

function getPreviousWeekKey() {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return getWeekKey(date);
}

/* --------------------------------------------------------
   PASSWORD RESET ROUTES
--------------------------------------------------------- */

// Store reset codes in memory (for production, use Redis or Firestore)
const resetCodes = new Map(); // email -> { code, expiresAt }
const RESET_CODE_EXPIRY = 15 * 60 * 1000; // 15 minutes

// NEW: Store email verification codes and pending registrations
const verificationCodes = new Map(); // email -> { code, expiresAt, userId, passwordHash }
const verificationEmailsSent = new Map(); // email -> timestamp of last email sent
const VERIFICATION_CODE_EXPIRY = 15 * 60 * 1000; // 15 minutes

// POST /api/auth/request-reset
app.post('/api/auth/request-reset', authLimiter, async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ ok: false, error: 'Email required' });
    }
    
    const emailLower = email.toLowerCase().trim();
    const authCol = db.collection('notifaiUserAuth');
    const authDoc = await authCol.doc(emailLower).get();
    
    // Always return success (don't reveal if email exists)
    if (!authDoc.exists) {
      return res.json({
        ok: true,
        message: 'If that email exists, a reset code has been sent'
      });
    }
    
    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + RESET_CODE_EXPIRY;
    
    // Store code
    resetCodes.set(emailLower, { code, expiresAt });
    
    // Send email with reset code
    try {
      if (resend) {
        await resend.emails.send({
          from: 'NotifAi <noreply@notifai.news>',
          to: emailLower,
          subject: 'NotifAi Password Reset Code',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #000000;">Password Reset Request</h2>
              <p>Your password reset code is:</p>
              <div style="background: #000000; color: #ffffff; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; border-radius: 8px; margin: 20px 0;">
                ${code}
              </div>
              <p style="color: #6b7280;">This code expires in 15 minutes.</p>
              <p style="color: #6b7280;">If you didn't request this, please ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
              <p style="color: #9ca3af; font-size: 12px;">NotifAi News - Crypto Rewards</p>
            </div>
          `
        });
        
        console.log(`[PASSWORD RESET] Email sent successfully via Resend to ${emailLower}`);
      } else {
        // Fallback: log to console if Resend not configured
        console.log(`[PASSWORD RESET] Resend not configured. Code for ${emailLower}: ${code}`);
        console.log(`[PASSWORD RESET] Code expires in 15 minutes`);
        console.log(`[PASSWORD RESET] To enable email: npm install resend and set RESEND_API_KEY env var`);
      }
    } catch (emailError) {
      console.error('[PASSWORD RESET] Email send error:', emailError);
      // Don't fail the request if email fails - code is still valid
      console.log(`[PASSWORD RESET] Fallback - Code for ${emailLower}: ${code}`);
    }
    
    res.json({
      ok: true,
      message: 'If that email exists, a reset code has been sent',
      // ONLY FOR DEVELOPMENT - remove in production
      devCode: process.env.NODE_ENV === 'development' ? code : undefined
    });
    
  } catch (error) {
    console.error('Request reset error:', error);
    res.status(500).json({ ok: false, error: 'Failed to request reset' });
  }
});

// POST /api/auth/verify-reset-code
app.post('/api/auth/verify-reset-code', authLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ ok: false, error: 'Email and code required' });
    }
    
    const emailLower = email.toLowerCase().trim();
    const resetData = resetCodes.get(emailLower);
    
    if (!resetData) {
      return res.status(400).json({ ok: false, error: 'Invalid or expired code' });
    }
    
    if (Date.now() > resetData.expiresAt) {
      resetCodes.delete(emailLower);
      return res.status(400).json({ ok: false, error: 'Code expired' });
    }
    
    if (resetData.code !== code.trim()) {
      return res.status(400).json({ ok: false, error: 'Invalid code' });
    }
    
    // Code is valid - generate temporary token
    const resetToken = jwt.sign(
      { email: emailLower, type: 'password_reset' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );
    
    res.json({
      ok: true,
      resetToken,
      message: 'Code verified. You can now reset your password.'
    });
    
  } catch (error) {
    console.error('Verify code error:', error);
    res.status(500).json({ ok: false, error: 'Failed to verify code' });
  }
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    
    const { resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword) {
      return res.status(400).json({ ok: false, error: 'Reset token and new password required' });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ ok: false, error: 'Password must be 8+ characters' });
    }
    
    // Verify reset token
    let decoded;
    try {
      decoded = jwt.verify(resetToken, JWT_SECRET);
      if (decoded.type !== 'password_reset') {
        throw new Error('Invalid token type');
      }
    } catch (err) {
      return res.status(403).json({ ok: false, error: 'Invalid or expired reset token' });
    }
    
    const emailLower = decoded.email;
    const authCol = db.collection('notifaiUserAuth');
    const authDoc = await authCol.doc(emailLower).get();
    
    if (!authDoc.exists) {
      return res.status(404).json({ ok: false, error: 'Account not found' });
    }
    
    const authData = authDoc.data();
    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    
    // Update password
    await authCol.doc(emailLower).update({
      passwordHash: newPasswordHash,
      updatedAt: new Date()
    });
    
    await USERS_COL.doc(authData.userId).update({
      passwordHash: newPasswordHash,
      updatedAt: new Date()
    });
    
    // Clear reset code
    resetCodes.delete(emailLower);
    
    res.json({
      ok: true,
      message: 'Password reset successfully. You can now login.'
    });
    
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ ok: false, error: 'Failed to reset password' });
  }
});

// GET /api/rewards/dashboard
app.get('/api/rewards/dashboard', authenticateToken, async (req, res) => {
  try {
    if (!db || !USERS_COL || !REFERRALS_COL) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    const { userId } = req.user;
    
    // Check cache first
    const cached = DASHBOARD_CACHE.get(userId);
    if (cached && Date.now() - cached.ts < DASHBOARD_CACHE_TTL) {
      return res.json(cached.data);
    }
    
    // Rate limit: 1 refresh per minute per user
    const lastReq = DASHBOARD_CACHE.get(`lastReq:${userId}`);
    if (lastReq && Date.now() - lastReq < 60000) {
      if (cached) return res.json(cached.data);
      return res.status(429).json({ ok: false, error: 'Please wait before refreshing' });
    }
    DASHBOARD_CACHE.set(`lastReq:${userId}`, Date.now());

    const userDoc = await USERS_COL.doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    const userData = userDoc.data();
    
    // Get referral progress docs
    const inviteesSnap = await REFERRALS_COL.where('inviterUserId', '==', userId).get();
    const invitees = [];
    let invitesThisWeek = 0;
    let invitesLastWeek = 0;
    const currentWeekKey = getWeekKey();
    
    // ✅ FIX: Don't fetch individual user docs - use only referral progress data
    for (const doc of inviteesSnap.docs) {
      const refData = doc.data();
      
      // Calculate everything from referral progress data only
      const isActive = refData.totalSeconds >= 600;
      const status = isActive ? 'active' : 'pending';
      const inviteCompletionToken = refData.completed ? 1 : 0;
      const commissionEarned = refData.commissionPaidToInviter || 0;
      const totalEarnedFromInvitee = inviteCompletionToken + commissionEarned;
      
      invitees.push({
        userId: refData.userId,
        referralCode: userData.referralCode,
        joinedAt: refData.createdAt ? refData.createdAt.toDate().toISOString() : null,
        totalSeconds: refData.totalSeconds || 0,
        totalHours: Math.floor((refData.totalSeconds || 0) / 3600),
        tokensEarned: refData.tokensEarnedByInvitee || 0,
        yourEarnings: totalEarnedFromInvitee,
        inviteBonus: inviteCompletionToken,
        commissionEarned,
        status,
        completed: refData.completed || false
      });
      
      if (refData.completed) {
        const completedAt = refData.completedAt ? refData.completedAt.toDate() : null;
        if (completedAt) {
          const completedWeekKey = getWeekKey(completedAt);
          if (completedWeekKey === currentWeekKey) {
            invitesThisWeek++;
          } else if (completedWeekKey === getPreviousWeekKey()) {
            invitesLastWeek++;
          }
        }
      }
    }
    
    invitees.sort((a, b) => {
      const dateA = a.joinedAt ? new Date(a.joinedAt) : new Date(0);
      const dateB = b.joinedAt ? new Date(b.joinedAt) : new Date(0);
      return dateB - dateA;
    });
    
    // Build response
    const responseData = {
      ok: true,
      analytics: {
        tokensThisWeek: userData.tokensThisWeek || 0,
        tokensLastWeek: userData.tokensLastWeek || 0,
        tokensLifetime: userData.tokensTotal || 0,
        tokensFromInvites: userData.tokensFromInvites || 0,
        tokensFromCommission: userData.tokensFromCommission || 0,
        totalInvites: userData.invitesCompleted || 0,
        invitesThisWeek,
        invitesLastWeek,
        invitesStarted: userData.invitesStarted || 0,
        walletAddress: userData.walletAddress || null,
        referralCode: userData.referralCode,
        referredByCode: userData.referredByCode || null,
        email: userData.email || null,
        tokensToday: userData.tokensToday || 0,
        tokensFromAds: userData.tokensFromAds || 0,
        totalAdsWatched: userData.totalAdsWatched || 0,
        dailyCap: AD_REWARDS_CONFIG.DAILY_TOKEN_CAP,
        invitees,
        inviteesCount: invitees.length,
        activeInviteesCount: invitees.filter(i => i.status === 'active').length
      }
    };
    
    // Cache the response for 30 minutes
    DASHBOARD_CACHE.set(userId, {
      data: responseData,
      ts: Date.now()
    });
    
    console.log(`[CACHE] 📊 Dashboard cached for ${userId} (${invitees.length} invitees)`);
    
    // Send response ONCE
    res.json(responseData);
    
  } catch (error) {
    console.error('Dashboard error:', error);
    if (error.message?.includes('RESOURCE_EXHAUSTED')) {
      const cached = DASHBOARD_CACHE.get(req.user?.userId);
      if (cached) return res.json({ ...cached.data, _stale: true });
      return res.status(503).json({ ok: false, error: 'Service temporarily busy' });
    }
    res.status(500).json({ ok: false, error: 'Failed to load dashboard' });
  }
});;


// PUT /api/rewards/wallet
app.put('/api/rewards/wallet', authenticateToken, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    const { userId } = req.user;
    const { walletAddress } = req.body;
    if (!walletAddress) {
      return res.status(400).json({ ok: false, error: 'Wallet address required' });
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress.trim())) {
      return res.status(400).json({ ok: false, error: 'Invalid BSC wallet format' });
    }
    const userDoc = await USERS_COL.doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    const userData = userDoc.data();
    if (userData.walletAddress && userData.walletAddress !== walletAddress) {
      const historyEntry = {
        wallet: userData.walletAddress,
        tokensTotal: userData.tokensTotal || 0,
        tokensThisWeek: userData.tokensThisWeek || 0,
        tokensLastWeek: userData.tokensLastWeek || 0,
        invitesCompleted: userData.invitesCompleted || 0,
        totalSeconds: userData.totalSeconds || 0,
        at: new Date()
      };
      await USERS_COL.doc(userId).update({
        walletAddress: walletAddress.trim(),
        walletHistory: admin.firestore.FieldValue.arrayUnion(historyEntry),
        updatedAt: new Date()
      });
    } else {
      await USERS_COL.doc(userId).update({
        walletAddress: walletAddress.trim(),
        updatedAt: new Date()
      });
    }
    res.json({
      ok: true,
      message: 'Wallet address updated',
      walletAddress: walletAddress.trim()
    });
  } catch (error) {
    console.error('Update wallet error:', error);
    res.status(500).json({ ok: false, error: 'Failed to update wallet' });
  }
});

// PUT /api/rewards/invite-code - Link an invite code (one-time only)
app.put('/api/rewards/invite-code', authenticateToken, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    const { userId } = req.user;
    const { inviteCode } = req.body;
    
    if (!inviteCode) {
      return res.status(400).json({ ok: false, error: 'Invite code required' });
    }
    
    const userDoc = await USERS_COL.doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    
    const userData = userDoc.data();
    
    // Check if already has an invite code linked - cannot be changed
    if (userData.referredByCode) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Invite code already linked. It cannot be changed.',
        currentCode: userData.referredByCode
      });
    }
    
    // Cannot use your own referral code
    const trimmedCode = inviteCode.trim();
    console.log(`[INVITE-DEBUG] User ${userId} trying to link code: "${trimmedCode}" (length: ${trimmedCode.length}, chars: ${[...trimmedCode].map(c => c.charCodeAt(0)).join(',')})`);
    console.log(`[INVITE-DEBUG] User's own referralCode: "${userData.referralCode}"`);
    
    if (userData.referralCode === trimmedCode) {
      return res.status(400).json({ ok: false, error: 'You cannot use your own referral code' });
    }
    
    // Validate the invite code exists (case-sensitive - nanoid generates mixed case)
    const inviterSnap = await USERS_COL.where('referralCode', '==', trimmedCode)
      .limit(1)
      .get();
    
    console.log(`[INVITE-DEBUG] Query result: found=${!inviterSnap.empty}, docs=${inviterSnap.size}`);
    
    // Extra debug: if not found, try to find any similar codes
    if (inviterSnap.empty) {
      // Check if maybe the code exists with different casing
      const allUsersSnap = await USERS_COL.limit(10).get();
      const sampleCodes = allUsersSnap.docs.map(d => d.data().referralCode).filter(Boolean);
      console.log(`[INVITE-DEBUG] Sample referralCodes in DB: ${sampleCodes.join(', ')}`);
    }
    
    if (inviterSnap.empty) {
      return res.status(400).json({ ok: false, error: 'Invalid invite code' });
    }
    
    const inviterDoc = inviterSnap.docs[0];
    const inviterUserId = inviterDoc.id;
    
    // Link the invite code
    await USERS_COL.doc(userId).update({
      referredByCode: trimmedCode,
      referredByUserId: inviterUserId,
      updatedAt: new Date()
    });
    
    // Increment invitesStarted for inviter
    await USERS_COL.doc(inviterUserId).update({
      invitesStarted: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`[INVITE] User ${userId} linked to inviter ${inviterUserId} with code ${trimmedCode}`);
    
    res.json({
      ok: true,
      message: 'Invite code linked successfully!',
      inviteCode: trimmedCode
    });
    
  } catch (error) {
    console.error('Link invite code error:', error);
    res.status(500).json({ ok: false, error: 'Failed to link invite code' });
  }
});

// GET /api/rewards/export (Admin only)
app.get('/api/rewards/export', async (req, res) => {
  try {
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!db || !USERS_COL) {
      return res.status(500).json({ error: 'Firestore not configured' });
    }
    const weekFilter = req.query.week || 'current';
    const currentWeekKey = getWeekKey();
    let query = USERS_COL
      .where('tokensThisWeek', '>', 0)
      .where('walletAddress', '!=', null);
    const snapshot = await query.get();
    const users = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (weekFilter === 'last' && (data.tokensLastWeek || 0) <= 0) continue;
      if (weekFilter === 'current' && (data.tokensThisWeek || 0) <= 0) continue;
      users.push({
        email: data.email || 'N/A',
        userId: data.userId,
        walletAddress: data.walletAddress,
        referralCode: data.referralCode,
        tokensThisWeek: data.tokensThisWeek || 0,
        tokensLastWeek: data.tokensLastWeek || 0,
        tokensLifetime: data.tokensTotal || 0,
        tokensFromInvites: data.tokensFromInvites || 0,
        tokensFromCommission: data.tokensFromCommission || 0,
        invitesCompleted: data.invitesCompleted || 0,
        totalHours: Math.floor((data.totalSeconds || 0) / 3600),
        weekKey: data.weekKey
      });
    }
    users.sort((a, b) => b.tokensThisWeek - a.tokensThisWeek);
    res.json({
      ok: true,
      count: users.length,
      weekFilter,
      currentWeekKey,
      users
    });
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ ok: false, error: 'Failed to export data' });
  }
});

/* --------------------------------------------------------
   ADMIN PANEL ROUTES
--------------------------------------------------------- */

// GET /api/admin/users - List all users with emails and tokens
app.get('/api/admin/users', async (req, res) => {
  try {
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: 'Firestore not configured' });
    }
    
    const { withEmail, limit, exportAll } = req.query;
    
    // For export, allow up to 250000. For regular view, max 500
    const isExport = exportAll === 'true';
    const maxResults = isExport 
      ? Math.min(parseInt(limit) || 250000, 250000)
      : Math.min(parseInt(limit) || 100, 500);
    
    // Helper to safely convert date fields
    const safeDate = (val) => {
      if (!val) return null;
      try {
        if (typeof val === 'string') return val;
        if (val instanceof Date) return val.toISOString();
        if (val.toDate && typeof val.toDate === 'function') return val.toDate().toISOString();
        if (val._seconds) return new Date(val._seconds * 1000).toISOString();
      } catch (e) {
        console.error('Date conversion error:', e);
      }
      return null;
    };
    
    let users = [];
    
    // If filtering for registered users
    if (withEmail === 'true') {
      console.log(`[ADMIN] Fetching registered users (limit: ${maxResults}, export: ${isExport})...`);
      
      // Use pagination to fetch large datasets
      const BATCH_SIZE = 1000;
      let lastDoc = null;
      let fetchedCount = 0;
      
      while (fetchedCount < maxResults) {
        let query = USERS_COL
          .where('email', '!=', null)
          .orderBy('email')
          .limit(Math.min(BATCH_SIZE, maxResults - fetchedCount));
        
        if (lastDoc) {
          query = query.startAfter(lastDoc);
        }
        
        const snapshot = await query.get();
        
        if (snapshot.empty) {
          console.log(`[ADMIN] No more documents to fetch`);
          break;
        }
        
        console.log(`[ADMIN] Fetched batch of ${snapshot.docs.length} users (total: ${fetchedCount + snapshot.docs.length})`);
        
        for (const doc of snapshot.docs) {
          const data = doc.data();
          users.push({
            docId: doc.id,
            userId: data.userId || doc.id,
            email: data.email || null,
            emailVerified: data.emailVerified === true,
            walletAddress: data.walletAddress || null,
            referralCode: data.referralCode || null,
            referredByCode: data.referredByCode || null,
            tokensTotal: data.tokensTotal || 0,
            tokensThisWeek: data.tokensThisWeek || 0,
            tokensLastWeek: data.tokensLastWeek || 0,
            tokensFromInvites: data.tokensFromInvites || 0,
            tokensFromCommission: data.tokensFromCommission || 0,
            invitesCompleted: data.invitesCompleted || 0,
            invitesStarted: data.invitesStarted || 0,
            totalHours: Math.floor((data.totalSeconds || 0) / 3600),
            totalSeconds: data.totalSeconds || 0,
            createdAt: safeDate(data.createdAt)
          });
        }
        
        fetchedCount = users.length;
        lastDoc = snapshot.docs[snapshot.docs.length - 1];
        
        // If we got fewer than BATCH_SIZE, we've reached the end
        if (snapshot.docs.length < BATCH_SIZE) {
          break;
        }
      }
      
      // Sort by tokens descending
      users.sort((a, b) => (b.tokensTotal || 0) - (a.tokensTotal || 0));
      
      console.log(`[ADMIN] Returning ${users.length} registered users`);
      
    } else {
      // Regular fetch - just top users by tokens
      const query = USERS_COL.orderBy('tokensTotal', 'desc').limit(maxResults);
      const snapshot = await query.get();
      
      users = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          docId: doc.id,
          userId: data.userId,
          email: data.email || null,
          walletAddress: data.walletAddress || null,
          referralCode: data.referralCode,
          referredByCode: data.referredByCode || null,
          tokensTotal: data.tokensTotal || 0,
          tokensThisWeek: data.tokensThisWeek || 0,
          tokensLastWeek: data.tokensLastWeek || 0,
          tokensFromInvites: data.tokensFromInvites || 0,
          tokensFromCommission: data.tokensFromCommission || 0,
          invitesCompleted: data.invitesCompleted || 0,
          invitesStarted: data.invitesStarted || 0,
          totalHours: Math.floor((data.totalSeconds || 0) / 3600),
          totalSeconds: data.totalSeconds || 0,
          createdAt: safeDate(data.createdAt)
        };
      });
    }
    
    res.json({
      ok: true,
      count: users.length,
      users
    });
    
  } catch (error) {
    console.error('Admin users error:', error);
    console.error('Admin users error stack:', error.stack);
    res.status(500).json({ ok: false, error: 'Failed to fetch users', details: error.message });
  }
});

// GET /api/admin/check-registered - Debug endpoint to see all registered users
app.get('/api/admin/check-registered', async (req, res) => {
  try {
    const adminSecret = req.query.secret || req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    if (!db) {
      return res.status(500).json({ error: 'Firestore not configured' });
    }
    
    // Helper to safely convert date fields
    const safeDate = (val) => {
      if (!val) return null;
      if (typeof val === 'string') return val;
      if (val instanceof Date) return val.toISOString();
      if (val.toDate && typeof val.toDate === 'function') return val.toDate().toISOString();
      return null;
    };
    
    // Check notifaiUserAuth collection (all registered emails)
    const authCol = db.collection('notifaiUserAuth');
    const authSnap = await authCol.get();
    
    const authUsers = authSnap.docs.map(doc => {
      const data = doc.data();
      return {
        email: doc.id,
        userId: data.userId,
        createdAt: safeDate(data.createdAt),
        lastLogin: safeDate(data.lastLogin)
      };
    });
    
    // For each auth user, get their data from notifaiUsers
    const fullData = [];
    for (const authUser of authUsers) {
      const userDoc = await USERS_COL.doc(authUser.userId).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        fullData.push({
          email: authUser.email,
          userId: authUser.userId,
          // From notifaiUsers
          emailInUsers: userData.email || null,
          walletAddress: userData.walletAddress || null,
          tokensTotal: userData.tokensTotal || 0,
          referralCode: userData.referralCode || null,
          totalHours: Math.floor((userData.totalSeconds || 0) / 3600),
          // Status
          emailMatch: userData.email === authUser.email,
          authCreatedAt: authUser.createdAt,
          lastLogin: authUser.lastLogin
        });
      } else {
        fullData.push({
          email: authUser.email,
          userId: authUser.userId,
          error: 'User document not found in notifaiUsers',
          authCreatedAt: authUser.createdAt
        });
      }
    }
    
    res.json({
      ok: true,
      totalAuthRecords: authUsers.length,
      users: fullData
    });
    
  } catch (error) {
    console.error('Check registered error:', error);
    res.status(500).json({ error: 'Failed to check registered users', details: error.message });
  }
});

// GET /api/admin/sync-emails - Sync emails from auth to users collection
app.post('/api/admin/sync-emails', async (req, res) => {
  try {
    const adminSecret = req.query.secret || req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    if (!db || !USERS_COL) {
      return res.status(500).json({ error: 'Firestore not configured' });
    }
    
    // Get all auth records
    const authCol = db.collection('notifaiUserAuth');
    const authSnap = await authCol.get();
    
    let synced = 0;
    let errors = [];
    
    for (const doc of authSnap.docs) {
      const authData = doc.data();
      const email = doc.id;
      const userId = authData.userId;
      
      if (!userId) continue;
      
      try {
        // Check if user exists
        const userDoc = await USERS_COL.doc(userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          
          // If email is missing or different, update it
          if (!userData.email || userData.email !== email) {
            await USERS_COL.doc(userId).update({
              email: email,
              updatedAt: new Date()
            });
            synced++;
            console.log(`[SYNC] Updated email for ${userId}: ${email}`);
          }
        }
      } catch (err) {
        errors.push({ userId, email, error: err.message });
      }
    }
    
    res.json({
      ok: true,
      message: `Synced ${synced} users`,
      synced,
      errors: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    console.error('Sync emails error:', error);
    res.status(500).json({ error: 'Failed to sync emails', details: error.message });
  }
});

// GET /api/admin/dashboard - Simple HTML admin panel
app.get('/api/admin/dashboard', (req, res) => {
  const adminSecret = req.query.secret;
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).send('<h1>Forbidden</h1><p>Invalid admin secret</p>');
  }
  
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NotifAi Admin Panel</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    .header {
      background: white;
      padding: 30px;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
      margin-bottom: 30px;
    }
    .header h1 {
      color: #667eea;
      font-size: 32px;
      margin-bottom: 10px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: white;
      padding: 24px;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .stat-label {
      color: #666;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .stat-value {
      color: #667eea;
      font-size: 32px;
      font-weight: 700;
    }
    .filters {
      background: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      margin-bottom: 20px;
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
      align-items: center;
    }
    .filter-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .filter-group label {
      font-weight: 600;
      color: #333;
    }
    input, select {
      padding: 8px 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 14px;
    }
    button {
      background: #667eea;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
    }
    button:hover {
      background: #5568d3;
      transform: translateY(-2px);
    }
    .table-container {
      background: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      background: #f8f9fa;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      color: #333;
      border-bottom: 2px solid #e0e0e0;
      position: sticky;
      top: 0;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #e0e0e0;
    }
    tr:hover {
      background: #f8f9fa;
    }
    .loading {
      text-align: center;
      padding: 40px;
      color: #667eea;
      font-size: 18px;
    }
    .email {
      color: #667eea;
      font-weight: 500;
    }
    .wallet {
      font-family: monospace;
      font-size: 12px;
      color: #666;
    }
    .tokens {
      font-weight: 700;
      color: #10b981;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-high {
      background: #10b981;
      color: white;
    }
    .badge-med {
      background: #f59e0b;
      color: white;
    }
    .badge-low {
      background: #6b7280;
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 NotifAi Admin Panel</h1>
      <p style="color: #666; margin-top: 10px;">User management and rewards tracking</p>
    </div>

    <div class="stats" id="stats">
      <div class="stat-card">
        <div class="stat-label">Total Users</div>
        <div class="stat-value" id="totalUsers">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Registered</div>
        <div class="stat-value" id="registeredUsers">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Tokens</div>
        <div class="stat-value" id="totalTokens">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">This Week</div>
        <div class="stat-value" id="tokensThisWeek">-</div>
      </div>
    </div>

    <div class="filters">
      <div class="filter-group">
        <label>Filter:</label>
        <select id="filterType">
          <option value="all">All Users</option>
          <option value="registered">Registered Only</option>
          <option value="hasTokens">Has Tokens</option>
          <option value="hasWallet">Has Wallet</option>
        </select>
      </div>
      <div class="filter-group">
        <label>Limit:</label>
        <input type="number" id="limit" value="100" min="10" max="500" style="width: 80px">
      </div>
      <button onclick="loadUsers()">🔄 Refresh</button>
      <button onclick="exportCSV()">📥 Export CSV (view)</button>
      <button onclick="exportAllCSV()">📥 Export 250K CSV</button>
    </div>

    <div class="table-container">
      <div class="loading" id="loading">Loading users...</div>
      <table id="usersTable" style="display:none;">
        <thead>
          <tr>
            <th>Email</th>
            <th>Wallet Address</th>
            <th>Referral Code</th>
            <th>Invited By</th>
            <th>Tokens Total</th>
            <th>This Week</th>
            <th>Last Week</th>
            <th>Invites Done</th>
            <th>From Invites</th>
            <th>From Commission</th>
            <th>Hours</th>
          </tr>
        </thead>
        <tbody id="usersBody"></tbody>
      </table>
    </div>
  </div>

  <script>
    const ADMIN_SECRET = '${adminSecret}';
    let allUsers = [];

    async function loadUsers() {
      document.getElementById('loading').style.display = 'block';
      document.getElementById('usersTable').style.display = 'none';

      const filterType = document.getElementById('filterType').value;
      const limit = document.getElementById('limit').value;
      
      try {
        const params = new URLSearchParams({ limit });
        if (filterType === 'registered') params.append('withEmail', 'true');
        
        const res = await fetch(\`/api/admin/users?\${params}\`, {
          headers: { 'x-admin-secret': ADMIN_SECRET }
        });
        const data = await res.json();
        
        if (!data.ok) throw new Error(data.error);
        
        allUsers = data.users;
        
        // Apply client-side filters
        let filtered = allUsers;
        if (filterType === 'hasTokens') {
          filtered = allUsers.filter(u => u.tokensTotal > 0);
        } else if (filterType === 'hasWallet') {
          filtered = allUsers.filter(u => u.walletAddress);
        }
        
        displayUsers(filtered);
        updateStats(allUsers);
        
      } catch (error) {
        alert('Error loading users: ' + error.message);
      }
    }

    function displayUsers(users) {
      const tbody = document.getElementById('usersBody');
      tbody.innerHTML = '';
      
      users.forEach(user => {
        const row = document.createElement('tr');
        
        const tierBadge = user.tokensTotal >= 100 ? 'badge-high' : 
                          user.tokensTotal >= 20 ? 'badge-med' : 'badge-low';
        
        row.innerHTML = \`
          <td class="email">\${user.email || 'Anonymous'}</td>
          <td class="wallet">\${user.walletAddress ? user.walletAddress.slice(0, 10) + '...' : '-'}</td>
          <td>\${user.referralCode || '-'}</td>
          <td>\${user.referredByCode || '-'}</td>
          <td class="tokens">
            \${user.tokensTotal}
            <span class="badge \${tierBadge}">
              \${user.tokensTotal >= 100 ? 'VIP' : user.tokensTotal >= 20 ? 'Active' : 'New'}
            </span>
          </td>
          <td>\${user.tokensThisWeek}</td>
          <td>\${user.tokensLastWeek}</td>
          <td>\${user.invitesCompleted}</td>
          <td>\${user.tokensFromInvites || 0}</td>
          <td>\${user.tokensFromCommission || 0}</td>
          <td>\${user.totalHours}h</td>
        \`;
        
        tbody.appendChild(row);
      });
      
      document.getElementById('loading').style.display = 'none';
      document.getElementById('usersTable').style.display = 'table';
    }

    function updateStats(users) {
      const registered = users.filter(u => u.email).length;
      const totalTokens = users.reduce((sum, u) => sum + u.tokensTotal, 0);
      const tokensThisWeek = users.reduce((sum, u) => sum + u.tokensThisWeek, 0);
      
      document.getElementById('totalUsers').textContent = users.length;
      document.getElementById('registeredUsers').textContent = registered;
      document.getElementById('totalTokens').textContent = totalTokens.toFixed(0);
      document.getElementById('tokensThisWeek').textContent = tokensThisWeek.toFixed(0);
    }

    function exportCSV() {
      const csv = [
        ['Email', 'Email Verified', 'Wallet', 'Referral Code', 'Invited By', 'Tokens Total', 'This Week', 'Last Week', 'Invites Done', 'Invites Started', 'From Invites', 'From Commission', 'Hours', 'Total Seconds', 'Created At'].join(','),
        ...allUsers.map(u => [
          '"' + (u.email || 'Anonymous') + '"',
          u.emailVerified ? 'Yes' : 'No',
          u.walletAddress || '-',
          u.referralCode || '-',
          u.referredByCode || '-',
          u.tokensTotal,
          u.tokensThisWeek,
          u.tokensLastWeek,
          u.invitesCompleted,
          u.invitesStarted || 0,
          u.tokensFromInvites || 0,
          u.tokensFromCommission || 0,
          u.totalHours,
          u.totalSeconds || 0,
          u.createdAt || '-'
        ].join(','))
      ].join('\\n');
      
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`notifai-users-\${new Date().toISOString().split('T')[0]}.csv\`;
      a.click();
    }

    async function exportAllCSV() {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = '⏳ Loading 250K users...';
      
      try {
        const params = new URLSearchParams({ 
          limit: 250000,
          withEmail: 'true',
          exportAll: 'true'
        });
        
        const res = await fetch(\`/api/admin/users?\${params}\`, {
          headers: { 'x-admin-secret': ADMIN_SECRET }
        });
        const data = await res.json();
        
        if (!data.ok) throw new Error(data.error);
        
        btn.textContent = \`⏳ Generating CSV (\${data.users.length} users)...\`;
        
        const csv = [
          ['Email', 'Email Verified', 'Wallet', 'Referral Code', 'Invited By', 'Tokens Total', 'This Week', 'Last Week', 'Invites Done', 'Invites Started', 'From Invites', 'From Commission', 'Hours', 'Total Seconds', 'Created At'].join(','),
          ...data.users.map(u => [
            '"' + (u.email || 'Anonymous') + '"',
            u.emailVerified ? 'Yes' : 'No',
            u.walletAddress || '-',
            u.referralCode || '-',
            u.referredByCode || '-',
            u.tokensTotal,
            u.tokensThisWeek,
            u.tokensLastWeek,
            u.invitesCompleted,
            u.invitesStarted || 0,
            u.tokensFromInvites || 0,
            u.tokensFromCommission || 0,
            u.totalHours,
            u.totalSeconds || 0,
            u.createdAt || '-'
          ].join(','))
        ].join('\\n');
        
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = \`notifai-registered-users-\${data.users.length}-\${new Date().toISOString().split('T')[0]}.csv\`;
        a.click();
        
        alert(\`Exported \${data.users.length} registered users!\`);
        
      } catch (error) {
        alert('Export failed: ' + error.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '📥 Export 250K CSV';
      }
    }

    // Load on page load
    loadUsers();
  </script>
</body>
</html>
  `);
});

// NEW ENDPOINT TO ADD:
app.get('/api/admin/cache-stats', async (req, res) => {
  const adminSecret = req.headers['x-admin-secret'];
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  res.json({
    cacheStats: {
      users: USER_CACHE.size,
      referrals: REFERRAL_CACHE.size,
      translations: TRANSLATION_MEM.size,
      dashboards: DASHBOARD_CACHE.size,
      writeQueue: WRITE_QUEUE.size,
      pendingRequests: PENDING_REQUESTS.size,
      verifiedUsers: VERIFIED_USER_CACHE.size,
      deviceMappings: DEVICE_MAP_CACHE.size
    },
    cacheTTLs: {
      user: `${USER_CACHE_TTL / 1000 / 60}min`,
      referral: `${REFERRAL_CACHE_TTL / 1000 / 60}min`,
      dashboard: `${DASHBOARD_CACHE_TTL / 1000 / 60}min`,
      verified: `${VERIFIED_CACHE_TTL / 1000 / 60}min`,
      deviceMap: `${DEVICE_MAP_CACHE_TTL / 1000 / 60}min`,
      writeBatch: `${WRITE_BATCH_DELAY / 1000}s`
    },
    timestamp: new Date().toISOString()
  });
});

/* --------------------------------------------------------
   START + AUTO-INGEST
--------------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`▶ NotifAi News on http://localhost:${PORT}`);
});

// Optional: control first ingest with an env flag
const RUN_FIRST_INGEST = process.env.RUN_FIRST_INGEST === "true";

(async () => {
  try {
    if (RUN_FIRST_INGEST) {
      console.log("Scheduling first ingest in background…");
      // run AFTER startup, and don't block boot
      setTimeout(() => {
        console.time("first-ingest");
        console.log("Background first ingest…");
        ingestOnce()
          .then(() => console.timeEnd("first-ingest"))
          .catch((e) =>
            console.error("First ingest failed:", e?.message || e)
          );
      }, 5000); // 5 seconds after boot
    } else {
      console.log("Skipping first ingest at startup (RUN_FIRST_INGEST != 'true').");
    }

    console.log(`Auto-ingest interval set to ${INGEST_MINUTES} minute(s).`);
    if (INGEST_MINUTES > 0) {
      setInterval(() => {
        console.time("auto-ingest");
        console.log("Auto-ingest tick…");
        ingestOnce()
          .then(() => console.timeEnd("auto-ingest"))
          .catch((err) =>
            console.error("Auto-ingest failed:", err?.message || err)
          );
      }, INGEST_MINUTES * 60 * 1000);
    }
  } catch (e) {
    console.error("Ingest scheduler init failed:", e?.message || e);
  }
})();
