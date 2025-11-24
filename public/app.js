// NotifAi News — Frontend App (cards-only; hero disabled on all devices; swipe to change category; logo fallback kept)

const API_BASE = window.API_BASE || window.location.origin;
const COVER = "/cover.jpg";
const CATS = ["us", "finance", "entertainment", "world", "crypto"];
const REGIONS = ["us", "cn", "pk", "id", "uk", "ng"];

let state = {
  region: (localStorage.getItem("region") || "us").toLowerCase(),
  category: normalizeCat(localStorage.getItem("cat") || "us"),
  data: null,
  itemsByCat: { us: [], finance: [], entertainment: [], world: [], crypto: [] }
};

function normalizeCat(c) {
  c = (c || "").toLowerCase();
  return CATS.includes(c) ? c : "us";
}

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* -------------------- Utilities -------------------- */
function proxyImg(u) {
  return u && /^https?:/i.test(u) ? `/img?u=${encodeURIComponent(u)}` : COVER;
}
function setNotice(text) {
  const n = $("#notice");
  if (!n) return;
  if (!text) {
    n.hidden = true;
    n.textContent = "";
  } else {
    n.hidden = false;
    n.textContent = text;
  }
}
function saveRegion(r)   { try { localStorage.setItem("region", r); } catch {} }
function saveCategory(c) { try { localStorage.setItem("cat", c); } catch {} }
function isMobile()      { return window.matchMedia("(max-width: 768px)").matches; }

