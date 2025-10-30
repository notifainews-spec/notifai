// app.js — NotifAi main homepage script
const API_BASE = window.API_BASE || location.origin;
const grid = document.getElementById("grid");
const cats = document.querySelectorAll(".category");
const refreshBtn = document.getElementById("refreshBtn");
let ARTICLES = {};
let currentCat = "us";

// i18n helpers
const LANG_KEY = "notifai_lang";
const DEFAULT_LANG = "en";

function currentLang(){ return localStorage.getItem(LANG_KEY) || DEFAULT_LANG; }
function setLang(l){ localStorage.setItem(LANG_KEY, l); }
function makeTransKey(id, lang, field){ return `tx_${lang}_${id}_${field}`; }

async function translateBatch(target, items){
  if (target === "en") return items;
  const base = (window.API_BASE || location.origin).replace(/\/+$/,'');
  const res = await fetch(`${base}/api/translate`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ target, items })
  });
  const j = await res.json();
  return Array.isArray(j.items) ? j.items : items;
}

function escapeHtml(str){
  if (!str) return "";
  return str.replace(/[&<>'"]/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"
  }[c]));
}

function toProxy(url){
  if (!url) return "/cover.jpg";
  if (url.startsWith("http")) return url;
  return `/proxy?u=${encodeURIComponent(url)}`;
}

// --- Render functions ---
function renderCategory(cat) {
  const items = ARTICLES?.[cat] || [];
  grid.innerHTML = "";

  if (!items.length) {
    grid.innerHTML = `<div class="empty">No stories yet. Try “Refresh”.</div>`;
    return;
  }

  const lang = currentLang();

  // Build translation list for any missing cached translations
  const toTx = [];
  const map = []; // [ [index, "t"|"s"] ]
  if (lang !== "en"){
    items.forEach((a, i)=>{
      const kt = makeTransKey(a.id, lang, "t");
      const ks = makeTransKey(a.id, lang, "s");
      if (!localStorage.getItem(kt)) { toTx.push(a.title);   map.push([i,"t"]); }
      if (a.summary && !localStorage.getItem(ks)) { toTx.push(a.summary); map.push([i,"s"]); }
    });
  }

  const renderNow = () => {
    for (const a of items) {
      const title = (lang === "en") ? a.title : (localStorage.getItem(makeTransKey(a.id, lang, "t")) || a.title);
      const summary = (lang === "en") ? a.summary : (localStorage.getItem(makeTransKey(a.id, lang, "s")) || a.summary);
      const img = toProxy(a.image);
      const date = a.publishedAt ? new Date(a.publishedAt) : null;
      const when = date ? date.toLocaleString() : "";

      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = `
        <a class="thumb" href="./article.html?id=${encodeURIComponent(a.id)}" title="${escapeHtml(title)}">
          <img loading="lazy" src="${img}" alt="" onerror="this.onerror=null;this.src='/cover.jpg';" />
        </a>
        <div class="meta">
          <a class="title" href="./article.html?id=${encodeURIComponent(a.id)}">${escapeHtml(title)}</a>
          <div class="byline">
            <span class="source">${escapeHtml(a.source || "")}</span>
            <span class="dot">•</span>
            <time>${escapeHtml(when)}</time>
          </div>
          <p class="summary">${escapeHtml(summary || "")}</p>
        </div>
      `;
      grid.appendChild(card);
    }
  };

  if (toTx.length === 0) {
    renderNow();
  } else {
    translateBatch(lang, toTx).then(list=>{
      list.forEach((txt, j)=>{
        const [i, which] = map[j];
        const key = makeTransKey(items[i].id, lang, which);
        localStorage.setItem(key, txt);
      });
      renderNow();
    }).catch(renderNow);
  }
}

// --- Load data ---
async function loadArticles() {
  try {
    const res = await fetch(`${API_BASE}/api/articles`, { cache: "no-store" });
    ARTICLES = await res.json();
    if (!ARTICLES || !Object.keys(ARTICLES).length) {
      grid.innerHTML = `<div class="empty">Loading failed or no data.</div>`;
      return;
    }
    renderCategory(currentCat);
  } catch (e) {
    console.error(e);
    grid.innerHTML = `<div class="empty">Failed to fetch articles.</div>`;
  }
}

// --- Category click handlers ---
cats.forEach(c=>{
  c.addEventListener("click",()=>{
    cats.forEach(x=>x.classList.remove("active"));
    c.classList.add("active");
    currentCat = c.dataset.cat;
    renderCategory(currentCat);
  });
});

// --- Refresh button ---
refreshBtn?.addEventListener("click", async()=>{
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Refreshing…";
  try {
    await fetch(`${API_BASE}/api/cron`);
    await loadArticles();
  } catch(e){
    console.error(e);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "↻ Refresh";
  }
});

// --- Language select wiring (desktop or mobile) ---
(function(){
  const sel = document.querySelector("#langSelect, #langSelectMobile");
  if (!sel) return;
  const saved = currentLang();
  sel.value = saved;

  // RTL for Arabic
  if (saved === "ar") document.documentElement.setAttribute("dir","rtl");
  else document.documentElement.removeAttribute("dir");

  sel.addEventListener("change", ()=>{
    setLang(sel.value);
    if (sel.value === "ar") document.documentElement.setAttribute("dir","rtl");
    else document.documentElement.removeAttribute("dir");
    // re-render current category using the new language
    renderCategory(currentCat);
  });
})();

// --- Initialize ---
loadArticles();
