/* NotifAi News – front-end controller (US/CN dropdown ready) */

const API_BASE = window.API_BASE || location.origin;

// Categories we know about (must match server groups)
const CATEGORY_KEYS = ["us", "cn", "world", "entertainment", "finance", "crypto"];

// State
let articlesByCat = {
  us: [], cn: [], world: [], entertainment: [], finance: [], crypto: []
};
let currentCat = "us";

// ===== Utilities
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d2 = Math.floor(h / 24);
  return `${d2}d ago`;
}

function imgProxy(u) {
  if (!u) return "./cover.jpg";
  // Server image proxy so hotlink-protected hosts work
  return `${API_BASE}/img?u=${encodeURIComponent(u)}`;
}

function shareUrl(id) {
  // Server-side OG page for rich previews
  return `${API_BASE}/share/${encodeURIComponent(id)}`;
}

// ===== Fetch + render
async function fetchArticles() {
  const res = await fetch(`${API_BASE}/api/articles`, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load articles");
  const json = await res.json();

  // Normalize to make sure missing keys exist
  for (const k of CATEGORY_KEYS) {
    articlesByCat[k] = (json.categories && json.categories[k]) || [];
  }

  // default to us if current category empty but cn exists
  if (!articlesByCat[currentCat] || articlesByCat[currentCat].length === 0) {
    const fallback = CATEGORY_KEYS.find(k => (articlesByCat[k] || []).length > 0);
    if (fallback) currentCat = fallback;
  }

  renderAll();
}

function setActiveCat(cat) {
  if (!CATEGORY_KEYS.includes(cat)) return;
  currentCat = cat;

  // Update active classes on top bar
  $$(".main-nav .nav-btn").forEach(b => b.classList.toggle("active", b.dataset.cat === cat));

  // If we switched via US dropdown, update its label to US or CN
  const usDropdownBtn = $('.nav-dropdown .nav-btn[data-cat="us"]');
  if (usDropdownBtn) {
    usDropdownBtn.textContent = (cat === "cn" ? "CN" : "US") + " ▾";
    usDropdownBtn.setAttribute("aria-expanded", "false");
  }
  closeMobileSub();
  renderAll();
}

function renderAll() {
  // Decide between story mode (mobile) vs hero+grid
  const isMobile = window.matchMedia("(max-width: 720px)").matches;
  // On your project, story mode is always enabled on mobile:
  document.body.classList.toggle("story-active", isMobile);

  if (isMobile) {
    renderStoryMode();
  } else {
    renderHeroAndGrid();
  }

  // Footer year
  const y = $("#year");
  if (y) y.textContent = String(new Date().getFullYear());
}

/* ---------- Desktop / Tablet: Hero + Grid ---------- */
function renderHeroAndGrid() {
  const list = articlesByCat[currentCat] || [];

  const hero = $("#hero");
  const grid = $("#grid");

  // Clear
  hero.innerHTML = "";
  grid.innerHTML = "";

  if (!list.length) {
    hero.hidden = true;
    grid.innerHTML = `<div class="empty">No articles yet for this category.</div>`;
    return;
  }

  // Top article (first)
  hero.hidden = false;
  const top = list[0];
  hero.innerHTML = `
    <a href="./article.html?id=${encodeURIComponent(top.id)}" class="hero-media" aria-label="${escapeHtml(top.title)}">
      <img src="${imgProxy(top.image)}" alt="${escapeHtml(top.title)}" />
      <div class="hero-overlay">
        <div class="hero-info">
          <div class="hero-kicker">${escapeHtml(top.source)} • ${timeAgo(top.publishedAt || top.createdAt)}</div>
          <h1 class="hero-title">${escapeHtml(top.title)}</h1>
          <div class="hero-actions">
            <a class="btn" href="./article.html?id=${encodeURIComponent(top.id)}">Read more</a>
          </div>
        </div>
      </div>
    </a>
  `;

  // Rest as cards
  const rest = list.slice(1);
  if (!rest.length) return;

  grid.innerHTML = rest.map(a => `
    <article class="card" data-id="${a.id}">
      <a href="./article.html?id=${encodeURIComponent(a.id)}" class="thumb" aria-label="${escapeHtml(a.title)}">
        <img src="${imgProxy(a.image)}" alt="${escapeHtml(a.title)}" />
      </a>
      <div class="info">
        <h3><a href="./article.html?id=${encodeURIComponent(a.id)}">${escapeHtml(a.title)}</a></h3>
        <p class="summary">${escapeHtml(a.summary || "")}</p>
        <div class="meta">
          <span>${escapeHtml(a.source)} • ${timeAgo(a.publishedAt || a.createdAt)}</span>
          <a class="read" href="./article.html?id=${encodeURIComponent(a.id)}">Read</a>
        </div>
      </div>
    </article>
  `).join("");

  // Make entire card clickable to article
  $$(".card").forEach(card => {
    card.addEventListener("click", e => {
      // If clicked an <a>, let it work; else go to article
      if (e.target.closest("a")) return;
      const id = card.getAttribute("data-id");
      if (id) location.href = `./article.html?id=${encodeURIComponent(id)}`;
    });
  });
}

/* ---------- Mobile: Story Mode (full-screen card, swipe up for next) ---------- */
let storyIndex = 0;

function renderStoryMode() {
  const list = articlesByCat[currentCat] || [];
  const mount = $("#storyMode");
  mount.innerHTML = "";

  if (!list.length) {
    mount.innerHTML = `<div class="empty">No articles yet for this category.</div>`;
    mount.hidden = false;
    return;
  }

  // clamp story index
  if (storyIndex >= list.length) storyIndex = 0;

  const a = list[storyIndex];
  mount.innerHTML = `
    <div class="story-card slide-in-up" id="storyCard" data-id="${a.id}">
      <div class="story-media">
        <img src="${imgProxy(a.image)}" alt="${escapeHtml(a.title)}" />
      </div>
      <div class="story-body">
        <div class="story-source">${escapeHtml(a.source)} • ${timeAgo(a.publishedAt || a.createdAt)}</div>
        <h2 class="story-title">${escapeHtml(a.title)}</h2>
        <p class="story-summary">${escapeHtml((a.summary || "").split(". ").slice(0, 2).join(". ") + ".")}</p>
        <div class="story-actions">
          <a class="btn" href="./article.html?id=${encodeURIComponent(a.id)}">Open</a>
          <a class="btn" href="${shareUrl(a.id)}" target="_blank" rel="noopener">Share</a>
        </div>
      </div>
    </div>
  `;
  mount.hidden = false;

  // Show/hide floating "Next story" pill with auto-hide
  const pill = document.getElementById("storyNext");
  if (pill) {
    pill.style.display = "flex";
    setTimeout(() => { pill.style.display = "none"; }, 2200);
  }
}

function nextStory() {
  const list = articlesByCat[currentCat] || [];
  if (!list.length) return;
  const card = $("#storyCard");
  if (card) {
    card.classList.remove("slide-in-up");
    card.classList.add("slide-out-up");
    setTimeout(() => {
      storyIndex = (storyIndex + 1) % list.length;
      renderStoryMode();
    }, 180);
  } else {
    storyIndex = (storyIndex + 1) % list.length;
    renderStoryMode();
  }
}

function prevStory() {
  const list = articlesByCat[currentCat] || [];
  if (!list.length) return;
  const card = $("#storyCard");
  if (card) {
    card.classList.remove("slide-in-down");
    card.classList.add("slide-out-down");
    setTimeout(() => {
      storyIndex = (storyIndex - 1 + list.length) % list.length;
      renderStoryMode();
    }, 180);
  } else {
    storyIndex = (storyIndex - 1 + list.length) % list.length;
    renderStoryMode();
  }
}

// Swipe support (anywhere in content)
let touchStartY = 0, touchStartX = 0;
function onTouchStart(e){ const t = e.changedTouches[0]; touchStartY = t.clientY; touchStartX = t.clientX; }
function onTouchEnd(e){
  const t = e.changedTouches[0];
  const dy = t.clientY - touchStartY;
  const dx = t.clientX - touchStartX;
  const isMobile = window.matchMedia("(max-width: 720px)").matches;

  if (!isMobile) return;

  // vertical swipe up/down for next/prev story
  if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) {
    if (dy < 0) nextStory(); else prevStory();
    return;
  }

  // horizontal swipe to change category
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
    const dir = dx < 0 ? +1 : -1;
    const list = CATEGORY_KEYS.filter(k => (articlesByCat[k]||[]).length > 0);
    const idx = Math.max(0, list.indexOf(currentCat));
    const nextIdx = (idx + dir + list.length) % list.length;
    setActiveCat(list[nextIdx]);
  }
}

