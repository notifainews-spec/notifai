/* public/app.js
   NotifAi News — front-end
   - Loads /api/articles
   - Renders categories, hero, and grid
   - Mobile: keeps story mode hook if you want it (disabled by default here)
*/

const API_BASE = window.API_BASE || location.origin;

// ---------- State ----------
const state = {
  category: "us",                 // default category
  itemsByCat: { us: [], world: [], entertainment: [], finance: [], crypto: [] },
  loaded: false
};

// ---------- Utils ----------
function proxyImg(u) {
  if (!u || !/^https?:\/\//i.test(u)) return "cover.jpg";
  return `/img?u=${encodeURIComponent(u)}`;
}
function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function on(el, ev, fn, opts) { el && el.addEventListener(ev, fn, opts); }

function pickHero(list) {
  if (!list || !list.length) return null;
  // Prefer the first with an image; else first item
  const withImg = list.find(x => x.image);
  return withImg || list[0];
}

// ---------- Fetch ----------
async function loadArticles() {
  const url = `${API_BASE}/api/articles?limit=12`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // Expecting { categories: { us:[], world:[], entertainment:[], finance:[], crypto:[] } }
  state.itemsByCat = json.categories || state.itemsByCat;
  state.loaded = true;
}

// ---------- Categories UI ----------
function buildCategories() {
  const order = ["us", "world", "entertainment", "finance", "crypto"];
  const labels = {
    us: "US",
    world: "World",
    entertainment: "Entertainment",
    finance: "Finance",
    crypto: "Crypto"
  };
  const catsEl = qs("#cats");
  if (!catsEl) return;

  catsEl.innerHTML = order.map(cat => {
    const active = (state.category === cat) ? "active" : "";
    return `<button class="chip ${active}" data-cat="${cat}" aria-label="${labels[cat]}">${labels[cat]}</button>`;
  }).join("");

  qsa('button[data-cat]', catsEl).forEach(btn => {
    on(btn, "click", () => {
      const cat = btn.getAttribute("data-cat");
      if (cat && cat !== state.category) {
        state.category = cat;
        buildCategories();
        render();
      }
    });
  });
}

// ---------- Render ----------
function render() {
  const list = state.itemsByCat[state.category] || [];
  const hero = pickHero(list);

  // HERO
  const heroEl = qs("#hero");
  if (hero && heroEl) {
    const img = proxyImg(hero.image);
    const heroHtml = `
      <a class="hero-card" href="article.html?id=${encodeURIComponent(hero.id)}" aria-label="${hero.title}">
        <img class="hero-img" src="${img}" alt="">
        <div class="hero-gradient"></div>
        <div class="hero-copy">
          <span class="hero-source">${hero.source || ""}</span>
          <h2 class="hero-title">${hero.title || ""}</h2>
          <p class="hero-summary">${(hero.summary || "").replace(/\s+/g," ").trim().slice(0,180)}</p>
        </div>
      </a>
    `;
    heroEl.innerHTML = heroHtml;
  } else if (heroEl) {
    heroEl.innerHTML = "";
  }

  // GRID (rest of items)
  const grid = qs("#grid");
  if (!grid) return;
  grid.innerHTML = "";

  const rest = (list || []).slice(hero ? 1 : 0);
  if (!rest.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No more stories yet.";
    grid.appendChild(div);
    return;
  }

  for (const a of rest) {
    const card = document.createElement("a");
    card.className = "card";
    card.href = `/article.html?id=${encodeURIComponent(a.id)}`;
    card.innerHTML = `
      <div class="thumb">
        <img loading="lazy" src="${proxyImg(a.image)}" alt="">
      </div>
      <div class="info">
        <h3>${a.title || ""}</h3>
        <p class="summary">${(a.summary || "").replace(/\s+/g," ").slice(0,280)}</p>
        <div class="meta">
          <span>${a.source || ""}</span>
          <span class="read">Read more →</span>
        </div>
      </div>
    `;
    // Make whole card clickable (already an anchor, but ensure inner elements don't block)
    card.addEventListener("click", (e) => {
      // Let anchor work normally; nothing special needed
    });
    grid.appendChild(card);
  }
}

// ---------- Init ----------
async function init() {
  try {
    // Optional: default category from URL ?cat=world
    const params = new URLSearchParams(location.search);
    const cat = params.get("cat");
    if (cat && state.itemsByCat[cat] !== undefined) {
      state.category = cat;
    }

    await loadArticles();
    buildCategories();
    render();

    // Optional: if you want story mode auto on mobile, uncomment this:
    // if (matchMedia("(max-width: 720px)").matches){
    //   document.body.classList.add("story-active");
    //   buildStoryMode(); // you need your existing implementation for story mode
    // }

  } catch (e) {
    console.error("Init failed", e);
    const heroEl = qs("#hero");
    if (heroEl) heroEl.innerHTML = `<div class="empty">Failed to load stories.</div>`;
  }
}

document.addEventListener("DOMContentLoaded", init);