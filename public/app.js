/* =========================================================
   NotifAi News - Main App (Homepage)
   Mobile Story Mode + smoother transitions + sticky footer spacing
========================================================= */

const API_BASE = window.API_BASE || location.origin;
let ARTICLES = {};
let currentCat = "us";

const grid = document.querySelector("#grid");
const hero = document.querySelector("#hero");
const storyMode = document.querySelector("#storyMode");
const catButtons = document.querySelectorAll(".main-nav .nav-btn");

// Floating next (injected once)
let storyNextBtn = null;

// Story Mode state
let storyIndex = 0;
const isMobile = () => window.matchMedia("(max-width: 720px)").matches;

/* ---------------- Utilities ---------------- */
function footerHeightPx(){
  const footer = document.querySelector(".site-footer");
  return footer ? footer.getBoundingClientRect().height : 0;
}
function vhMinusHeaderFooter(){
  const header = document.querySelector(".site-header");
  const h = header ? header.getBoundingClientRect().height : 0;
  const f = footerHeightPx();
  const vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
  // +8 for breathing room
  return Math.max(220, vh - h - f - 8);
}
function setStoryHeight(){
  if (!isMobile() || !storyMode) return;
  storyMode.style.height = `${vhMinusHeaderFooter()}px`;
}
function currentList() {
  return (ARTICLES?.[currentCat]) || (ARTICLES?.categories?.[currentCat]) || [];
}
function preload(src){
  if (!src) return;
  const i = new Image();
  i.decoding = "async";
  i.loading = "lazy";
  i.src = `${API_BASE}/img?u=${encodeURIComponent(src)}`;
}

