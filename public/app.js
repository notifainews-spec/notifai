/* =========================================================
   NotifAi News - Main App (Homepage)
   Mobile Story Mode + global category swipe
   ========================================================= */

const API_BASE = window.API_BASE || location.origin;
let ARTICLES = {};
let currentCat = "us";

const grid = document.querySelector("#grid");
const hero = document.querySelector("#hero");
const storyMode = document.querySelector("#storyMode");
const catButtons = document.querySelectorAll(".main-nav .nav-btn");
const refreshBtn = document.getElementById("refreshBtn");

// ===== Story Mode state (mobile only) =====
let storyIndex = 0;
const isMobile = () => window.matchMedia("(max-width: 720px)").matches;

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

function currentList() {
  return (ARTICLES?.[currentCat]) || (ARTICLES?.categories?.[currentCat]) || [];
}

async function renderCategory(cat) {
  const items = (ARTICLES?.[cat]) || (ARTICLES?.categories?.[cat]) || [];

  // If on mobile and story mode is active, render using story view instead
  if (isMobile() && document.body.classList.contains("story-active")) {
    // Ensure index in range
    if (storyIndex >= items.length) storyIndex = Math.max(0, items.length - 1);
    renderStory(items, storyIndex, "reset");
    return;
  }

  // Grid/Hero mode (desktop or mobile fallback)
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
    // Make whole card clickable (not just image/text)
    card.addEventListener("click", (e) => {
      // avoid conflict if clicking a nested link explicitly
      const aEl = e.target.closest("a");
      if (aEl) return;
      location.href = `article.html?id=${a.id}`;
    });
    grid.appendChild(card);
  }
}

