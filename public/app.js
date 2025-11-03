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
const catBar = document.getElementById("catBar");

// Render hero (first item) and grid (rest)
function renderHero(item){
  if (!item){ hero.hidden = true; hero.innerHTML = ""; return; }
  const img = item.image ? `${API_BASE}/img?u=${encodeURIComponent(item.image)}` : "/cover.jpg";
  hero.hidden = false;
  hero.innerHTML = `
    <article class="hero-card">
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
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <a class="thumb" href="article.html?id=${a.id}">
        <img src="${img}" alt="${a.title}" loading="lazy" decoding="async">
      </a>
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

// Category switching (tap/click)
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
document.getElementById("year").textContent = new Date().getFullYear();

// Init
loadArticles();

/* =========================================================
   Mobile-only: swipe left/right on category bar
   ========================================================= */
(function enableMobileSwipe(){
  if (!catBar) return;
  const mq = window.matchMedia("(max-width: 720px)");
  let startX = 0, startY = 0, tracking = false, moved = false;

  const getButtons = () => Array.from(document.querySelectorAll(".main-nav .nav-btn"));
  const getIndex = () => getButtons().findIndex(b => b.dataset.cat === currentCat);

  function setActiveByIndex(nextIndex){
    const btns = getButtons();
    if (nextIndex < 0 || nextIndex >= btns.length) return;
    const nextBtn = btns[nextIndex];
    const nextCat = nextBtn?.dataset?.cat;
    if (!nextCat || nextCat === currentCat) return;

    currentCat = nextCat;
    btns.forEach(b => b.classList.remove("active"));
    nextBtn.classList.add("active");
    // center the active tab (nice touch)
    try { nextBtn.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); } catch {}
    renderCategory(currentCat);
  }

  function onDown(e){
    if (!mq.matches) return; // only mobile
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX; startY = t.clientY;
    tracking = true; moved = false;
  }

  function onMove(e){
    if (!tracking || !mq.matches) return;
    const t = e.touches ? e.touches[0] : e;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    // if vertical dominates, let page scroll
    if (Math.abs(dy) > Math.abs(dx)) return;
    // prevent horizontal scroll while swiping
    e.preventDefault();
    moved = true;
  }

  function onUp(e){
    if (!tracking || !mq.matches) return;
    tracking = false;
    if (!moved) return;

    const t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    // angle guard again
    if (Math.abs(dy) > Math.abs(dx)) return;

    const THRESH = 70; // px
    if (dx <= -THRESH){
      // swipe left -> next category
      setActiveByIndex(getIndex() + 1);
    } else if (dx >= THRESH){
      // swipe right -> previous category
      setActiveByIndex(getIndex() - 1);
    }
  }

  // Use passive:false so we can call preventDefault in onMove
  catBar.addEventListener("touchstart", onDown, { passive: true });
  catBar.addEventListener("touchmove",  onMove, { passive: false });
  catBar.addEventListener("touchend",   onUp,   { passive: true });

  // Also support pointer events (in case)
  catBar.addEventListener("pointerdown", onDown, { passive: true });
  catBar.addEventListener("pointermove", onMove, { passive: false });
  catBar.addEventListener("pointerup",   onUp,   { passive: true });
})();