/* ---------------- Renderers ---------------- */
function renderHero(item){
  if (!hero) return;
  if (!item){ hero.hidden = true; hero.innerHTML = ""; return; }
  const img = item.image ? `${API_BASE}/img?u=${encodeURIComponent(item.image)}` : "/cover.jpg";
  hero.hidden = false;
  hero.innerHTML = `
    <article class="hero-card">
      <a class="hero-media" href="article.html?id=${item.id}" aria-label="${item.title}">
        <img src="${img}" alt="${item.title}" loading="eager" decoding="async">
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
  const items = currentList();

  // Story Mode for mobile
  if (isMobile() && document.body.classList.contains("story-active")) {
    if (storyIndex >= items.length) storyIndex = Math.max(0, items.length - 1);
    renderStory(items, storyIndex, "reset");
    setStoryHeight();
    return;
  }

  // Grid/Hero mode
  if (grid) grid.innerHTML = "";
  renderHero(null);

  if (!items || items.length === 0) {
    if (grid) grid.innerHTML = `<div class="empty">No articles found.</div>`;
    return;
  }

  // Hero + rest
  renderHero(items[0]);
  const rest = items.slice(1);
  for (const a of rest) {
    const img = a.image ? `${API_BASE}/img?u=${encodeURIComponent(a.image)}` : "/cover.jpg";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <a class="thumb" href="article.html?id=${a.id}" aria-label="${a.title}">
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
    // Make whole card clickable
    card.addEventListener("click", (e) => {
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

    // set active tab
    const active = document.querySelector(`.nav-btn[data-cat="${currentCat}"]`);
    if (active){
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      active.classList.add("active");
      try { active.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); } catch {}
    }

    // Always Story Mode on mobile; desktop grid
    if (isMobile()) {
      enableStoryMode();
      setStoryHeight();

      const list = currentList();
      if (list.length && storyIndex < list.length - 1) {
        showStoryNextPillTemporarily(2800);
      } else if (storyNextBtn) {
        storyNextBtn.style.display = "none";
      }
    } else {
      disableStoryMode();
    }

    await renderCategory(currentCat);
    setStoryHeight();
  }catch(e){
    console.error("Error loading articles:", e);
    if (grid) grid.innerHTML = `<div class="empty">Failed to fetch articles.</div>`;
  }
}

/* ---------------- Category buttons (event delegation) ---------------- */
const catBarEl = document.getElementById("catBar");

function setAccentByCategory() {
  // Toggle a class on <html> so CSS can switch the accent color
  document.documentElement.classList.toggle("cn-accent", currentCat === "cn");
}

catBarEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn) return;

  const cat = btn.dataset.cat;
  if (!cat || cat === currentCat) return;

  currentCat = cat;
  storyIndex = 0;

  // Active state: ONLY the clicked button (so CN shows “active” when chosen)
  document.querySelectorAll(".nav-btn, .nav-sub-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");

  // Close dropdown (mobile) if open
  const sub = catBarEl.querySelector(".nav-dropdown .nav-sub");
  const mainBtn = catBarEl.querySelector('.nav-dropdown > .nav-btn');
  if (sub && sub.style.display === "block") {
    sub.style.display = "none";
    document.body.classList.remove("menu-open");
    mainBtn?.setAttribute("aria-expanded", "false");
  }

  setAccentByCategory();
  renderCategory(currentCat);
  setStoryHeight?.();
});

// --- US/CN dropdown: open on tap (mobile); desktop hover is CSS ---
(function(){
  const catBar  = document.getElementById("catBar");
  if (!catBar) return;

  const subWrap = catBar.querySelector(".nav-dropdown");
  const sub     = catBar.querySelector(".nav-dropdown .nav-sub");
  const mainBtn = catBar.querySelector('.nav-dropdown > .nav-btn');

  if (!subWrap || !sub || !mainBtn) return;

  let open = false;

  // Toggle on click of main US button (mobile). Desktop hover handled by CSS.
  mainBtn.addEventListener("click", (e) => {
    if (window.matchMedia("(hover:hover)").matches) return; // desktop: ignore
    e.preventDefault();
    open = !open;
    sub.style.display = open ? "block" : "none";
    document.body.classList.toggle("menu-open", open);
    mainBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  // Close when clicking outside (mobile)
  document.addEventListener("click", (e) => {
    if (!open) return;
    if (!subWrap.contains(e.target)) {
      open = false;
      sub.style.display = "none";
      document.body.classList.remove("menu-open");
      mainBtn.setAttribute("aria-expanded", "false");
    }
  });

  // When a submenu item (US or CN) is clicked, the handler above will run.
})();

/* ---------------- Manual Refresh ---------------- */
const refreshBtn = document.getElementById("refreshBtn");
if (refreshBtn){
  refreshBtn.addEventListener("click", async () => {
    try{
      const r = await fetch(`${API_BASE}/api/cron`, { cache:"no-store" });
      console.log("Cron:", await r.json());
    }catch(e){ console.warn("Cron failed:", e); }
    loadArticles();
  });
}

/* ---------------- Footer year ---------------- */
const yr = document.getElementById("year");
if (yr) yr.textContent = new Date().getFullYear();

/* ---------------- Story Mode (mobile) ---------------- */
function enableStoryMode(){
  if (!document.body.classList.contains("story-active")){
    document.body.classList.add("story-active");
  }
  if (storyMode) storyMode.hidden = false;
  ensureStoryNextPill();
  setStoryHeight();
}
function disableStoryMode(){
  document.body.classList.remove("story-active");
  if (storyMode) storyMode.hidden = true;
  if (storyNextBtn) storyNextBtn.style.display = "none";
}

function storyHtml(a){
  const img = a.image ? `${API_BASE}/img?u=${encodeURIComponent(a.image)}` : "/cover.jpg";
  return `
    <article class="story-card" data-id="${a.id}">
      <div class="story-media">
        <img src="${img}" alt="${a.title}" loading="eager" decoding="async">
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
    if (storyMode) storyMode.innerHTML = `<div class="empty">No articles found.</div>`;
    return;
  }
  storyIndex = Math.max(0, Math.min(idx, list.length - 1));
  const a = list[storyIndex];

  // Preload neighbors
  if (list[storyIndex+1]?.image) preload(list[storyIndex+1].image);
  if (list[storyIndex-1]?.image) preload(list[storyIndex-1].image);

  const wrap = document.createElement("div");
  wrap.innerHTML = storyHtml(a);
  const nextNode = wrap.firstElementChild;

  const old = storyMode.firstElementChild;
  if (!old){
    storyMode.innerHTML = "";
    nextNode.classList.add("slide-in-up");
    storyMode.appendChild(nextNode);
    attachStoryTap(nextNode, a.id);
    setStoryHeight();
    return;
  }

  let outClass = "slide-out-up", inClass = "slide-in-up";
  if (direction === "down") { outClass = "slide-out-down"; inClass = "slide-in-down"; }

  old.classList.add(outClass);
  nextNode.classList.add(inClass);
  storyMode.appendChild(nextNode);

  setTimeout(() => {
    try { old.remove(); } catch {}
    attachStoryTap(nextNode, a.id);
    setStoryHeight();

    const listNow = currentList();
    if (listNow.length && storyIndex < listNow.length - 1) {
      showStoryNextPillTemporarily(2800);
    } else if (storyNextBtn) {
      storyNextBtn.style.display = "none";
    }
  }, 230);
}