async function loadArticles() {
  try{
    const res = await fetch(`${API_BASE}/api/articles`, { cache:"no-store" });
    const data = await res.json();
    ARTICLES = data?.categories || data || {};

    // Set active tab class
    const active = document.querySelector(`.nav-btn[data-cat="${currentCat}"]`);
    if (active){
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      active.classList.add("active");
      try { active.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); } catch {}
    }

    // Auto-enable Story Mode on mobile
    if (isMobile()) {
      enableStoryMode();
    } else {
      disableStoryMode();
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
    storyIndex = 0;
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

// ---------------- Story Mode (mobile) ----------------
function enableStoryMode(){
  document.body.classList.add("story-active");
  storyMode.hidden = false;
}
function disableStoryMode(){
  document.body.classList.remove("story-active");
  storyMode.hidden = true;
}

function preload(src){
  if (!src) return;
  const i = new Image();
  i.src = `${API_BASE}/img?u=${encodeURIComponent(src)}`;
}

function storyHtml(a){
  const img = a.image ? `${API_BASE}/img?u=${encodeURIComponent(a.image)}` : "/cover.jpg";
  return `
    <article class="story-card" data-id="${a.id}">
      <div class="story-media">
        <img src="${img}" alt="${a.title}">
      </div>
      <div class="story-body">
        <div class="story-source">${a.source || ""}</div>
        <h2 class="story-title">${a.title}</h2>
        <div class="story-summary">${a.summary || ""}</div>
        <div class="story-actions">
          <a class="btn" href="article.html?id=${a.id}">Read summary</a>
          <a class="btn" href="${a.url}" target="_blank" rel="noopener">Full article</a>
        </div>
      </div>
    </article>
  `;
}

function renderStory(list, idx, direction="reset"){
  if (!isMobile()) return;
  if (!list || !list.length) {
    storyMode.innerHTML = `<div class="empty">No articles found.</div>`;
    return;
  }
  storyIndex = Math.max(0, Math.min(idx, list.length - 1));
  const a = list[storyIndex];

  // Preload neighbors
  if (list[storyIndex+1]?.image) preload(list[storyIndex+1].image);
  if (list[storyIndex-1]?.image) preload(list[storyIndex-1].image);

  // Animate
  const next = document.createElement("div");
  next.innerHTML = storyHtml(a);
  const nextNode = next.firstElementChild;

  const old = storyMode.firstElementChild;
  if (!old){
    storyMode.innerHTML = "";
    nextNode.classList.add("slide-in-up");
    storyMode.appendChild(nextNode);
    attachStoryTap(nextNode, a.id);
    return;
  }

  // choose classes
  let outClass = "slide-out-up", inClass = "slide-in-up";
  if (direction === "down") { outClass = "slide-out-down"; inClass = "slide-in-down"; }

  old.classList.add(outClass);
  nextNode.classList.add(inClass);
  storyMode.appendChild(nextNode);

  // after animation, remove old & bind click
  setTimeout(() => {
    try { old.remove(); } catch {}
    attachStoryTap(nextNode, a.id);
  }, 230);
}

function attachStoryTap(node, id){
  node.addEventListener("click", (e) => {
    // ignore clicks on explicit links/buttons (let them work)
    if (e.target.closest("a")) return;
    location.href = `article.html?id=${id}`;
  });
}

/* Vertical swipe only inside storyMode; Horizontal swipe remains global */
(function enableStorySwipe(){
  const mq = window.matchMedia("(max-width: 720px)");
  if (!mq.matches) return;

  let startX=0, startY=0, tracking=false, startTime=0;

  function onDown(e){
    if (!document.body.classList.contains("story-active")) return;
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    startX = t.clientX; startY = t.clientY;
    startTime = Date.now(); tracking = true;
  }
  function onMove(e){
    if (!tracking) return;
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    // Vertical swipe takes precedence here (we're inside the story zone)
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10 && e.cancelable){
      e.preventDefault(); // avoid body scroll jank
    }
  }
  function onUp(e){
    if (!tracking) return; tracking=false;
    const t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    // If horizontal dominates, let the global handler do categories
    if (Math.abs(dx) > Math.abs(dy)) return;

    // Vertical swipe threshold
    const elapsed = Date.now() - startTime;
    const THRESH = elapsed < 300 ? 50 : 80;

    const list = currentList();
    if (!list.length) return;

    if (dy <= -THRESH && storyIndex < list.length - 1){
      // swipe up → next story
      renderStory(list, storyIndex + 1, "up");
    } else if (dy >= THRESH && storyIndex > 0){
      // swipe down → previous story
      renderStory(list, storyIndex - 1, "down");
    }
  }

  // Bind only to the story container, so header/footer remain tappable
  storyMode.addEventListener("touchstart", onDown, { passive:true });
  storyMode.addEventListener("touchmove",  onMove,  { passive:false });
  storyMode.addEventListener("touchend",   onUp,    { passive:true });

  storyMode.addEventListener("pointerdown", onDown, { passive:true });
  storyMode.addEventListener("pointermove", onMove, { passive:false });
  storyMode.addEventListener("pointerup",   onUp,   { passive:true });
})();

/* =========================================================
   Global Mobile Swipe: left/right to change category
   (unchanged from your last working version)
   ========================================================= */
(function enableGlobalSwipe(){
  const mq = window.matchMedia("(max-width: 720px)");
  if (!mq.matches) return;

  let startX = 0, startY = 0, tracking = false, startTime = 0;

  const getButtons = () => Array.from(document.querySelectorAll(".main-nav .nav-btn"));
  const getIndex  = () => getButtons().findIndex(b => b.dataset.cat === currentCat);

  function setActiveByIndex(nextIndex){
    const btns = getButtons();
    if (nextIndex < 0 || nextIndex >= btns.length) return;
    const nextBtn = btns[nextIndex];
    const nextCat = nextBtn?.dataset?.cat;
    if (!nextCat || nextCat === currentCat) return;

    currentCat = nextCat;
    storyIndex = 0; // reset to first article in the new category
    btns.forEach(b => b.classList.remove("active"));
    nextBtn.classList.add("active");
    try { nextBtn.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); } catch {}
    renderCategory(currentCat);
  }

  function onDown(e){
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    startX = t.clientX; startY = t.clientY;
    startTime = Date.now(); tracking = true;
  }
  function onMove(e){
    if (!tracking) return;
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    // If vertical dominates, let story handler or page scroll manage it
    if (Math.abs(dy) > Math.abs(dx)) return;

    // If clearly horizontal, prevent accidental taps
    if (Math.abs(dx) > 10 && e.cancelable) e.preventDefault();
  }
  function onUp(e){
    if (!tracking) return; tracking=false;
    const t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
    if (!t) return;

    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dy) > Math.abs(dx)) return;

    const elapsed = Date.now() - startTime;
    const THRESH = elapsed < 300 ? 50 : 70;

    if (dx <= -THRESH){
      setActiveByIndex(getIndex() + 1); // next category
    } else if (dx >= THRESH){
      setActiveByIndex(getIndex() - 1); // prev category
    }
  }

  document.addEventListener("touchstart", onDown, { passive:true });
  document.addEventListener("touchmove",  onMove,  { passive:false });
  document.addEventListener("touchend",   onUp,    { passive:true });

  document.addEventListener("pointerdown", onDown, { passive:true });
  document.addEventListener("pointermove", onMove, { passive:false });
  document.addEventListener("pointerup",   onUp,   { passive:true });
})();

// ---------------- Init ----------------
loadArticles();

// Keep mode correct on rotation / resize
window.addEventListener("resize", () => {
  if (isMobile()) enableStoryMode(); else disableStoryMode();
  // Re-render current view in case sizes changed
  renderCategory(currentCat);
});
