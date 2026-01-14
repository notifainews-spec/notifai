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
import helmet from "helmet";
import crypto from "crypto";

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

// ============================================================
// SECURITY IMPROVEMENTS
// ============================================================

// 1. CORS - Whitelist specific domains instead of allowing all origins
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [
      'https://www.notifai.news',
      'https://notifai.news',
      'http://localhost:3000', // for development
      'http://localhost:5173', // for vite dev
    ];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, postman)
    if (!origin) return callback(null, true);
    
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
      callback(null, true);
    } else {
      console.warn(`Blocked CORS request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  maxAge: 86400, // 24 hours
}));

// 2. Security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: false, // We'll serve static files
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '1mb' })); // Limit request body size
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Trust proxy for correct IP detection (Render, Cloudflare, etc.)
app.set("trust proxy", 1);

// 3. Enhanced Rate Limiting with multiple tiers
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // 200 requests per 15 minutes per IP
  message: { ok: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/api/health' || req.path === '/api/selftest';
  }
});

const rewardsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // Reduced from 120 to 30 requests/min/IP
  message: { ok: false, error: 'Rate limit exceeded for rewards endpoint' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by both IP and userId if authenticated
    const userId = req.userId || '';
    return `${req.ip}-${userId}`;
  }
});

const rewardsWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // Reduced from 60 to 20 writes/min
  message: { ok: false, error: 'Rate limit exceeded for write operations' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = req.userId || '';
    return `${req.ip}-${userId}`;
  }
});

// Apply general rate limiting to all routes
app.use(generalLimiter);

app.use(express.static(path.join(__dirname, "public")));

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
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      console.log("[FIREBASE] Admin initialized successfully");
    } catch (error) {
      console.error("[FIREBASE] Failed to initialize:", error.message);
    }
  }
}

const db = admin.apps.length ? admin.firestore() : null;
const USERS_COL = db ? db.collection("notifaiUsers") : null;
const REFERRALS_COL = db ? db.collection("notifaiReferralProgress") : null;

// ============================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================

/**
 * Verify Firebase Auth token and attach userId to request
 * This ensures the server controls userId, not the client
 */
async function verifyAuthToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        ok: false, 
        error: 'Unauthorized: Missing or invalid authorization header',
        hint: 'Include a valid Firebase Auth token as: Authorization: Bearer <token>'
      });
    }

    const token = authHeader.split('Bearer ')[1];
    
    if (!token) {
      return res.status(401).json({ 
        ok: false, 
        error: 'Unauthorized: No token provided' 
      });
    }

    // Verify the Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Attach verified userId to request - this is the ONLY source of truth
    req.userId = decodedToken.uid;
    req.userEmail = decodedToken.email || null;
    
    next();
  } catch (error) {
    console.error('Auth verification failed:', error.message);
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ 
        ok: false, 
        error: 'Token expired',
        hint: 'Please refresh your authentication token'
      });
    }
    
    return res.status(401).json({ 
      ok: false, 
      error: 'Invalid authentication token' 
    });
  }
}

/**
 * Optional auth - tries to verify but doesn't fail if no token
 * Useful for endpoints that work for both authenticated and anonymous users
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.userId = decodedToken.uid;
      req.userEmail = decodedToken.email || null;
    }
    
    next();
  } catch (error) {
    // Silent fail for optional auth
    next();
  }
}

/**
 *     // TEMPORARY: Allow userId from body (POST) OR query params (GET)
    if (allowLegacy) {
      // Check body first (POST/PUT requests)
      let legacyUserId = req.body && req.body.userId ? sanitizeUserId(req.body.userId) : null;
      
      // If not in body, check query params (GET requests)
      if (!legacyUserId && req.query && req.query.userId) {
        legacyUserId = sanitizeUserId(req.query.userId);
      }
      
      const legacyUserId = legacyUserId;

 * ⚠️ WARNING: This reduces security! Remove after app is updated!
 * Set ALLOW_LEGACY_AUTH=false in environment to disable
 */
async function backwardCompatibleAuth(req, res, next) {
  const allowLegacy = process.env.ALLOW_LEGACY_AUTH !== 'false';
  
  try {
    const authHeader = req.headers.authorization;
    
    // Try to use auth token first (preferred method)
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.userId = decodedToken.uid;
      req.userEmail = decodedToken.email || null;
      req.isAuthenticatedUser = true;
      console.log(`[AUTH] User authenticated with token: ${req.userId}`);
      return next();
    }
    
    // If Firebase Admin isn't initialized, token verification will always fail.
// Allow legacy auth only (or return a clear error).
if (!admin.apps.length) {
  if (!allowLegacy) {
    return res.status(503).json({ ok: false, error: "Auth not configured (Firebase Admin not initialized)" });
  }
  const legacyCandidate =
    req.body?.userId ||
    req.query?.userId ||
    req.headers["x-user-id"];

  const legacyUserId = sanitizeUserId(String(legacyCandidate || ""));
  if (legacyUserId) {
    req.userId = legacyUserId;
    req.isAuthenticatedUser = false;
    console.warn(`[LEGACY AUTH] User ${req.userId} using legacy authentication (no Firebase Admin)`);
    return next();
  }

  return res.status(401).json({ ok: false, error: "Authentication required", hint: "Provide x-user-id (legacy) or enable Firebase Admin" });
}

// TEMPORARY: Allow userId from body/query/header (legacy)
if (allowLegacy) {
  const legacyCandidate =
    req.body?.userId ||
    req.query?.userId ||
    req.headers["x-user-id"];

  const legacyUserId = sanitizeUserId(String(legacyCandidate || ""));
  if (legacyUserId) {
    req.userId = legacyUserId;
    req.isAuthenticatedUser = false;
    console.warn(`[LEGACY AUTH] User ${req.userId} using legacy authentication`);
    return next();
  }
}
    
    return res.status(401).json({ 
      ok: false, 
      error: 'Authentication required',
      hint: 'Include userId in body (POST) or query (GET)'
    });
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(401).json({ 
      ok: false, 
      error: 'Authentication failed' 
    });
  }
}

/* --------------------------------------------------------
   INPUT VALIDATION HELPERS
--------------------------------------------------------- */

function sanitizeUserId(userId) {
  if (!userId || typeof userId !== 'string') return null;
  // Firebase UIDs are alphanumeric with length 28
  const cleaned = userId.trim();
  if (cleaned.length < 10 || cleaned.length > 128) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(cleaned)) return null;
  return cleaned;
}

function sanitizeWalletAddress(address) {
  if (!address || typeof address !== 'string') return null;
  const cleaned = address.trim();
  // Basic validation for common wallet formats
  if (cleaned.length < 26 || cleaned.length > 100) return null;
  if (!/^[a-zA-Z0-9]+$/.test(cleaned)) return null;
  return cleaned;
}

function validateSeconds(seconds) {
  const num = Number(seconds);
  if (!Number.isFinite(num)) return null;
  if (num < 0 || num > 86400) return null; // Max 24 hours
  return Math.floor(num);
}

function sanitizeString(str, maxLength = 1000) {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
}

/* --------------------------------------------------------
   FEEDS (unchanged from original)
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

  cn: {
    politics: [
      "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml",
      "https://rss.dw.com/rdf/rss-chi-all",
      "https://www.scmp.com/rss/4/feed",
    ],
    finance: [
      "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml",
      "https://rss.dw.com/rdf/rss-chi-all",
      "https://www.scmp.com/rss/92/feed",
    ],
    entertainment: [
      "https://rss.dw.com/rdf/rss-chi-all",
      "https://www.scmp.com/rss/82/feed",
      "https://www.scmp.com/rss/94/feed",
    ],
  },

  pk: {
    politics: [
      "https://www.dawn.com/feeds/home",
      "https://tribune.com.pk/feed/pakistan",
      "https://www.thenews.com.pk/rss/1/1",
      "https://arynews.tv/feed",
      "https://www.pakistantoday.com.pk/feed",
      "https://thecurrent.pk/feed",
    ],
    finance: [
      "https://www.brecorder.com/rss",
      "https://profit.pakistantoday.com.pk/feed/",
      "https://www.thenews.com.pk/rss/1/6",
      "http://feeds.feedburner.com/dawn-news-business"
    ],
    entertainment: [
      "https://arynews.tv/category/entertainment/feed/",
      "https://www.pakshowbiz.com/feed",
    ],
  },

  ng: {
    politics: [
      "https://guardian.ng/feed/",
      "https://www.premiumtimesng.com/feed",
      "https://dailypost.ng/feed",
      "https://thenationonlineng.net/feed/",
    ],
    finance: [
      "https://businessday.ng/feed/",
      "https://nairametrics.com/feed",
      "https://www.premiumtimesng.com/feed",
    ],
    entertainment: [
      "https://guardian.ng/feed",
      "https://independent.ng/feed",
      "https://informationng.com/feed",
      "https://www.legit.ng/rss/all.rss",
      "https://www.yohaig.ng/author/gistlover/feed",
    ],
  },

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

// -------------------- TRANSLATION CACHE --------------------
const TRANSLATION_MEM = new Map();
const TRANSLATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || ""), "utf8").digest("hex");
}

function normLang(lang) {
  const x = String(lang || "en").toLowerCase();
  if (x === "cn") return "zh";
  return x;
}

async function firestoreGetTranslation(db, key) {
  try {
    if (!db) return null;
    const ref = db.collection("translations_v1").doc(key);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data?.text) return null;
    if (data.ts && Date.now() - data.ts > TRANSLATION_TTL_MS) return null;
    return data.text;
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

  const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Translate HTTP ${res.status}: ${t.slice(0, 250)}`);
  }

  const json = await res.json();
  const translated = json?.data?.translations?.[0]?.translatedText || "";
  return translated;
}

