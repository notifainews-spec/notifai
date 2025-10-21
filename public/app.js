const API_BASE = (window.API_BASE || window.location.origin).replace(/\/+$/, "");
const grid   = document.getElementById("grid");
const notice = document.getElementById("notice");
const yearEl = document.getElementById("year");
yearEl.textContent = new Date().getFullYear();

const tabs = [...document.querySelectorAll(".nav-btn")];
let currentCat = "us";

tabs.forEach(btn => {
  btn.addEventListener("click", () => {
    tabs.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentCat = btn.getAttribute("data-cat");
    renderCategory(currentCat);
  });
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  showNotice("Fetching latest…");
  try {
    await fetch(`${API_BASE}/api/cron-bg`, { cache: "no-store" });
    setTimeout(async () => {
      await loadData(true);
      hideNotice();
    }, 4000);
  } catch (e) {
    showNotice("Refresh failed. Try again.");
  }
});

let ARTICLES = { us:[], world:[], entertainment:[], finance:[] };

async function loadData(noCache=false) {
  const url = `${API_BASE}/api/articles${noCache ? `?t=${Date.now()}` : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`articles ${res.status}`);
  const data = await res.json();
  ARTICLES = data.categories || ARTICLES;
  renderCategory(currentCat);
}

function renderCategory(cat) {
  const items = ARTICLES?.[cat] || [];
  grid.innerHTML = "";

  if (!items.length) {
    grid.innerHTML = `<div class="empty">No stories yet. Try “Refresh”.</div>`;
    return;
  }

  for (const a of items) {
    const img = sanitizeImg(a.image);
    const date = a.publishedAt ? new Date(a.publishedAt) : null;
    const when = date ? date.toLocaleString() : "";

    const card = document.createElement("article");
    card.className = "card";

    card.innerHTML = `
      <a class="thumb" href="./article.html?id=${encodeURIComponent(a.id)}" title="${escapeHtml(a.title)}">
        <img loading="lazy" src="${img}" alt="" onerror="this.onerror=null;this.src='/cover.jpg';" />
      </a>
      <div class="meta">
        <a class="title" href="./article.html?id=${encodeURIComponent(a.id)}">${escapeHtml(a.title)}</a>
        <div class="byline">
          <span class="source">${escapeHtml(a.source || "")}</span>
          <span class="dot">•</span>
          <time>${escapeHtml(when)}</time>
        </div>
        <p class="summary">${escapeHtml(a.summary || "")}</p>
      </div>
    `;
    grid.appendChild(card);
  }
}

function sanitizeImg(u) {
  if (!u || typeof u !== "string") return "/cover.jpg";
  try {
    const good = u.startsWith("http://") || u.startsWith("https://");
    return good ? u : "/cover.jpg";
  } catch {
    return "/cover.jpg";
  }
}

function showNotice(msg) {
  notice.textContent = msg;
  notice.hidden = false;
}
function hideNotice() {
  notice.hidden = true;
  notice.textContent = "";
}
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

loadData().catch(err => {
  console.error(err);
  showNotice("Could not load stories. Check /api/selftest and /api/diagnose.");
});
