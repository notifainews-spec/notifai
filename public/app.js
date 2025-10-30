/* =========================================================
   NotifAi News - Main App (Homepage)
   - Normalizes /api/articles shape
   - Renders category cards
   - Client-side translation via /api/translate
   - Works with both .nav-btn and .category buttons
   ========================================================= */

const API_BASE = window.API_BASE || location.origin;
let ARTICLES = {};
let currentCat = "us";

// ------------------------------
// Language helpers
// ------------------------------
const LANG_KEY = "notifai_lang";
const DEFAULT_LANG = "en";
function currentLang(){ return localStorage.getItem(LANG_KEY) || DEFAULT_LANG; }
function setLang(l){ localStorage.setItem(LANG_KEY, l); }

// Target values expected by server /api/translate
const SUPPORTED_LANGS = ["en","zh","ar","fr","hi","de"];

// Batched translate via server API; pass-through for English
async function translateBatch(target, items){
  try{
    if (target === "en") return items;
    if (!Array.isArray(items) || !items.length) return items;
    if (!SUPPORTED_LANGS.includes(target)) return items;

    const res = await fetch(`${API_BASE}/api/translate`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ target, items })
    });
    if (!res.ok) return items;
    const j = await res.json();
    return Array.isArray(j.items) && j.items.length === items.length ? j.items : items;
  }catch(e){
    console.warn("translateBatch failed:", e);
    return items;
  }
}

// ------------------------------
// DOM elements
// ------------------------------
const grid = document.querySelector("#grid");
const catButtons = document.querySelectorAll(".nav-btn, .category");
const refreshBtn = document.getElementById("refreshBtn");

// ------------------------------
// RENDER: one category
// ------------------------------
async function renderCategory(cat) {
  if (!grid) return;

  // normalize structure (server returns { site, categories:{...} })
  const items =
    (ARTICLES?.[cat]) ||
    (ARTICLES?.categories?.[cat]) ||
    [];

  grid.innerHTML = "";

  if (!items || items.length === 0) {
    grid.innerHTML = `<div class="empty">No articles found.</div>`;
    return;
  }

  // Collect text we want translated (title + summary per item)
  const lang = currentLang();
  let localized = items;

  try {
    const pack = [];
    for (const a of items) {
      pack.push(a.title || "");
      pack.push(a.summary || "");
    }
    const translated = await translateBatch(lang, pack);
    // Map back to objects
    if (Array.isArray(translated) && translated.length === pack.length) {
      let i = 0;
      localized = items.map(a => ({
        ...a,
        title: translated[i++] || a.title || "",
        summary: translated[i++] || a.summary || ""
      }));
    }
  } catch(e) {
    console.warn("Translation step skipped:", e);
  }

  for (const a of localized) {
    const img = a.image ? `${API_BASE}/img?u=${encodeURIComponent(a.image)}` : "/cover.jpg";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="thumb">
        <img src="${img}" alt="${a.title}">
      </div>
      <div class="info">
        <h3>${a.title}</h3>
        <p class="summary">${a.summary || ""}</p>
        <div class="meta">
          <span>${a.source || ""}</span>
          <a href="article.html?id=${a.id}" class="read">Read more →</a>
        </div>
      </div>
    `;
    grid.appendChild(card);
  }
}

// ------------------------------
// FETCH + INITIAL RENDER
// ------------------------------
async function loadArticles() {
  try {
    const res = await fetch(`${API_BASE}/api/articles`, { cache: "no-store" });
    const data = await res.json();

    // Normalize to categories object regardless of backend shape
    ARTICLES = data?.categories || data || {};

    if (!ARTICLES || !Object.keys(ARTICLES).length) {
      if (grid) grid.innerHTML = `<div class="empty">Loading failed or no data.</div>`;
      return;
    }

    // Make sure the active tab is visually marked (nice UX)
    const active = document.querySelector(`.nav-btn[data-cat="${currentCat}"], .category[data-cat="${currentCat}"]`);
    if (active) {
      document.querySelectorAll(".nav-btn, .category").forEach(b => b.classList.remove("active"));
      active.classList.add("active");
    }

    await renderCategory(currentCat);
  } catch (e) {
    console.error("Error loading articles:", e);
    if (grid) grid.innerHTML = `<div class="empty">Failed to fetch articles.</div>`;
  }
}

// ------------------------------
// CATEGORY BUTTONS
// ------------------------------
catButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const cat = btn.dataset.cat;
    if (!cat || cat === currentCat) return;
    currentCat = cat;

    document.querySelectorAll(".nav-btn, .category").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    renderCategory(currentCat);
  });
});

// ------------------------------
// REFRESH (manual ingest trigger)
// ------------------------------
if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {
    try {
      const r = await fetch(`${API_BASE}/api/cron`, { cache: "no-store" });
      console.log("Cron:", await r.json());
    } catch(e) {
      console.warn("Cron failed:", e);
    }
    loadArticles();
  });
}

// ------------------------------
// LANGUAGE PICKERS (desktop + mobile)
// Expects <select id="langSelect"> and/or <select id="langSelectMobile">
// ------------------------------
(function initLanguagePickers(){
  const picks = [];
  const desktop = document.getElementById("langSelect");
  const mobile  = document.getElementById("langSelectMobile");
  if (desktop) picks.push(desktop);
  if (mobile)  picks.push(mobile);
  const lang = currentLang();
  picks.forEach(sel => { try{ sel.value = lang; }catch{} });

  picks.forEach(sel => {
    sel?.addEventListener("change", () => {
      const val = sel.value || "en";
      setLang(val);
      // Reload to re-fetch + re-render in chosen language
      location.reload();
    });
  });
})();

// ------------------------------
// FOOTER YEAR
// ------------------------------
(function setYear(){
  const y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();
})();

// ------------------------------
// INIT
// ------------------------------
loadArticles();