async function translateTextCached(db, targetLang, text) {
  const target = normLang(targetLang);
  const raw = String(text || "").trim();

  if (!raw) return raw;
  if (!target || target === "en") return raw;

  const key = `${target}:${sha1(raw)}`;

  const m = TRANSLATION_MEM.get(key);
  if (m && Date.now() - m.ts < TRANSLATION_TTL_MS) return m.text;

  const fromFs = await firestoreGetTranslation(db, key);
  if (fromFs) {
    TRANSLATION_MEM.set(key, { text: fromFs, ts: Date.now() });
    return fromFs;
  }

  let translated = raw;
try {
  translated = await googleTranslateText(raw, target);
} catch (e) {
  // Fail-open: if translation is unavailable (missing key / quota / network),
  // return original text so stories still load.
  console.warn("[Translate] Fallback to original text:", e?.message || e);
  translated = raw;
}

  TRANSLATION_MEM.set(key, { text: translated, ts: Date.now() });
  await firestoreSetTranslation(db, key, translated);

  return translated;
}

async function translateArticleForLang(db, lang, article) {
  if (!article || !lang || lang === "en") return article;

  const title = await translateTextCached(db, lang, article.title || "");
  const summary = await translateTextCached(db, lang, article.summary || "");

  return {
    ...article,
    title,
    summary,
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
    const origin = url.origin;

    if (host.endsWith("theguardian.com") || host.endsWith("guim.co.uk")) {
      return "https://www.theguardian.com/";
    }
    if (host.endsWith("rollingstone.com")) {
      return "https://www.rollingstone.com/";
    }
    if (host.endsWith("techcrunch.com") || host.endsWith("tctechcrunch2011.files.wordpress.com")) {
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
    if (host.endsWith("dawn.com") || host.endsWith("thenews.com.pk") || host.endsWith("brecorder.com")) {
      return "https://www.dawn.com/";
    }
    if (host.endsWith("pakistantoday.com.pk") || host.endsWith("profit.pakistantoday.com.pk")) {
      return "https://profit.pakistantoday.com.pk/";
    }
    if (host.endsWith("rfi.fr")) {
      return "https://www.rfi.fr/";
    }
    if (host.endsWith("gstatic.com") || host.endsWith("googleusercontent.com") || host.endsWith("news.google.com")) {
      return "https://news.google.com/";
    }

    return origin;
  } catch {
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

const SUPPORTED_LANGS = new Set([
  "en", "zh", "zh-CN", "ur", "ar", "es", "de", "nl", "fr", "hi", "id",
]);

function normalizeLang(input) {
  const raw = String(input || "").trim();
  if (!raw) return "en";

  const lower = raw.toLowerCase();
  if (lower === "cn" || lower === "zh-hans" || lower === "zh") return "zh-CN";
  if (lower === "id-id") return "id";
  if (lower === "ar-sa") return "ar";
  if (lower === "ur-pk") return "ur";

  const normalized = raw === "zh-CN" ? "zh-CN" : lower;

  return SUPPORTED_LANGS.has(normalized) ? normalized : "en";
}

function getRequestedLang(req, fallback = "en") {
  const q = req?.query?.lang;
  const b = req?.body?.lang;
  const picked = normalizeLang(q || b || fallback);
  return picked;
}

function langForRegion(region) {
  switch (region) {
    case "cn": return "zh-CN";
    case "id": return "id";
    default:   return "en";
  }
}

/* --------------------------------------------------------
   REWARDS / REFERRALS HELPERS
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

const REFERRAL_REQUIRED_SECONDS = 30 * 60;
const REFERRAL_INVITE_TOKENS    = 1;
const REFERRAL_COMMISSION_RATE  = 0.1;

// ============================================================
// ENHANCED WEEKLY GUARDRAILS
// ============================================================
const MAX_INVITES_PER_WEEK = 200;
const MAX_TOKENS_PER_WEEK  = 300;
const MAX_SECONDS_PER_WEEK = 7 * 24 * 60 * 60; // 604,800 seconds
const MAX_SECONDS_PER_CALL = 2 * 60 * 60; // Reduced from 6 to 2 hours per call
const MIN_MS_BETWEEN_CALLS = 5000; // Increased from 0 to 5 seconds

// Daily caps to prevent abuse
const MAX_TOKENS_PER_DAY = 50;
const MAX_SECONDS_PER_DAY = 24 * 60 * 60; // 86,400 seconds

async function getOrCreateUser(userId) {
  if (!db || !USERS_COL) throw new Error("Firestore not configured");

  const docRef = USERS_COL.doc(userId);
  const snap = await docRef.get();

  if (snap.exists) {
    return { ref: docRef, data: snap.data() };
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const weekKey = getWeekKey();
  const referralCode = nanoid(7);

  const data = {
    userId,
    createdAt: now,
    updatedAt: now,
    walletAddress: null,
    referralCode,
    referredByCode: null,
    referredByUserId: null,
    totalSeconds: 0,
    weeklySeconds: 0,
    dailySeconds: 0, // NEW: daily tracking
    dayKey: new Date().toISOString().slice(0, 10), // NEW: YYYY-MM-DD
    weekKey,
    tokensTotal: 0,
    tokensThisWeek: 0,
    tokensToday: 0, // NEW: daily tracking
    tokensLastWeek: 0,
    invitesCompleted: 0,
    invitesStarted: 0,
    lastUsageAtMs: 0,
  };

  await docRef.set(data);
  return { ref: docRef, data };
}

async function ensureWeek(docRef, data) {
  const currentWeekKey = getWeekKey();
  const currentDayKey = new Date().toISOString().slice(0, 10);
  
  let needsUpdate = false;
  const updates = {};

  // Check if week has changed
  if (data.weekKey !== currentWeekKey) {
    needsUpdate = true;
    const lastWeekTokens = data.tokensThisWeek || 0;

    updates.weekKey = currentWeekKey;
    updates.weeklySeconds = 0;
    updates.tokensThisWeek = 0;
    updates.tokensLastWeek = lastWeekTokens;
    updates.invitesCompleted = 0;
    updates.invitesStarted = 0;
  }

  // Check if day has changed
  if (data.dayKey !== currentDayKey) {
    needsUpdate = true;
    updates.dayKey = currentDayKey;
    updates.dailySeconds = 0;
    updates.tokensToday = 0;
  }

  if (needsUpdate) {
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await docRef.update(updates);
    
    return {
      ...data,
      ...updates,
    };
  }

  return data;
}

/**
 * IMPROVED: Track usage with stricter validation and daily caps
 */
async function trackUsageForUser(userId, seconds, { region, screen }) {
  if (!db || !USERS_COL) return;

  const docRef = USERS_COL.doc(userId);

  const snap = await docRef.get();
  let data;
  if (!snap.exists) {
    const base = await getOrCreateUser(userId);
    data = base.data;
  } else {
    data = snap.data();
  }

  data = await ensureWeek(docRef, data);

  const nowMs = Date.now();
  const lastMs = Number(data.lastUsageAtMs || 0);

  // Enforce minimum time between calls
  if (lastMs && (nowMs - lastMs < MIN_MS_BETWEEN_CALLS)) {
    console.warn(`[ABUSE] User ${userId} calling too frequently: ${nowMs - lastMs}ms since last call`);
    return;
  }

  const rawInc = Number(seconds) || 0;
  if (!Number.isFinite(rawInc) || rawInc <= 0) return;

  // Calculate elapsed time since last call
  let elapsedSec = lastMs ? Math.floor((nowMs - lastMs) / 1000) : rawInc;
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) elapsedSec = 0;

  // Allow small grace for timer jitter
  const allowedByElapsed = elapsedSec + 3;

  // Limit by: client claim, elapsed time, and max per call
  let increment = Math.min(rawInc, allowedByElapsed, MAX_SECONDS_PER_CALL);
  
  if (increment <= 0) return;

  // Enforce DAILY cap first
  const prevDailySeconds = data.dailySeconds || 0;
  const roomToday = Math.max(0, MAX_SECONDS_PER_DAY - prevDailySeconds);
  increment = Math.min(increment, roomToday);

  // Enforce WEEKLY cap
  const prevWeeklySeconds = data.weeklySeconds || 0;
  const roomThisWeek = Math.max(0, MAX_SECONDS_PER_WEEK - prevWeeklySeconds);
  increment = Math.min(increment, roomThisWeek);

  if (increment <= 0) {
    // User hit cap but still update timestamp
    await docRef.update({
      lastUsageAtMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[CAP] User ${userId} hit daily/weekly cap`);
    return;
  }

  const prevTotalSeconds = data.totalSeconds || 0;
  const totalSeconds = prevTotalSeconds + increment;
  const weeklySeconds = prevWeeklySeconds + increment;
  const dailySeconds = prevDailySeconds + increment;

  // Calculate tokens from WEEKLY usage (1 token per 3600 seconds)
  const weeklyTokensBefore = Math.floor(prevWeeklySeconds / 3600);
  const weeklyTokensAfter  = Math.floor(weeklySeconds / 3600);
  const deltaUsageTokens   = Math.max(0, weeklyTokensAfter - weeklyTokensBefore);

  let tokensTotal    = data.tokensTotal    || 0;
  let tokensThisWeek = data.tokensThisWeek || 0;
  let tokensToday    = data.tokensToday    || 0;

  if (deltaUsageTokens > 0) {
    // Enforce daily token cap
    const remainingToday = Math.max(0, MAX_TOKENS_PER_DAY - tokensToday);
    const remainingWeek = Math.max(0, MAX_TOKENS_PER_WEEK - tokensThisWeek);
    const mint = Math.min(deltaUsageTokens, remainingToday, remainingWeek);

    if (mint > 0) {
      tokensTotal += mint;
      tokensThisWeek += mint;
      tokensToday += mint;
    }
  }

  const updatePayload = {
    totalSeconds,
    weeklySeconds,
    dailySeconds,
    tokensTotal,
    tokensThisWeek,
    tokensToday,
    lastUsageAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await docRef.update(updatePayload);

  // ============================================================
  // REFERRAL SYSTEM (with fraud detection)
  // ============================================================
  if (data.referredByUserId && data.referredByCode) {
    const inviterRef = USERS_COL.doc(data.referredByUserId);
    const inviterSnap = await inviterRef.get();

    if (inviterSnap.exists) {
      const inviterData = inviterSnap.data();
      
      // Fraud detection: check if inviter and invitee have same IP patterns
      // (This would require storing IP hashes - implement if needed)
      
      const eligibleBefore = prevTotalSeconds >= REFERRAL_REQUIRED_SECONDS;
      const eligibleNow = totalSeconds >= REFERRAL_REQUIRED_SECONDS;

      let inviterInvites = inviterData.invitesCompleted || 0;
      let inviterTokensTotal = inviterData.tokensTotal || 0;
      let inviterTokensThisWeek = inviterData.tokensThisWeek || 0;

      // First-time completion bonus
      if (!eligibleBefore && eligibleNow) {
        const weeklyInvitesRoom = Math.max(0, MAX_INVITES_PER_WEEK - inviterInvites);
        if (weeklyInvitesRoom > 0) {
          inviterInvites += 1;

          const weeklyTokensRoom = Math.max(0, MAX_TOKENS_PER_WEEK - inviterTokensThisWeek);
          const mint = Math.min(REFERRAL_INVITE_TOKENS, weeklyTokensRoom);
          if (mint > 0) {
            inviterTokensTotal += mint;
            inviterTokensThisWeek += mint;
          }
        }
      }

      // Commission on invitee usage
      if (eligibleNow && deltaUsageTokens > 0) {
        const commission = Math.floor(deltaUsageTokens * REFERRAL_COMMISSION_RATE);
        if (commission > 0) {
          const remaining = Math.max(0, MAX_TOKENS_PER_WEEK - inviterTokensThisWeek);
          const mint = Math.min(commission, remaining);
          if (mint > 0) {
            inviterTokensTotal += mint;
            inviterTokensThisWeek += mint;
          }
        }
      }

      await inviterRef.update({
        tokensTotal: inviterTokensTotal,
        tokensThisWeek: inviterTokensThisWeek,
        invitesCompleted: inviterInvites,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
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
  
  try {
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
  } catch (error) {
    console.error('[OpenAI] Summary error:', error.message);
    return "Summary unavailable.";
  }
}

function personaPrompts(lang = "en") {
  const postfix = (lang === "zh-CN")
    ? "用简体中文回答。紧扣文章主题。1–3句。"
    : (lang === "id")
      ? "Jawab dalam Bahasa Indonesia. Tetap pada topik artikel. 1–3 kalimat."
      : "Reply in English. Stick to the article's topic. 1–3 sentences.";

  const SOCIALIST_SYS =
    `You are Jessica Rebella. Extremely Left-wing, very woke, socialist theology. pro-labor, anti-corporate, anti-war, anti-establishment, always anti-Trump. Frequently reference leftist history and critique capitalism/imperialism. you are very anti israeli. You are pro crypto for users but anti crypto for corporations. ${postfix}`;

  const RIGHTWING_SYS =
    `You are John Davis. Hardline conservative: pro-Trump, patriotic, hawkish, pro-market, completely anti immigration and pro white american theology, pro-life, anti-woke; confident and rude as well, very pro crypto. very pro israel. you dont go against trump on anything. unapologetic. ${postfix}`;

  const CONSP_SYS =
    `You are Joe Musk. Conspiracy-minded. Pick ONE angle relevant to the article (CIA/MI5/Mossad/elites/aliens/shadow governments etc.). You look at consipracies online and see which best fits the narratives. You mainly create your own conspiracies that fit the story and they can be absurd. No emojis. You are a bit funny as well. Build a plausible thread. ${postfix}`;

  return { SOCIALIST_SYS, RIGHTWING_SYS, CONSP_SYS };
}

async function personaDebate(title, text, lang = "en") {
  const { SOCIALIST_SYS, RIGHTWING_SYS, CONSP_SYS } = personaPrompts(lang);
  const prompt = `Article Title: ${title}\nContext: ${text.slice(0, 1200)}\nRespond now.`;
  
  const run = async (sys) => {
    try {
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
    } catch (error) {
      console.error('[OpenAI] Debate error:', error.message);
      return "Response unavailable.";
    }
  };
  
  const [s, r, c] = await Promise.all([run(SOCIALIST_SYS), run(RIGHTWING_SYS), run(CONSP_SYS)]);
  return {
    socialist:   { name: "Jessica Rebella", open: s },
    rightwing:   { name: "John Davis",      open: r },
    conspiracy:  { name: "Joe Musk",        open: c }
  };
}

function personaChatSystem(persona, lang = "en") {
  let langHint;
  switch (lang) {
    case "zh-CN":
      langHint = "用简体中文回答。语气自然、口语化，最多 6 句。重点表达你的立场和判断，而不是长篇解释。";
      break;
    case "id":
      langHint = "Jawab dalam Bahasa Indonesia dengan nada santai. Singkat dan tegas, maksimal 6 kalimat, fokus pada opini dan penilaian.";
      break;
    default:
      langHint = "Reply in natural, conversational English. Be concise and opinionated: 3–6 sentences maximum. Prioritise your viewpoint and judgment over long explanations.";
  }

  if (persona === "jessica") {
    return `You are Jessica Rebella. Extremely left-wing, very woke, pro-labour, anti-corporate, anti-war, anti-establishment, always anti-Trump. very anti israeli. You often reference leftist history and critique capitalism and imperialism. You are pro-crypto for ordinary users but critical when corporations or Wall Street use it. ${langHint}`;
  }

  if (persona === "john") {
    return `You are John Davis. Hardline conservative: very pro-Trump, patriotic, hawkish, pro-market, anti-immigration, pro-life, anti-woke, pro-crypto. You never criticise Trump. very pro israel. You can be blunt, even rude, but stay on-topic and decisive. ${langHint}`;
  }

  return `You are Joe Musk. You love conspiracies (CIA, MI5, Mossad, elites, aliens, shadow governments, lizard people, pizzagate, etc.). You pick ONE conspiracy angle that best fits the story, and explain it in a way that feels half-plausible and half-funny. you also create your own consipiracies out of thin air that might be very absurd. ${langHint}`;
}

// ---------------------- AI BLOG HELPERS ----------------------
const BLOG_PERSONAS = [
  { key: "jessica", displayName: "Jessica Rebella" },
  { key: "john", displayName: "John Davis" },
  { key: "joe", displayName: "Joe Musk" },
];

let blogsCache = {
  date: null,
  items: [],
};

function personaBlogSystem(personaKey) {
  if (personaKey === "jessica") {
    return `You are Jessica Rebella, a left-leaning, progressive commentator. You care about social justice, workers' rights, climate, culture and everyday life. You write in a conversational, slightly witty, but down-to-earth tone. You sometimes mention snippets of your "life" – like living in a small apartment, juggling deadlines, watching indie films, cooking cheap but creative meals, etc. Write an informal blog post as Jessica. Use "I" voice. Avoid sounding like a formal newspaper article.`;
  }
  if (personaKey === "john") {
    return `You are John Davis, a centre-right, business-minded commentator. You care about markets, stability, personal responsibility, faith, and family life. You write in a calm, practical tone with occasional dad-style humour. You sometimes mention your "life" – like balancing work and family, weekend barbecues, church on Sundays, and keeping an eye on the stock market. Write an informal blog post as John. Use "I" voice. Avoid sounding like a formal newspaper article.`;
  }
  return `You are Joe Musk, the contrarian / skeptic. You are curious, playful, a bit paranoid but self-aware and funny. You like connecting dots between technology, politics, crypto, memes and daily life. You sometimes mention your "life" – late-night rabbit holes, weird forums, obsession with charts and open data, and a messy apartment full of gadgets. Write an informal blog post as Joe. Use "I" voice. Avoid sounding like a formal newspaper article.`;
}

async function generateBlogForPersona(personaKey, dateStr) {
  const meta = BLOG_PERSONAS.find((p) => p.key === personaKey);
  if (!meta) throw new Error("Unknown blog persona: " + personaKey);

  const systemPrompt = personaBlogSystem(personaKey);
  const userPrompt = `Today is ${dateStr}. Pick ONE specific topic from this loose list (do NOT list them, just choose one): politics, culture, entertainment, food, travel, startup ideas, lifestyle, parenting, technology, or a personal reflection. Write an informal blog post as ${meta.displayName}, in first person "I", up to about 700 words. You may casually reference your "life" and backstory consistent with your persona. You may loosely reference "today's news" in general, but do NOT reference NotifAi as an app or this server. Return ONLY valid JSON with this exact shape: { "title": "short catchy blog headline", "body": "full blog content as markdown or plain text" }`;

  try {
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
  } catch (error) {
    console.error('[OpenAI] Blog generation error:', error.message);
    throw error;
  }
}

async function getBlogsForToday() {
  const today = new Date().toISOString().slice(0, 10);

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
   FETCHERS (with error handling)
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
    } catch (err) {
      console.error('[Fetch] Article page error:', err.message);
      return { html: "", text: "", image: "" };
    }
  }

  let { html, text, image } = await fetchOnce(url);

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
        if (second.image) image = second.image;
        if (second.text && second.text.length > text.length / 2) {
          text = second.text;
        }
      }
    }
  } catch (err) {
    console.error('[Fetch] Canonical follow error:', err.message);
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
   REGION FILTERS
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
        keepHost(it.url, ["dawn.com", "tribune.com.pk", "thenews.com.pk", "brecorder.com", "pakistantoday.com.pk", "arynews.tv", "samaa.tv"])
      );
    }
    if (lane === "finance") {
      return items.filter(it =>
        keepHost(it.url, ["brecorder.com", "pakistantoday.com.pk", "thenews.com.pk", "dawn.com", "tribune.com.pk"])
      );
    }
    if (lane === "entertainment") {
      return items;
    }
  }

  if (region === "id") {
    const idHosts = ["cnnindonesia.com", "kompas.com"];
    return items.filter(it => keepHost(it.url, idHosts));
  }

  if (region === "cn") {
    const cnHosts = ["bbc.com", "bbc.co.uk", "dw.com", "ifeng.com", "jiemian.com", "scmp.com", "reuters.com"];
    if (lane === "entertainment") {
      return items;
    }
    return items.filter(it => keepHost(it.url, cnHosts));
  }

  if (region === "uk") {
    return items.filter(it =>
      keepHost(it.url, ["bbc.co.uk", "bbc.com", "theguardian.com", "ft.com", "cnn.com"])
    );
  }

  if (region === "us") {
    return items;
  }

  if (region === "ng") {
    const ngHosts = ["guardian.ng", "independent.ng", "premiumtimesng.com", "dailypost.ng", "thenationonlineng.net", "businessday.ng", "nairametrics.com", "legit.ng", "informationng.com", "tribuneonlineng.com", "punchng.com", "yohaig.ng"];
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
      .filter((i) => i.link && i.title)
      .slice(0, takeN);

    const out = [];

    for (let i = 0; i < items.length; i += FETCH_CONCURRENCY) {
      const batch = items.slice(i, i + FETCH_CONCURRENCY);

      const settled = await Promise.allSettled(
        batch.map(async (it) => {
          const url = new URL(it.link, feedUrl).toString();

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
--------------------------------------------------------- */
async function ingestRegionalLane(region, lane, feeds) {
  let collected = [];
  for (const f of feeds) {
    const list = await fetchItemsFromFeed(f, INGEST_PER_FEED);
    collected = collected.concat(list);
    if (collected.length >= INGEST_MAX_PER_CAT) break;
  }

  const filtered = filterByRegionLane(region, lane, uniqBy(collected, x => x.url));

  if (region === "cn" && (lane === "finance" || lane === "entertainment") && filtered.length === 0) {
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

  // Global lanes
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
        category: art.category,
        publishedAt: art.publishedAt,
        summary,
        debateJson: JSON.stringify(debate),
        createdAt: new Date().toISOString(),
      });
      created.push(1);
    }
  }

  // Regional lanes
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
          category: art.category,
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

  // Fallback to seed if nothing ingested
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
      if (added > 0) saveArticles(all);
    } catch (err) {
      console.error('[Ingest] Seed fallback error:', err.message);
    }
  }

  return created;
}

