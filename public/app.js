/* NotifAi News — Frontend app (scrolling on mobile, swipe to change category) */

const API_BASE = window.API_BASE || location.origin;
const COVER = "/cover.jpg";
const CATS = ["us", "finance", "entertainment", "world", "crypto"];
const REGIONS = ["us", "cn", "pk", "id", "uk"];

let state = {
  region: (localStorage.getItem("region") || "us").toLowerCase(),
  category: localStorage.getItem("cat") || "us",
  data: null,
  itemsByCat: { us: [], finance: [], entertainment: [], world: [], crypto: [] }
};

const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

/* ---------- Helpers ---------- */
function proxyImg(u) {
  return u ? `/img?u=${encodeURIComponent(u)}` : COVER;
}
function setNotice(text) {
  const n = $("#notice");
  if (!n) return;
  if (!text) {
    n.hidden = true;
    return;
  }
  n.hidden = false;
  n.textContent = text;
}
function saveRegion(r) { try { localStorage.setItem("region", r); } catch {} }
function saveCategory(c) { try { localStorage.setItem("cat", c); } catch {} }

/* ---------- Region modal + footer trigger ---------- */
function openRegionModal() {
  $("#regionModal")?.classList.remove("hidden");
}
function closeRegionModal() {
  $("#regionModal")?.classList.add("hidden");
}
function initRegionModal() {
  const m = $("#regionModal");
  if (!m) return;

  // First visit: show if no stored region
  if (!localStorage.getItem("region")) m.classList.remove("hidden");

  // Click handler for country buttons
  m.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-region]");
    if (b) {
      const r = b.getAttribute("data-region");
      if (!REGIONS.includes(r)) return;
      state.region = r;
      saveRegion(r);
      if (!CATS.includes(state.category)) state.category = "us";
      closeRegionModal();
      loadArticles();
    }
  });

  // Footer link opens modal
  $("#changeRegion")?.addEventListener("click", (e) => {
    e.preventDefault();
    openRegionModal();
  });
}

/* ---------- Category bar + swipe ---------- */
function initCategoryBar() {
  const catButtons = $$(".main-nav .nav-btn");
  catButtons.forEach((b) => {
    b.addEventListener("click", () => {
      const c = b.getAttribute("data-cat");
      if (!c) return;
      state.category = c;
      saveCategory(c);
      highlightActiveCat();
      render();
    });
  });

  // Mobile: swipe left/right anywhere to change category
  let tsX = 0, tsY = 0, active = false;
  document.addEventListener(
    "touchstart",
    (e) => {
      if (!e.touches?.length) return;
      active = true;
      tsX = e.touches[0].clientX;
      tsY = e.touches[0].clientY;
    },
    { passive: true }
  );
  document.addEventListener(
    "touchend",
    (e) => {
      if (!active) return;
      active = false;
      const t = e.changedTouches?.[0];
      if (!t) return;
      const dx = t.clientX - tsX;
      const dy = t.clientY - tsY;
      // Horizontal intent only
      if (Math.abs(dx) > 50 && Math.abs(dy) < 40) {
        const dir = dx > 0 ? -1 : 1;
        const i = CATS.indexOf(state.category);
        const ni = Math.min(CATS.length - 1, Math.max(0, i + dir));
        state.category = CATS[ni];
        saveCategory(state.category);
        highlightActiveCat();
        render();
      }
    },
    { passive: true }
  );
}
function highlightActiveCat() {
  $$(".main-nav .nav-btn").forEach((b) => b.classList.remove("active"));
  const btn = $(`.main-nav .nav-btn[data-cat="${state.category}"]`);
  if (btn) btn.classList.add("active");
}

/* ---------- Fetch & render ---------- */
async function loadArticles() {
  setNotice("");
  try {
    const url = new URL(`${API_BASE}/api/articles`);
    url.searchParams.set("region", state.region);
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    state.data = json;
    state.itemsByCat =
      json.categories || { us: [], finance: [], entertainment: [], world: [], crypto: [] };

    if (!CATS.includes(state.category)) state.category = "us";
    highlightActiveCat();

    // Always render in scrolling mode (desktop + mobile)
    document.body.classList.remove("story-active");
    render();
  } catch (e) {
    console.error(e);
    setNotice("Failed to load stories. Please try again.");
  }
}

function pickHero(list) {
  return list?.length ? list[0] : null;
}

function render() {
  const list = state.itemsByCat[state.category] || [];
  const hero = pickHero(list);

  /* HERO */
  const heroEl = $("#hero");
  if (heroEl) {
    if (hero) {
      // Clean overlay layout for mobile & desktop
      heroEl.innerHTML = `
        <a class="hero-card" href="article.html?id=${encodeURIComponent(hero.id)}" aria-label="${hero.title}">
          <img class="hero-img" src="${proxyImg(hero.image)}" alt="">
          <div class="hero-gradient"></div>
          <div class="hero-copy">
            <span class="hero-source">${hero.source || ""}</span>
            <h2 class="hero-title">${hero.title || ""}</h2>
            <p class="hero-summary">${(hero.summary || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 160)}</p>
          </div>
        </a>
      `;
    } else {
      heroEl.innerHTML = "";
    }
  }

  /* GRID */
  const grid = $("#grid");
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
        <p class="summary">${(a.summary || "").replace(/\s+/g, " ").slice(0, 220)}</p>
        <div class="meta">
          <span>${a.source || ""}</span>
          <span class="read">Read more →</span>
        </div>
      </div>
    `;
    grid.appendChild(card);
  }
}

/* ---------- Donate (MetaMask) ---------- */
function ensureEthersLoaded(cb) {
  if (window.ethers) {
    cb();
    return;
  }
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js";
  s.onload = cb;
  document.head.appendChild(s);
}
function wireDonate() {
  const act = (e) => {
    e.preventDefault();
    ensureEthersLoaded(async () => {
      if (!window.ethereum) {
        alert("Please install MetaMask or a compatible wallet.");
        return;
      }
      try {
        const provider = new ethers.providers.Web3Provider(window.ethereum);
        await provider.send("eth_requestAccounts", []);
        const signer = provider.getSigner();

        const CONTRACT = "0x6a98b87f8116678ed98f74ae9a638bf30ebf3846";
        const tx = await signer.sendTransaction({
          to: CONTRACT,
          value: ethers.utils.parseEther("0.01")
        });
        await tx.wait();
        alert("Thank you for your donation!");
      } catch (err) {
        console.error(err);
        alert("Donation failed: " + (err?.message || err));
      }
    });
  };
  $("#donateBtn")?.addEventListener("click", act);
  $("#donateBtnFooter")?.addEventListener("click", act);
}

/* ---------- Single-logo guard (prevents double logo text+img) ---------- */
(function ensureSingleLogo() {
  const brand = document.getElementById("brand");
  const img = brand?.querySelector(".logo-img");
  if (!brand || !img) return;
  const ok = () => brand.classList.add("logo-has-img");
  const fail = () => brand.classList.remove("logo-has-img");
  if (img.complete) {
    (img.naturalWidth > 0 ? ok : fail)();
  } else {
    img.addEventListener("load", ok, { once: true });
    img.addEventListener("error", fail, { once: true });
  }
})();

/* ---------- Boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initRegionModal();
  initCategoryBar();
  wireDonate();
  loadArticles();
});