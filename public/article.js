const API_BASE = (window.API_BASE || window.location.origin).replace(/\/+$/, "");
const params = new URLSearchParams(window.location.search);
const id = params.get("id");

const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

const titleEl = document.getElementById("title");
const sourceEl = document.getElementById("source");
const whenEl   = document.getElementById("when");
const heroEl   = document.getElementById("hero");
const summaryEl = document.getElementById("summary");

const vS = document.getElementById("v-socialist");
const vR = document.getElementById("v-rightwing");
const vC = document.getElementById("v-conspiracy");

// new: clickable hero link + full article link
const sourceLinkImage = document.getElementById("sourceLinkImage");
const fullLink = document.getElementById("fullLink");

if (!id) {
  if (titleEl) titleEl.textContent = "Article not found";
} else {
  load();
}

async function load() {
  try {
    const res = await fetch(`${API_BASE}/api/article/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`article ${res.status}`);
    const a = await res.json();

    if (titleEl) titleEl.textContent = a.title || "(untitled)";
    if (sourceEl) sourceEl.textContent = a.source || "";
    if (whenEl) whenEl.textContent = a.publishedAt ? new Date(a.publishedAt).toLocaleString() : "";

    const img = toProxy(a.image);
    if (heroEl) heroEl.src = img;

    // link hero image and the full article button to original source
    if (sourceLinkImage) sourceLinkImage.href = a.url;
    if (fullLink) fullLink.href = a.url;

    if (summaryEl) summaryEl.textContent = a.summary || "";

    let debate = {};
    try { debate = JSON.parse(a.debateJson || "{}"); } catch {}
    if (vS) vS.textContent = debate?.socialist?.open  || "—";
    if (vR) vR.textContent = debate?.rightwing?.open  || "—";
    if (vC) vC.textContent = debate?.conspiracy?.open || "—";
  } catch (e) {
    if (titleEl) titleEl.textContent = "Failed to load article.";
    console.error(e);
  }
}

function toProxy(u) {
  if (!u || typeof u !== "string") return "/cover.jpg";
  if (!/^https?:\/\//i.test(u)) return "/cover.jpg";
  return `${API_BASE}/img?u=${encodeURIComponent(u)}`;
}