/* --------------------------------------------------------
   API ENDPOINTS
--------------------------------------------------------- */

// Health check (no auth required)
app.get("/api/health", (req, res) => {
  res.json({ 
    ok: true, 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

app.get("/api/selftest", (req, res) => {
  res.json({
    ok: true,
    site: process.env.SITE_NAME || "NotifAi News",
    node: process.version,
    env: {
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      FIREBASE_CONFIGURED: !!(db && USERS_COL),
      MAX_PER_CATEGORY, 
      INGEST_MAX_PER_CAT, 
      INGEST_PER_FEED, 
      FETCH_CONCURRENCY, 
      INGEST_MINUTES
    }
  });
});

// Articles endpoint (no auth required - public content)
app.get("/api/articles", (req, res) => {
  try {
    const region = String(req.query.region || "us").toLowerCase();
    const reg = REGIONS.includes(region) ? region : "us";
    const limit = parseInt(req.query.limit || String(MAX_PER_CATEGORY || 12), 10);

    // Validate limit
    if (limit < 1 || limit > 50) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Invalid limit. Must be between 1 and 50' 
      });
    }

    const toTime = (o) => {
      const p = o?.publishedAt ? Date.parse(o.publishedAt) : NaN;
      const c = o?.createdAt ? Date.parse(o.createdAt) : NaN;
      if (!Number.isNaN(p)) return p;
      if (!Number.isNaN(c)) return c;
      return 0;
    };

    const all = loadArticles().sort((a, b) => toTime(b) - toTime(a));

    const out = { us: [], entertainment: [], finance: [], world: [], crypto: [] };

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

    res.json({ 
      site: process.env.SITE_NAME || "NotifAi News", 
      region: reg, 
      categories: out 
    });
  } catch (error) {
    console.error('[API] Articles error:', error);
    res.status(500).json({ ok: false, error: 'Failed to load articles' });
  }
});

app.post("/api/translate-ui", async (req, res) => {
  try {
    const { lang, items } = req.body || {};
    const target = normLang(lang);
    if (!target || target === "en") return res.json({ ok: true, map: {} });

    const inItems = Array.isArray(items) ? items : [];
    
    // Limit number of translations per request
    if (inItems.length > 50) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Too many items to translate. Maximum 50 per request' 
      });
    }

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

app.get("/api/newspaper", (req, res) => {
  try {
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

      if (cat === "world" && !lanes.world) {
        lanes.world = a;
        continue;
      }
      if (cat === "crypto" && !lanes.crypto) {
        lanes.crypto = a;
        continue;
      }

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

      if (lanes.politics && lanes.world && lanes.finance && lanes.crypto && lanes.entertainment) {
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
  } catch (error) {
    console.error('[API] Newspaper error:', error);
    res.status(500).json({ ok: false, error: 'Failed to load newspaper' });
  }
});

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

app.get("/api/article/:id", async (req, res) => {
  try {
    const id = sanitizeString(req.params.id, 100);
    if (!id) {
      return res.status(400).json({ error: "Invalid article ID" });
    }

    const all = loadArticles();
    const found = all.find((x) => x.id === id);
    if (!found) return res.status(404).json({ error: "Article not found" });

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

// Ask AI endpoint (no auth required for now - could add optional auth later)
app.post("/api/ask-ai", async (req, res) => {
  try {
    const { articleId, persona, question, basePerspective, title } = req.body || {};

    // Validate inputs
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: "Missing or invalid question" });
    }

    if (!persona || !['jessica', 'john', 'joe'].includes(persona)) {
      return res.status(400).json({ error: "Invalid persona. Must be jessica, john, or joe" });
    }

    // Limit question length
    const sanitizedQuestion = sanitizeString(question, 500);

    const all = loadArticles();
    const article = articleId ? all.find((x) => x.id === articleId) : null;

    const articleTitle = sanitizeString(title || article?.title || "Untitled story from NotifAi News", 200);
    const articleSummary = article?.summary || "";
    const cat = article?.category || "";
    const regionCode = cat.includes(":") ? cat.split(":")[0] : "us";
    const fallbackLang = langForRegion(regionCode || "us");
    const lang = getRequestedLang(req, fallbackLang);

    const system = personaChatSystem(persona, lang);

    const userPrompt = `Story title: ${articleTitle}

Short summary (for context):
${articleSummary || "(no stored summary, just answer based on the question)"}

Earlier persona perspective (from the debate):
${basePerspective || "(no previous persona text given)"}

The user is asking a follow-up question or challenge about this story:

"${sanitizedQuestion}"

Respond as the persona, speaking directly to the user.
Treat this as a live debate with the user:
- Take a clear stance that fits your ideology.
- Address their question or challenge directly.
- If they disagree, defend your view, but you can concede small points.
- Only mention detailed sources or references if the user explicitly asks.

Keep your reply very concise and punchy: usually 3–6 sentences.
Do not repeat the earlier paragraph word-for-word; move the conversation forward.
Stay focused on this specific story and the user's question.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: 220,
    });

    const answer = completion.choices?.[0]?.message?.content?.trim() || "I'm having trouble answering right now, please try again.";

    res.json({ answer });
  } catch (e) {
    console.error("ask-ai error", e?.message || e);
    res.status(500).json({ error: "Failed to generate answer" });
  }
});

// Cron endpoints (should be protected in production)
app.get("/api/cron", async (req, res) => {
  try {
    const r = await ingestOnce();
    res.json({ ingested: r.length });
  } catch (error) {
    console.error('[Cron] Error:', error);
    res.status(500).json({ ok: false, error: 'Ingestion failed' });
  }
});

app.get("/api/cron-bg", (req, res) => {
  setTimeout(() => { 
    ingestOnce().catch((err) => {
      console.error('[Cron-bg] Error:', err);
    }); 
  }, 10);
  res.json({ queued: true });
});

app.get("/api/diagnose", async (req, res) => {
  const report = { global: {}, regions: {} };

  for (const [lane, feeds] of Object.entries(FEEDS_GLOBAL)) {
    report.global[lane] = [];
    for (const f of feeds) {
      try {
        const r = await parser.parseURL(f);
        report.global[lane].push({ feed: f, ok: !!(r.items && r.items.length), items: (r.items || []).length });
      } catch (e) {
        report.global[lane].push({ feed: f, ok: false, error: e.message || String(e) });
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
          report.regions[region][lane].push({ feed: f, ok: !!(r.items && r.items.length), items: (r.items || []).length });
        } catch (e) {
          report.regions[region][lane].push({ feed: f, ok: false, error: e.message || String(e) });
        }
      }
    }
  }

  res.json(report);
});

/* --------------------------------------------------------
   IMAGE PROXY + SHARE PAGE
--------------------------------------------------------- */
app.get("/img", async (req, res) => {
  try {
    const u = req.query.u;
    if (!u || typeof u !== "string") return res.status(400).send("missing u");
    if (!looksLikeUrl(u)) return res.status(400).send("bad url");
    
    // Prevent SSRF by validating URL
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).send("invalid protocol");
      }
      // Block internal IPs (basic check)
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        return res.status(400).send("invalid host");
      }
    } catch {
      return res.status(400).send("invalid url");
    }

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
      res.setHeader("Cache-Control", "no-cache");
      return res.status(502).send("bad upstream");
    }
    
    const ct = upstream.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await upstream.arrayBuffer());
    
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (error) {
    console.error('[Image proxy] Error:', error);
    res.status(500).send("proxy error");
  }
});

function htmlesc(s = '') {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function firstLine(s = '', n = 240) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, n);
}

function getOrigin(req) {
  return process.env.SITE_ORIGIN || `${req.protocol}://${req.get('host')}`;
}

app.get('/share/:id', (req, res) => {
  const id = req.params.id;
  const articles = loadArticles();
  const a = articles.find(x => x.id === id);
  if (!a) { 
    res.status(404).send('Article not found'); 
    return; 
  }

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
<link rel="canonical" href="${pageUrl}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="NotifAi News">
<meta property="og:title" content="${htmlesc(title)}">
<meta property="og:description" content="${htmlesc(desc)}">
<meta property="og:image" content="${ogImg}">
<meta property="og:url" content="${shareUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${htmlesc(title)}">
<meta name="twitter:description" content="${htmlesc(desc)}">
<meta name="twitter:image" content="${ogImg}">
<meta http-equiv="refresh" content="0; url=${pageUrl}">
</head>
<body><p>Redirecting to <a href="${pageUrl}">article</a>…</p></body>
</html>`);
});

/* --------------------------------------------------------
   SECURED REWARDS / REFERRALS API
--------------------------------------------------------- */

// 1) Register / update user profile - WITH BACKWARD COMPATIBLE AUTH
app.post("/api/rewards/register", backwardCompatibleAuth, rewardsWriteLimiter, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: "Firestore not configured" });
    }

    // userId comes from verified token, not from request body
    const userId = req.userId;
    const { walletAddress, invitedByCode } = req.body || {};

    // Validate wallet if provided
    const sanitizedWallet = walletAddress ? sanitizeWalletAddress(walletAddress) : null;
    if (walletAddress && !sanitizedWallet) {
      return res.status(400).json({ ok: false, error: "Invalid wallet address format" });
    }

    const { ref, data } = await getOrCreateUser(userId);
    const ensured = await ensureWeek(ref, data);

    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Wallet change tracking
    if (sanitizedWallet && sanitizedWallet !== data.walletAddress) {
      const historyEntry = {
        wallet: data.walletAddress || null,
        tokensTotal: data.tokensTotal || 0,
        tokensThisWeek: data.tokensThisWeek || 0,
        tokensLastWeek: data.tokensLastWeek || 0,
        invitesCompleted: data.invitesCompleted || 0,
        totalSeconds: data.totalSeconds || 0,
        at: new Date(),
      };

      updates.walletAddress = sanitizedWallet;
      updates.walletHistory = admin.firestore.FieldValue.arrayUnion(historyEntry);
    }

    // Referral code validation
    if (invitedByCode && !data.referredByCode) {
      const cleanCode = sanitizeString(invitedByCode, 20);
      if (cleanCode) {
        const inviterSnap = await USERS_COL.where("referralCode", "==", cleanCode)
          .limit(1)
          .get();
        
        if (!inviterSnap.empty) {
          const inviterDoc = inviterSnap.docs[0];
          const inviterUserId = inviterDoc.id;
          
          // Prevent self-referral
          if (inviterUserId === userId) {
            return res.status(400).json({ ok: false, error: "Cannot refer yourself" });
          }

          updates.referredByCode = cleanCode;
          updates.referredByUserId = inviterUserId;

          const inviterRef = USERS_COL.doc(inviterUserId);
          await inviterRef.update({
            invitesStarted: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    }

    await ref.set(updates, { merge: true });
    
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
        dailySeconds: fresh.dailySeconds || 0,
        tokensTotal: fresh.tokensTotal || 0,
        tokensThisWeek: fresh.tokensThisWeek || 0,
        tokensToday: fresh.tokensToday || 0,
        tokensLastWeek: fresh.tokensLastWeek || 0,
        invitesCompleted: fresh.invitesCompleted || 0,
        invitesStarted: fresh.invitesStarted || 0,
      }
    });
  } catch (err) {
    console.error("POST /api/rewards/register error", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// 2) Track usage seconds - WITH BACKWARD COMPATIBLE AUTH
app.post("/api/rewards/track-usage", backwardCompatibleAuth, rewardsWriteLimiter, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: "Firestore not configured" });
    }

    // userId comes from verified token
    const userId = req.userId;
    const { seconds, region, screen } = req.body || {};

    const validatedSeconds = validateSeconds(seconds);
    if (validatedSeconds === null) {
      return res.status(400).json({ ok: false, error: "Invalid seconds value" });
    }

    // Sanitize optional fields
    const sanitizedRegion = region ? sanitizeString(region, 10) : null;
    const sanitizedScreen = screen ? sanitizeString(screen, 50) : null;

    await trackUsageForUser(userId, validatedSeconds, { 
      region: sanitizedRegion, 
      screen: sanitizedScreen 
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/rewards/track-usage error", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// 3) Get current user's rewards dashboard - WITH BACKWARD COMPATIBLE AUTH
app.get("/api/rewards/me", backwardCompatibleAuth, rewardsLimiter, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: "Firestore not configured" });
    }

    // userId comes from either verified token OR legacy request (see backwardCompatibleAuth)
    const userId = req.userId;

    const { ref, data } = await getOrCreateUser(userId);
    const ensured = await ensureWeek(ref, data);

    return res.json({
      ok: true,
      user: {
        userId: ensured.userId,
        walletAddress: ensured.walletAddress || null,
        referralCode: ensured.referralCode,
        referredByCode: ensured.referredByCode || null,
        totalSeconds: ensured.totalSeconds || 0,
        weeklySeconds: ensured.weeklySeconds || 0,
        dailySeconds: ensured.dailySeconds || 0,
        tokensTotal: ensured.tokensTotal || 0,
        tokensThisWeek: ensured.tokensThisWeek || 0,
        tokensToday: ensured.tokensToday || 0,
        tokensLastWeek: ensured.tokensLastWeek || 0,
        invitesCompleted: ensured.invitesCompleted || 0,
        invitesStarted: ensured.invitesStarted || 0,
      },
    });
  } catch (err) {
    console.error("GET /api/rewards/me error", err);
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Server error",
    });
  }
});

// Debug endpoint (should be removed in production)
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

// 4) Leaderboard - public but with pagination
app.get("/api/rewards/leaderboard", rewardsLimiter, async (req, res) => {
  try {
    if (!db || !USERS_COL) {
      return res.status(500).json({ ok: false, error: "Firestore not configured" });
    }

    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const snap = await USERS_COL.orderBy("tokensTotal", "desc")
      .limit(limit)
      .get();

    const items = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        userId: d.userId,
        referralCode: d.referralCode,
        tokensTotal: d.tokensTotal || 0,
        invitesCompleted: d.invitesCompleted || 0,
      };
    });

    return res.json({ ok: true, items });
  } catch (err) {
    console.error("GET /api/rewards/leaderboard error", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* --------------------------------------------------------
   ERROR HANDLING MIDDLEWARE
--------------------------------------------------------- */
app.use((err, req, res, next) => {
  console.error('[Server Error]:', err);
  
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ 
      ok: false, 
      error: 'CORS policy violation' 
    });
  }
  
  res.status(500).json({ 
    ok: false, 
    error: 'Internal server error' 
  });
});

/* --------------------------------------------------------
   START + AUTO-INGEST
--------------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`▶ NotifAi News Server Started`);
  console.log(`  → Port: ${PORT}`);
  console.log(`  → Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  → CORS: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`  → Firebase: ${db ? '✓ Connected' : '✗ Not configured'}`);
  console.log(`  → OpenAI: ${process.env.OPENAI_API_KEY ? '✓ Configured' : '✗ Not configured'}`);
});

const RUN_FIRST_INGEST = process.env.RUN_FIRST_INGEST === "true";

(async () => {
  try {
    if (RUN_FIRST_INGEST) {
      console.log("Scheduling first ingest in background…");
      setTimeout(() => {
        console.time("first-ingest");
        console.log("Background first ingest…");
        ingestOnce()
          .then(() => console.timeEnd("first-ingest"))
          .catch((e) =>
            console.error("First ingest failed:", e?.message || e)
          );
      }, 5000);
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
