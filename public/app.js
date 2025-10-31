/* =========================================================
   NotifAi News - Main App (Homepage)
   Polished UI + translation hooks (no server changes)
   ========================================================= */

const API_BASE = window.API_BASE || location.origin;
let ARTICLES = {};
let currentCat = "us";

// Language helpers (match server /api/translate)
const LANG_KEY = "notifai_lang";
const SUPPORTED_LANGS = ["en","zh","ar","fr","hi","de"];
const currentLang = () => localStorage.getItem(LANG_KEY) || "en";
const setLang = (l) => localStorage.setItem(LANG_KEY, l);

// DOM
const grid = document.querySelector("#grid");
const catButtons = document.querySelectorAll(".nav-btn, .category");
const refreshBtn = document.getElementById("refreshBtn");

// Translate batch via server
async function translateBatch(target, items){
  try{
    if (target === "en") return items;
    if (!SUPPORTED_LANGS.includes(target)) return items;
    const res = await fetch(`${API_BASE}/api/translate`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ target, items })
    });
    if (!res.ok) return items;
    const j = await res.json();
    return Array.isArray(j.items) && j.items.length === items.length ? j.items : items;
  }catch{
    return items;
  }
}

// Render a category
async function renderCategory(cat) {
  if (!grid) return;

  const items =
    (ARTICLES?.[cat]) ||
    (ARTICLES?.categories?.[cat]) ||
    [];

  grid.innerHTML = "";

  if (!items || items.length === 0) {
    grid.innerHTML = `<div class="empty">No articles found.</div>`;
    return;
  }

  // Prepare translation: title + summary per item
  const lang = currentLang();
  let localized = items;
  try{
    const pack = [];
    for (const a of items){ pack.push(a.title||"", a.summary||""); }
    const translated = await translateBatch(lang, pack);
    if (translated.length === pack.length){
      let i=0;
      localized = items.map(a => ({
        ...a,
        title: translated[i++] || a.title || "",
        summary: translated[i++] || a.summary || ""
      }));
    }
  }catch{}

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

// Load all articles then render current category
async function loadArticles() {
  try{
    const res = await fetch(`${API_BASE}/api/articles`, { cache:"no-store" });
    const data = await res.json();
    ARTICLES = data?.categories || data || {};

    // Apply active state to tab
    const active = document.querySelector(`.nav-btn[data-cat="${currentCat}"], .category[data-cat="${currentCat}"]`);
    if (active){
      document.querySelectorAll(".nav-btn, .category").forEach(b => b.classList.remove("active"));
      active.classList.add("active");
    }

    await renderCategory(currentCat);
  }catch(e){
    console.error("Error loading articles:", e);
    if (grid) grid.innerHTML = `<div class="empty">Failed to fetch articles.</div>`;
  }
}

// Category buttons
catButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const cat = btn.dataset.cat;
    if (!cat || cat === currentCat) return;
    currentCat = cat;
    document.querySelectorAll(".nav-btn, .category").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderCategory(currentCat);
  });
});

// Manual refresh (triggers backend ingest, then reloads)
if (refreshBtn){
  refreshBtn.addEventListener("click", async () => {
    try{
      const r = await fetch(`${API_BASE}/api/cron`, { cache:"no-store" });
      console.log("Cron:", await r.json());
    }catch(e){ console.warn("Cron failed:", e); }
    loadArticles();
  });
}

// Footer year
(function(){
  const y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();
})();

// Init
loadArticles();
