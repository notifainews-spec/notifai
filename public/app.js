// public/app.js — build tabs + cards and link to article.html?id=<id>

const API_BASE = window.API_BASE || location.origin;

// UI refs
const tabsEl  = document.getElementById("tabs");
const gridEl  = document.getElementById("grid");
const errEl   = document.getElementById("error");
const refreshBtn = document.getElementById("refreshBtn");

function showError(msg) {
  errEl.textContent = msg;
  errEl.classList.remove("hide");
}
function hideError() {
  errEl.classList.add("hide");
  errEl.textContent = "";
}

function cardHtml(item) {
  const dateStr = item.publishedAt ? new Date(item.publishedAt).toLocaleString() : "";
  const img = item.image || "/cover.jpg";
  return `
    <a class="card" href="/article.html?id=${encodeURIComponent(item.id)}" data-id="${item.id}">
      <div class="media-wrap">
        <img class="media" src="${img}" alt="${item.title}">
      </div>
      <div class="p-4">
        <div class="meta">${item.source} • ${dateStr}</div>
        <h3 class="h3 mt-2 line-clamp-2">${item.title}</h3>
        <p class="body-sm mt-2 line-clamp-3">${item.summary || ""}</p>
      </div>
    </a>`;
}

async function loadArticles() {
  hideError();
  gridEl.innerHTML = "";
  tabsEl.innerHTML = "";
  try {
    const res = await fetch(`${API_BASE}/api/articles`, { cache: "no-store" });
    if (!res.ok) throw new Error(`articles ${res.status}`);
    const json = await res.json();

    const cats = Object.keys(json.categories || {});
    // tabs
    cats.forEach((c, i) => {
      const btn = document.createElement("button");
      btn.className = "tab" + (i === 0 ? " active" : "");
      btn.textContent = c.toUpperCase();
      btn.dataset.cat = c;
      btn.onclick = () => {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        btn.classList.add("active");
        renderGrid(c);
      };
      tabsEl.appendChild(btn);
    });

    // first render
    if (cats.length) renderGrid(cats[0]);

    function renderGrid(cat) {
      const list = json.categories[cat] || [];
      if (!list.length) {
        gridEl.innerHTML = `<div class="alert">No stories yet in ${cat.toUpperCase()} — try Refresh.</div>`;
        return;
      }
      gridEl.innerHTML = list.map(cardHtml).join("");
    }
  } catch (e) {
    showError("Failed to load stories. " + (e.message || e));
  }
}

async function refreshNow() {
  try {
    refreshBtn.disabled = true;
    await fetch(`${API_BASE}/api/cron-bg`).catch(()=>{});
    setTimeout(loadArticles, 1500);
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn?.addEventListener("click", refreshNow);

loadArticles();