function on(el, evt, fn, opts) { if (el) el.addEventListener(evt, fn, opts || false); }
function esc(s) { return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
function hydro(id){ return (id == null ? "" : String(id)); }

/* -------------------- Region Modal -------------------- */
function openRegionModal() {
  const m = $("#regionModal"); if (!m) return;
  m.hidden = false; m.classList.add("show");
}
function closeRegionModal() {
  const m = $("#regionModal"); if (!m) return;
  m.classList.remove("show"); m.hidden = true;
}
function initRegionModal() {
  const modal = $("#regionModal");
  if (!modal) return;

  if (!localStorage.getItem("region")) { modal.hidden = false; modal.classList.add("show"); }
  else { modal.hidden = true; modal.classList.remove("show"); }

  on(modal, "click", (e) => {
    const btn = e.target.closest("button[data-region]");
    if (!btn) { if (e.target === modal) closeRegionModal(); return; }
    const r = (btn.getAttribute("data-region") || "").toLowerCase();
    if (!REGIONS.includes(r)) return;
    state.region = r; saveRegion(r);
    state.category = normalizeCat(state.category);
    closeRegionModal();
    loadArticles();
  });

  const footerTrigger = $("[data-action='change-region']");
  if (footerTrigger) on(footerTrigger, "click", (e) => { e.preventDefault(); openRegionModal(); });

  const changeRegionBtn = $("#changeRegion");
  if (changeRegionBtn) on(changeRegionBtn, "click", (e) => { e.preventDefault(); openRegionModal(); });

  on(document, "keydown", (e) => { if (e.key === "Escape") closeRegionModal(); });
}

/* -------------------- Highlight active category -------------------- */
function highlightActiveCat() {
  $$(".main-nav .nav-btn").forEach(btn => {
    const c = (btn.getAttribute("data-cat") || "").toLowerCase();
    btn.classList.toggle("active", c === state.category);
  });
}

/* -------------------- Category bar + swipe anywhere -------------------- */
function initCategoryBar() {
  // Click buttons (desktop + mobile)
  $$(".main-nav .nav-btn").forEach(btn => {
    on(btn, "click", () => {
      const c = (btn.getAttribute("data-cat") || "").toLowerCase();
      if (!CATS.includes(c)) return;
      state.category = c;
      saveCategory(c);
      highlightActiveCat();
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  // Swipe anywhere on screen (MOBILE ONLY, including over cards)
  let startX = 0;
  let startY = 0;
  let tracking = false;

  function onTouchStart(e) {
    if (!isMobile()) return;
    if (!e.touches || !e.touches[0]) return;
    tracking = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }

  function onTouchMove(e) {
    if (!isMobile()) return;
    if (!tracking) return;
    if (!e.touches || !e.touches[0]) return;

    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    const dx = x - startX;
    const dy = y - startY;

    // Only treat as swipe if it's clearly horizontal
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.3) {
      return; // let vertical scroll happen
    }

    // At this point, it's a horizontal swipe -> prevent accidental click/scroll
    e.preventDefault();
    tracking = false;

    const dir = dx > 0 ? -1 : 1; // swipe right => previous, left => next
    const idx = CATS.indexOf(state.category);
    const next = Math.min(CATS.length - 1, Math.max(0, idx + dir));

    if (next !== idx) {
      state.category = CATS[next];
      saveCategory(state.category);
      highlightActiveCat();
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function onTouchEnd() {
    if (!isMobile()) return;
    tracking = false;
  }

  function onTouchCancel() {
    if (!isMobile()) return;
    tracking = false;
  }

  // Attach only touch handlers so it works reliably on phones
  document.addEventListener("touchstart", onTouchStart, { passive: true });
  // touchmove must be non-passive so we *can* preventDefault on horizontal swipe
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("touchcancel", onTouchCancel, { passive: true });
}

/* -------------------- Fetch & Render -------------------- */
async function loadArticles() {
  setNotice("");
  try {
    const url = new URL(`${API_BASE}/api/articles`);
    url.searchParams.set("region", state.region);
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    state.data = json || {};
    state.itemsByCat = (json && json.categories) || { us: [], finance: [], entertainment: [], world: [], crypto: [] };
    state.category = normalizeCat(state.category);
    highlightActiveCat();

    render();
  } catch (err) {
    console.error(err);
    setNotice("Failed to load stories. Pull to refresh or try again.");
  }
}

function render() {
  const list = state.itemsByCat[state.category] || [];

  // No hero anywhere: cards only
  const heroEl = $("#hero");
  if (heroEl) heroEl.hidden = true;

  const grid = $("#grid");
  if (!grid) return;
  grid.innerHTML = "";

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No stories yet.";
    grid.appendChild(empty);
    return;
  }

  for (const a of list) {
    const A = document.createElement("a");
    A.className = "card";
    A.href = `/article.html?id=${encodeURIComponent(hydro(a.id))}`;
    A.innerHTML = `
      <div class="thumb"><img loading="lazy" src="${proxyImg(a.image)}" alt=""></div>
      <div class="info">
        <h3>${esc(a.title || "")}</h3>
        <p class="summary">${esc((a.summary || "").replace(/\s+/g, " ").slice(0, 220))}</p>
        <div class="meta"><span>${esc(a.source || "")}</span><span class="read">Read →</span></div>
      </div>
    `;
    grid.appendChild(A);
  }
}

/* -------------------- Donate (MetaMask) -------------------- */
function ensureEthersLoaded(cb) {
  if (window.ethers) return cb();
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js";
  s.onload = cb;
  document.head.appendChild(s);
}
function wireDonate() {
  const click = (e) => {
    e.preventDefault();
    ensureEthersLoaded(async () => {
      if (!window.ethereum) { alert("Please install MetaMask or a compatible wallet."); return; }
      try {
        const provider = new window.ethers.providers.Web3Provider(window.ethereum);
        await provider.send("eth_request_accounts", []);
        const signer = provider.getSigner();
        const tx = await signer.sendTransaction({
          to: "0x6a98b87f8116678ed98f74ae9a638bf30ebf3846",
          value: window.ethers.utils.parseEther("0.01")
        });
        await tx.wait();
        alert("Thank you for your donation!");
      } catch (err) {
        console.error(err);
        alert("Donation failed: " + (err && err.message ? err.message : String(err)));
      }
    });
  };
  on($("#donateBtn"), "click", click);
  on($("#donateBtnFooter"), "click", click);
  on($("#menuDonate"), "click", click);
}

/* -------------------- Logo fallback (png/jpg/jpeg) -------------------- */
function initLogo() {
  const brand = $("#brand");
  if (!brand) return;
  const img = brand.querySelector(".logo-img");
  const label = brand.querySelector(".logo-text");
  if (!img) return;

  const candidates = ["/logo.png", "/logo.jpg", "/logo.jpeg", "/logo.PNG", "/logo.JPG", "/logo.JPEG"];

  function tryNext(i) {
    if (i >= candidates.length) {
      if (label) label.style.display = "inline-block";
      img.style.display = "none";
      return;
    }
    const test = new Image();
    test.onload = () => { img.src = candidates[i]; img.style.display = ""; if (label) label.style.display = "none"; };
    test.onerror = () => tryNext(i + 1);
    test.src = candidates[i] + "?v=" + Date.now();
  }

  if (img.complete && img.naturalWidth > 0) { if (label) label.style.display = "none"; img.style.display = ""; }
  else {
    on(img, "error", () => tryNext(0), { once: true });
    if (!img.getAttribute("src")) tryNext(0);
  }
}

/* -------------------- Boot -------------------- */
document.addEventListener("DOMContentLoaded", () => {
  initLogo();
  initRegionModal();
  initCategoryBar();
  wireDonate();
  loadArticles();
});