function attachStoryTap(node, id){
  node.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    location.href = `article.html?id=${id}`;
  });
}

/* ---- Floating "Next" pill ---- */
function ensureStoryNextPill(){
  if (storyNextBtn) return;
  storyNextBtn = document.createElement("button");
  storyNextBtn.id = "storyNext";
  storyNextBtn.innerHTML = `<span class="arrow"></span> <span>Swipe up / Next</span>`;
  storyNextBtn.type = "button";
  storyNextBtn.addEventListener("click", () => {
    const list = currentList();
    if (!list.length) return;
    if (storyIndex < list.length - 1) {
      renderStory(list, storyIndex + 1, "up");
      storyNextBtn.style.display = "none";
    } else {
      storyNextBtn.style.display = "none";
    }
  });
  document.body.appendChild(storyNextBtn);
}
function showStoryNextPillTemporarily(ms = 2800) {
  if (!storyNextBtn) return;
  storyNextBtn.style.display = "flex";
  clearTimeout(showStoryNextPillTemporarily._t);
  showStoryNextPillTemporarily._t = setTimeout(() => {
    if (storyNextBtn) storyNextBtn.style.display = "none";
  }, ms);
}

/* ---- Vertical swipe inside storyMode ---- */
(function Swipe(){
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
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10 && e.cancelable){
      e.preventDefault();
    }
  }
  function onUp(e){
    if (!tracking) return; tracking=false;
    const t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (Math.abs(dx) > Math.abs(dy)) return;

    const elapsed = Date.now() - startTime;
    const THRESH = elapsed < 300 ? 50 : 80;

    const list = currentList();
    if (!list.length) return;

    if (dy <= -THRESH && storyIndex < list.length - 1){
      renderStory(list, storyIndex + 1, "up");
    } else if (dy >= THRESH && storyIndex > 0){
      renderStory(list, storyIndex - 1, "down");
    }
  }

  if (storyMode){
    storyMode.addEventListener("touchstart", onDown, { passive:true });
    storyMode.addEventListener("touchmove",  onMove,  { passive:false });
    storyMode.addEventListener("touchend",   onUp,    { passive:true });

    storyMode.addEventListener("pointerdown", onDown, { passive:true });
    storyMode.addEventListener("pointermove", onMove, { passive:false });
    storyMode.addEventListener("pointerup",   onUp,   { passive:true });
  }
})();

/* =========================================================
   Global Mobile Swipe: left/right to change category
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
    storyIndex = 0;
    btns.forEach(b => b.classList.remove("active"));
    nextBtn.classList.add("active");
    try { nextBtn.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); } catch {}
    renderCategory(currentCat);
    setStoryHeight();
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
    if (Math.abs(dy) > Math.abs(dx)) return;
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
      setActiveByIndex(getIndex() + 1);
    } else if (dx >= THRESH){
      setActiveByIndex(getIndex() - 1);
    }
  }

  document.addEventListener("touchstart", onDown, { passive:true });
  document.addEventListener("touchmove",  onMove,  { passive:false });
  document.addEventListener("touchend",   onUp,    { passive:true });

  document.addEventListener("pointerdown", onDown, { passive:true });
  document.addEventListener("pointermove", onMove, { passive:false });
  document.addEventListener("pointerup",   onUp,   { passive:true });
})();

/* ---------------- Init + Resize ---------------- */
async function init(){
  await loadArticles();
  if (isMobile()) {
    ensureStoryNextPill();
    setStoryHeight();
  }
}
init();
setAccentByCategory();

function onViewportResize(){
  setStoryHeight();
}
if (window.visualViewport){
  window.visualViewport.addEventListener("resize", onViewportResize);
  window.visualViewport.addEventListener("scroll", onViewportResize);
}

window.addEventListener("resize", () => {
  if (isMobile()) {
    enableStoryMode();
    setStoryHeight();
  } else {
    disableStoryMode();
  }
  renderCategory(currentCat);
});
