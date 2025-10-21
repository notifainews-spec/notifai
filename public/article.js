const API_BASE = (window.API_BASE || window.location.origin).replace(/\/+$/, "");
const params = new URLSearchParams(window.location.search);
const id = params.get("id");

const yearEl = document.getElementById("year");
yearEl.textContent = new Date().getFullYear();

const titleEl = document.getElementById("title");
const sourceEl = document.getElementById("source");
const whenEl   = document.getElementById("when");
const heroEl   = document.getElementById("hero");
const summaryEl = document.getElementById("summary");

const vS = document.getElementById("v-socialist");
const vR = document.getElementById("v-rightwing");
const vC = document.getElementById("v-conspiracy");
const openSource = document.getElementById("openSource");

if (!id) {
  titleEl.textContent = "Article not found";
} else {
  load();
}

async function load() {
  try {
    const res = await fetch(`${API_BASE}/api/article/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`article ${res.status}`);
    const a = await res.json();

    titleEl.textContent = a.title || "(untitled)";
    sourceEl.textContent = a.source || "";
    whenEl.textContent = a.publishedAt ? new Date(a.publishedAt).toLocaleString() : "";
    openSource.href = a.url;

    const img = (a.image && (a.image.startsWith("http://") || a.image.startsWith("https://"))) ? a.image : "/cover.jpg";
    heroEl.src = img;

    summaryEl.textContent = a.summary || "";

    let debate = {};
    try { debate = JSON.parse(a.debateJson || "{}"); } catch {}
    // Show ONLY names + argument (no labels like "Opening", "Socialist", etc.)
    vS.textContent = debate?.socialist?.open  || "—";
    vR.textContent = debate?.rightwing?.open  || "—";
    vC.textContent = debate?.conspiracy?.open || "—";
  } catch (e) {
    titleEl.textContent = "Failed to load article.";
    console.error(e);
  }
}
