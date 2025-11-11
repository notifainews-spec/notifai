// NotifAi News — Frontend App (scrolling UX; swipe to change category; modal + logo fixes)

const API_BASE = window.API_BASE || window.location.origin;
const COVER = "/cover.jpg";
const CATS = ["us", "finance", "entertainment", "world", "crypto"];
const REGIONS = ["us", "cn", "pk", "id", "uk"];

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

const $ = (sel, root = document) => root.querySelector(sel);
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
function saveRegion(r) { try { localStorage.setItem("region", r); } catch {} }
function saveCategory(c) { try { localStorage.setItem("cat", c); } catch {} }

// Convenience: add event listener with sane defaults
function on(el, evt, fn, opts) {
  if (!el) return;
  el.addEventListener(evt, fn, opts || false);
}

/* -------------------- Region Modal -------------------- */
function openRegionModal() {
  const m = $("#regionModal");
  if (!m) return;
  m.hidden = false;       // important: toggle the attribute
  m.classList.add("show");
}
function closeRegionModal() {
  const m = $("#regionModal");
  if (!m) return;
  m.classList.remove("show");
  m.hidden = true;        // important: toggle the attribute
}
function initRegionModal() {
  const modal = $("#regionModal");
  if (!modal) return;

  // First visit? Show it. Otherwise keep it hidden.
  if (!localStorage.getItem("region")) {
    modal.hidden = false;
    modal.classList.add("show");
  } else {
    modal.hidden = true;
    modal.classList.remove("show");
  }

  // Click on region buttons
  on(modal, "click", (e) => {
    const btn = e.target.closest("button[data-region]");
    if (!btn) {
      // click outside inner card closes modal
      if (e.target === modal) closeRegionModal();
      return;
    }
    const r = (btn.getAttribute("data-region") || "").toLowerCase();
    if (!REGIONS.includes(r)) return;
    state.region = r;
    saveRegion(r);
    // keep current category if valid; else fallback to 'us'
    state.category = normalizeCat(state.category);
    closeRegionModal();
    loadArticles();
  });

  // Footer/menu triggers
  $("[data-action='change-region']") && on($("[data-action='change-region']"), "click", (e) => {
    e.preventDefault();
    openRegionModal();
  });
  on($("#changeRegion"), "click", (e) => { e.preventDefault(); openRegionModal(); });

  // Escape to close
  on(document, "keydown", (e) => {
    if (e.key === "Escape") closeRegionModal();
  });
}

/* -------------------- Category Bar + Swipe -------------------- */
function initCategoryBar() {
    // Click to switch categories
    $$(".main-nav .nav-btn").forEach(btn => {
      on(btn, "click", () => {
        const c = (btn.getAttribute("data-cat") || "").toLowerCase();
        if (!CATS.includes(c)) return;
        state.category = c;
        saveCategory(c);
        highlightActiveCat();
        render(); // re-render lists
        // scroll to top for a nicer UX
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

    // Swipe left/right anywhere to change category (robust Pointer Events)
    let startX = 0, startY = 0, isPointerDown = false;
    let moved = false;

    on(document, "pointerdown", (e) => {
      isPointerDown = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
    });

    on(document, "pointermove", (e) => {
      if (!isPointerDown) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 12) moved = true; // started a horizontal gesture
      // we don't preventDefault to keep page scroll working naturally
    }, { passive: true });

    on(document, "pointerup", (e) => {
      if (!isPointerDown) return;
      isPointerDown = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // treat as swipe if horizontal displacement dominates and is > 50px
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        const dir = dx > 0 ? -1 : 1; // right swipe -> previous, left swipe -> next
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
    });
}
function highlightActiveCat() {
  $$(".main-nav .nav-btn").forEach(b => b.classList.remove("active"));
  const active = $(`.main-nav .nav-btn[data-cat="${state.category}"]`);
  if (active) active.classList.add("different-bg", "active"); // 'different-bg' optional if you style it
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

function pickHero(list) {
  return Array.isArray(list) && list.length ? list[0] : null;
}

function render() {
  const list = state.itemsByCat[state.category] || [];
  const hero = pickHero(list);

  // --- HERO (populate existing DOM, toggle hidden attr) ---
  const heroEl = $("#hero");
  if (heroEl) {
    if (hero) {
      const link  = $("#heroLink");
      const img   = $("#heroImg");
      const title = $("#heroTitle");
      const kicker= $("#heroKicker");
      const read  = $("#heroRead");

      if (link)  link.href  = `./article.html?id=${encodeURIComponent(hydro(hero.id))}`;
      if (img)   { img.src = proxyImg(hero.image); img.alt = hero.title || "Top story"; }
      if (title) title.textContent = hero.title || "";
      if (kicker) kicker.textContent = (hero.source || "Top story");
      if (read)  read.href = `./article.html?id=${encodeURIComponent(hydro(hero.id))}`;

      heroEl.hidden = false; // ensure visible
    } else {
      heroEl.hidden = true;
    }
  }

  // --- GRID for remaining items ---
  const grid = $("#grid");
  if (!grid) return;
  grid.innerHTML = "";

  const tail = hero ? list.slice(1) : list.slice();
  if (!tail.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No more stories yet.";
    grid.appendChild(empty);
    return;
  }

  for (const a of tail) {
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

function esc(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
function hydro(id){ return (id == null ? "" : String(id)); }

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
        const CONTRACT = "0x6a98b87f8116678ed98f74ae9c15d0e1348658e4444".replace("c15d0e","a2ed5a"); // keep your actual address here
        // ↑ If you already have the exact address in HTML, remove this line and hardcode it.

        const tx = await signer.sendTransaction({
          to: "0x6a98b87f8116678ed98f74ae9a638bf30ebf3846", // your donation wallet/contract
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
      // no image available -> show text label, hide <img>
      if (label) label.style.display = "inline-block";
      img.style.display = "none";
      return;
    }
    const test = new Image();
    test.onload = () => {
      img.src = candidates[i];
      img.style.display = "";
      if (label) label.style.display = "none";
    };
    test.onerror = () => tryNext(i + 1);
    test.src = candidates[i] + "?v=" + Date.now(); // bust cache
  }

  // if current src loads fine, keep it; otherwise fall back
  if (img.complete && img.naturalWidth > 0) {
    if (label) label.style.display = "none";
    img.style.display = "";
  } else {
    on(img, "error", () => tryNext(0), { once: true });
    // also attempt fallback immediately in case src is empty
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