/* =========================================================
   NotifAi News — App (Homepage) with reliable region modal close
========================================================= */
const API_BASE = window.API_BASE || location.origin;

// Regions (in cat bar dropdown)
const REGIONS = [
  { code: "us", label: "US" },
  { code: "cn", label: "CN" },
  { code: "pk", label: "PK" },
  { code: "id", label: "ID" },
  { code: "uk", label: "UK" },
];

let REGION = (localStorage.getItem("region") || "us").toLowerCase();
if (!REGIONS.find(r => r.code === REGION)) REGION = "us";

let ARTICLES = {};
let currentCat = "us";

const grid = document.querySelector("#grid");
const hero = document.querySelector("#hero");
const storyMode = document.querySelector("#storyMode");
const usBtn = document.getElementById("usBtn");            // required in HTML
const regionCode = document.getElementById("regionCode");  // required in HTML
const regionMenu = document.getElementById("regionMenu");  // required in HTML
const regionDrop = document.getElementById("regionDrop");  // required in HTML
const regionModal = document.getElementById("regionModal");// optional first-visit modal

let storyIndex = 0;

const isMobile = () => window.matchMedia("(max-width: 720px)").matches;

/* ---------- Utilities ---------- */
function footerHeightPx(){
  const footer = document.querySelector(".site-footer");
  return footer ? footer.getBoundingClientRect().height : 0;
}
function vhMinusHeaderFooter(){
  const header = document.querySelector(".site-header");
  const h = header ? header.getBoundingClientRect().height : 0;
  const f = footerHeightPx();
  const vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
  return Math.max(220, vh - h - f - 8);
}
function setStoryHeight(){
  if (!isMobile() || !storyMode) return;
  storyMode.style.height = `${vhMinusHeaderFooter()}px`;
}
function currentList(){
  const cats = ARTICLES?.categories || {};
  return cats[currentCat] || [];
}

/* ---------- Region UI ---------- */
function applyRegionLabel(){
  const found = REGIONS.find(r => r.code === REGION);
  if (regionCode) regionCode.textContent = (found?.label || "US");
  // Accent color for CN
  document.documentElement.classList.toggle("cn-accent", REGION === "cn");
}
function populateRegionMenu(){
  if (!regionMenu) return;
  regionMenu.innerHTML = "";
  REGIONS.forEach(r => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = r.label;
    btn.dataset.region = r.code;
    if (r.code === REGION) btn.setAttribute("aria-selected","true");
    btn.addEventListener("click", () => {
      chooseRegion(r.code);
      hideCatDropdown();
    });
    li.appendChild(btn);
    regionMenu.appendChild(li);
  });
}
function showCatDropdown(){
  if (!regionMenu || !usBtn) return;
  regionMenu.classList.add("show");
  usBtn.setAttribute("aria-expanded","true");
}
function hideCatDropdown(){
  if (!regionMenu || !usBtn) return;
  regionMenu.classList.remove("show");
  usBtn.setAttribute("aria-expanded","false");
}

usBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!regionMenu) return;
  const open = regionMenu.classList.contains("show");
  open ? hideCatDropdown() : showCatDropdown();
});
document.addEventListener("click", (e) => {
  if (!regionDrop) return;
  if (regionDrop.contains(e.target)) return;
  hideCatDropdown();
});

function hardCloseRegionModal(){
  if (!regionModal) return;
  regionModal.setAttribute("hidden","");
  regionModal.style.display = "none";
  regionModal.style.pointerEvents = "none";
  try { regionModal.remove(); } catch {}
}
function showRegionModalIfNeeded(){
  if (!regionModal) return;
  if (!localStorage.getItem("region")) {
    regionModal.hidden = false;

    // click on any country -> set & close
    regionModal.querySelectorAll("button[data-region]").forEach(b => {
      b.addEventListener("click", () => {
        chooseRegion(b.dataset.region);
        hardCloseRegionModal();
      });
    });

    // click outside the card -> default to US, close
    regionModal.addEventListener("click", (e) => {
      if (e.target === regionModal) {
        if (!localStorage.getItem("region")) chooseRegion("us");
        hardCloseRegionModal();
      }
    }, { once:true });
  }
}

function chooseRegion(code){
  const ok = REGIONS.find(r => r.code === code);
  REGION = ok ? ok.code : "us";
  localStorage.setItem("region", REGION);
  applyRegionLabel();
  storyIndex = 0;
  loadArticles();
}

/* ---------- Renderers ---------- */
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
function makeCard(a){
  const img = a.image ? `${API_BASE}/img?u=${encodeURIComponent(a.image)}` : "/cover.jpg";
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `
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
  // Click anywhere on the card to open
  el.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    location.href = `article.html?id=${a.id}`;
  });
  return el;
}
async function renderCategory(){
  const items = currentList();

  if (grid) grid.innerHTML = "";
  renderHero(null);

  if (!items || !items.length) {
    if (grid) grid.innerHTML = `<div class="empty">No articles found.</div>`;
    return;
  }
  renderHero(items[0]);
  items.slice(1).forEach(a => grid.appendChild(makeCard(a)));
}

/* ---------- Data ---------- */
async function loadArticles(){
  const res = await fetch(`${API_BASE}/api/articles?region=${encodeURIComponent(REGION)}`, { cache:"no-store" });
  const data = await res.json();
  ARTICLES = data;

  // mark active category
  const active = document.querySelector(`.main-nav .nav-btn[data-cat="${currentCat}"]`);
  if (active){
    document.querySelectorAll(".main-nav .nav-btn").forEach(b => b.classList.remove("active"));
    active.classList.add("active");
  }
  applyRegionLabel();
  await renderCategory();
}

/* ---------- Category clicks ---------- */
document.getElementById("catBar")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn) return;
  if (btn.id === "usBtn") return; // handled by dropdown logic
  const cat = btn.dataset.cat;
  if (!cat || cat === currentCat) return;
  currentCat = cat;
  storyIndex = 0;
  document.querySelectorAll(".main-nav .nav-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  renderCategory();
});

/* ---------- Init ---------- */
function populateRegionMenuAndLabel(){
  applyRegionLabel();
  populateRegionMenu();
}
(async function init(){
  populateRegionMenuAndLabel();
  showRegionModalIfNeeded();
  await loadArticles();
})();
