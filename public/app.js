/* =========================================================
   NotifAi News - Main App
   ========================================================= */

const API_BASE = window.API_BASE || location.origin;
let ARTICLES = {};
let currentCat = "us";

// DOM elements
const grid = document.querySelector("#grid");
const catButtons = document.querySelectorAll(".category");

// ---------------------------------------------------------
// CATEGORY RENDERER
// ---------------------------------------------------------
function renderCategory(cat) {
  if (!grid) return;

  // normalize data shape
  const items =
    (ARTICLES?.[cat]) ||
    (ARTICLES?.categories?.[cat]) ||
    [];

  grid.innerHTML = "";

  if (!items || items.length === 0) {
    grid.innerHTML = `<div class="empty">No articles found.</div>`;
    return;
  }

  for (const a of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="thumb">
        <img src="${API_BASE}/img?u=${encodeURIComponent(a.image || "/cover.jpg")}" alt="${a.title}">
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

// ---------------------------------------------------------
// LOAD ARTICLES
// ---------------------------------------------------------
async function loadArticles() {
  try {
    const res = await fetch(`${API_BASE}/api/articles`, { cache: "no-store" });
    const data = await res.json();

    // Normalize the structure
    ARTICLES = data?.categories || data || {};

    if (!ARTICLES || !Object.keys(ARTICLES).length) {
      grid.innerHTML = `<div class="empty">Loading failed or no data.</div>`;
      return;
    }

    console.log("Loaded categories:", Object.keys(ARTICLES));

    renderCategory(currentCat);
  } catch (e) {
    console.error("Error loading articles:", e);
    grid.innerHTML = `<div class="empty">Failed to fetch articles.</div>`;
  }
}

// ---------------------------------------------------------
// CATEGORY BUTTONS
// ---------------------------------------------------------
catButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const cat = btn.dataset.cat;
    if (!cat || cat === currentCat) return;
    currentCat = cat;

    catButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    renderCategory(currentCat);
  });
});

// ---------------------------------------------------------
// INITIALIZE
// ---------------------------------------------------------
loadArticles();
