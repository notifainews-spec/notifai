/* =========================================================
   NotifAi News - Main App (Homepage)
   Mobile global swipe to change categories
   ========================================================= */

const API_BASE = window.API_BASE || location.origin;
let ARTICLES = {};
let currentCat = "us";

const grid = document.querySelector("#grid");
const hero = document.querySelector("#hero");
const catButtons = document.querySelectorAll(".main-nav .nav-btn");
const refreshBtn = document.getElementById("refreshBtn");
const catBar = document.getElementById("catBar"); // optional, still used for visual active state

// ---------------- Renderers ----------------
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
      // Center the active in view (nice on mobile)
      try { active.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); } catch {}
    }
    await renderCategory(currentCat);
  }catch(e){
    console.error("Error loading articles:", e);
    grid.innerHTML = `<div class="empty">Failed to fetch articles.</div>`;
  }
}

// ---------------- Category Tab Clicks ----------------
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

// ---------------- Manual Refresh ----------------
if (refreshBtn){
  refreshBtn.addEventListener("click", async () => {
    try{
      const r = await fetch(`${API_BASE}/api/cron`, { cache:"no-store" });
      console.log("Cron:", await r.json());
    }catch(e){ console.warn("Cron failed:", e); }
    loadArticles();
  });
}

// ---------------- Footer year ----------------
const yr = document.getElementById("year");
if (yr) yr.textContent = new Date().getFullYear();

// ---------------- Init ----------------
loadArticles();

/* =========================================================
   Global Mobile Swipe: change category anywhere on screen
   - Only active on homepage (this file)
   - Only on mobile (<= 720px)
   - Respects vertical scroll (angle & threshold)
   ========================================================= */
(function enableGlobalSwipe(){
  const mq = window.matchMedia("(max-width: 720px)");
  if (!mq.matches) return; // mobile only

  let startX = 0, startY = 0, moved = false, tracking = false;
  let startTime = 0;

  // Helpers
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
    try { nextBtn.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); } catch {}
    renderCategory(currentCat);
  }

  function onDown(e){
    // Only start tracking for primary touch/pointer
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    startX = t.clientX; startY = t.clientY;
    moved = false; tracking = true;
    startTime = Date.now();
  }

  function onMove(e){
    if (!tracking) return;
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    // If vertical dominates, let scroll happen; do not block
    if (Math.abs(dy) > Math.abs(dx)) return;

    // If clearly horizontal, prevent browser gestures/clicks during swipe
    if (Math.abs(dx) > 10) {
      moved = true;
      // prevent accidental taps while swiping
      if (e.cancelable) e.preventDefault();
    }
  }

  function onUp(e){
    if (!tracking) return;
    tracking = false;

    const t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
    if (!t) return;

    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    // Respect vertical scroll
    if (Math.abs(dy) > Math.abs(dx)) return;

    const elapsed = Date.now() - startTime;
    const THRESH = 70; // px threshold
    const FAST = 300;  // if quick, allow a bit less movement (fling)
    const effThresh = elapsed < FAST ? 50 : THRESH;

    if (dx <= -effThresh){
      // swipe left → next category
      setActiveByIndex(getIndex() + 1);
    } else if (dx >= effThresh){
      // swipe right → previous category
      setActiveByIndex(getIndex() - 1);
    }
  }

  // Attach to the whole page so swipe works anywhere
  // Use passive listeners where we don't call preventDefault
  document.addEventListener("touchstart", onDown, { passive: true });
  document.addEventListener("touchmove",  onMove, { passive: false });
  document.addEventListener("touchend",   onUp,   { passive: true });

  document.addEventListener("pointerdown", onDown, { passive: true });
  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup",   onUp,   { passive: true });

  // Re-evaluate if viewport changes (rotation)
  window.addEventListener("resize", () => {
    if (!window.matchMedia("(max-width: 720px)").matches) {
      // If switching to desktop width, you could remove listeners if desired.
      // Kept simple here—desktop won't reach thresholds often due to mouse.
    }
  });
})();