// ===== US/CN dropdown (JS only needed for mobile tap)
function closeMobileSub(){
  const sub = $(".nav-dropdown .nav-sub");
  const btn = $('.nav-dropdown .nav-btn[data-cat="us"]');
  if (sub) sub.style.display = "";
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function setupDropdown() {
  const dropdown = $(".nav-dropdown");
  if (!dropdown) return;
  const trigger = dropdown.querySelector('.nav-btn[data-cat="us"]');
  const sub = dropdown.querySelector(".nav-sub");

  // On mobile, open by tap
  if (trigger && sub) {
    trigger.addEventListener("click", (e) => {
      const isDesktopHover = window.matchMedia("(hover:hover)").matches && window.matchMedia("(min-width: 769px)").matches;
      if (isDesktopHover) return; // desktop handled by CSS :hover
      e.preventDefault();
      const open = sub.style.display === "block";
      sub.style.display = open ? "" : "block";
      trigger.setAttribute("aria-expanded", open ? "false" : "true");
    });

    // Choose US or CN from submenu
    $$(".nav-sub-btn", sub).forEach(btn => {
      btn.addEventListener("click", () => {
        const cat = btn.dataset.cat;
        setActiveCat(cat);
        sub.style.display = "";
        trigger.setAttribute("aria-expanded", "false");
      });
    });

    // Click outside to close on mobile
    document.addEventListener("click", (e) => {
      if (!dropdown.contains(e.target)) closeMobileSub();
    });
  }
}

// ===== Top bar category buttons (non-dropdown)
function setupCategoryBar() {
  // Main category buttons
  $$(".main-nav .nav-btn").forEach(btn => {
    // skip the dropdown trigger here; it's handled above (but still carries data-cat="us")
    if (btn.closest(".nav-dropdown")) return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const cat = btn.dataset.cat;
      setActiveCat(cat);
    });
  });

  // Explicit US/CN submenu handled in setupDropdown()
}

// ===== On load
window.addEventListener("DOMContentLoaded", async () => {
  // Year (footer)
  const y = $("#year"); if (y) y.textContent = String(new Date().getFullYear());

  // Mobile story controls
  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchend", onTouchEnd, { passive: true });

  setupCategoryBar();
  setupDropdown();

  try {
    await fetchArticles();
  } catch (e) {
    const n = $("#notice");
    if (n) {
      n.hidden = false;
      n.textContent = "Could not load latest articles. Try again in a moment.";
    }
    console.error(e);
  }
});

// ===== Escape HTML helper
function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
