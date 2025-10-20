// public/article.js — render a single article by id (light theme, hero image not stretched)

const API_BASE = window.API_BASE || location.origin;
const root = document.getElementById("article-root");

function section(title, html) {
  return `
    <section class="card p-4 mt-6">
      <h2 class="h3">${title}</h2>
      <div class="body mt-2 prewrap">${html}</div>
    </section>
  `;
}

function escapeHtml(x="") {
  return x.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function main() {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  if (!id) {
    root.innerHTML = `<div class="alert">Missing article id.</div>`;
    return;
  }

  let data;
  try {
    const res = await fetch(`${API_BASE}/api/article/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    data = await res.json();
  } catch (e) {
    root.innerHTML = `<div class="alert">Failed to load article. ${escapeHtml(e.message || String(e))}</div>`;
    return;
  }

  const img = data.image || "/cover.jpg";
  const when = data.publishedAt ? new Date(data.publishedAt).toLocaleString() : "";
  const src = data.source || "";
  const title = data.title || "";

  // parse debate defensively
  let debate = { socialist:{name:"Jessica Rebella",open:""}, rightwing:{name:"John Davis",open:""}, conspiracy:{name:"Joe Musk",open:""} };
  try {
    if (data.debateJson) {
      const parsed = JSON.parse(data.debateJson);
      if (parsed && typeof parsed === "object") debate = Object.assign(debate, parsed);
    }
  } catch {}

  root.innerHTML = `
    <article class="card">
      <div class="hero-wrap">
        <img class="hero-img" src="${img}" alt="${escapeHtml(title)}">
      </div>
      <div class="p-4">
        <div class="meta">${escapeHtml(src)} • ${when}</div>
        <h1 class="h1 mt-2">${escapeHtml(title)}</h1>
        <p class="body mt-2">${escapeHtml(data.summary || "")}</p>
        <div class="mt-3">
          <a class="btn" href="${data.url}" target="_blank" rel="noopener">Open Source Article</a>
        </div>
      </div>
    </article>

    ${section(`${escapeHtml(debate.socialist?.name || "Jessica Rebella")} (Socialist)`, escapeHtml(debate.socialist?.open || ""))}
    ${section(`${escapeHtml(debate.rightwing?.name || "John Davis")} (Right-wing)`, escapeHtml(debate.rightwing?.open || ""))}
    ${section(`${escapeHtml(debate.conspiracy?.name || "Joe Musk")} (Conspiracy)`, escapeHtml(debate.conspiracy?.open || ""))}
  `;
}

main();
