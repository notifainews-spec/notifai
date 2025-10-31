/* =========================================================
   NotifAi News - Main App (Homepage)
   Polished UI (vanilla). No server changes needed.
   ========================================================= */

const API_BASE = window.API_BASE || location.origin;
let ARTICLES = {};
let currentCat = "us";

const grid = document.querySelector("#grid");
const hero = document.querySelector("#hero");
const catButtons = document.querySelectorAll(".main-nav .nav-btn");
const refreshBtn = document.getElementById("refreshBtn");

// Render hero (first item) and grid (rest)
function renderHero(item){
  if (!item){ hero.hidden = true; hero.innerHTML = ""; return; }
  const img = item.image ? `${API_BASE}/img?u=${encodeURIComponent(item.image)}` : "/cover.jpg";
  hero.hidden = false;
  hero.innerHTML = `
    <article class="hero-card hero-block">
      <a class="hero-media" href="article.html?id=${item.id}">
        <img src="${img}" alt="${item.title}">
        <div class="hero-overlay">
          <div class="hero-info">
            <div class="hero-kicker">${item.source || ""}</div>
            <h2 class="hero-title">${item.title}</h2>
            <div class="hero-actions">
              <a class="btn" href="article.html?id=${item.id}">Read summary</a>
              <a class="btn" href="${item.url}" target="_blank" rel="noopener">Full article</a>
            </div>
          </div>
        </div>
      </a>
    </article>
  `;
}

async function renderCategory(cat) {
  const items =
    (ARTICLES?.[cat]) ||
    (ARTICLES?.categories?.[cat]) ||
    [];

  grid.innerHTML = "";
  renderHero(null);

  if (!items || items.length === 0) {
    grid.innerHTML = `<div class="empty">No articles found.</div>`;
    return;
  }

  // Show first as hero, rest as cards
  renderHero(items[0]);
  const rest = items.slice(1);

  for (const a of rest) {
    const img = a.image ? `${API_BASE}/img?u=${encodeURIComponent(a.image)}` : "/cover.jpg";

    // Make the entire card clickable, accessible via keyboard
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = a.id;
    card.tabIndex = 0;               // focusable for keyboard users

    card.innerHTML = `
      <div class="thumb">
        <img src="${img}" alt="${a.title}" loading="lazy" decoding="async">
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

    // Click anywhere on the card → open article
    const go = () => { location.href = `article.html?id=${a.id}`; };
    card.addEventListener("click", go);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });

    // Prevent inner links from double-triggering the card click
    card.querySelectorAll("a").forEach(el => {
      el.addEventListener("click", (e) => e.stopPropagation());
    });

    grid.appendChild(card);
  }
} // ← IMPORTANT: this brace was missing

async function loadArticles() {
  try{
    const res = await fetch(`${API_BASE}/api/articles`, { cache:"no-store" });
    const data = await res.json();
    ARTICLES = data?.categories || data || {};

    // Update active tab
    const active = document.querySelector(`.nav-btn[data-cat="${currentCat}"]`);
    if (active){
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      active.classList.add("active");
    }
    await renderCategory(currentCat);
  }catch(e){
    console.error("Error loading articles:", e);
    grid.innerHTML = `<div class="empty">Failed to fetch articles.</div>`;
  }
}

// Category switching
catButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const cat = btn.dataset.cat;
    if (!cat || cat === currentCat) return;
    currentCat = cat;
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderCategory(currentCat);
  });
});

// Manual refresh (calls backend ingest, then reloads)
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
const y = document.getElementById("year");
if (y) y.textContent = new Date().getFullYear();

// Init
loadArticles();
