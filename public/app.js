<script>
/* NotifAi News — Frontend app (scrolling on mobile, swipe to change category) */

const API_BASE = window.API_BASE || location.origin;
const COVER = "/cover.jpg";
const CATS = ["us", "finance", "entertainment", "world", "crypto"];
const REGIONS = ["us", "cn", "pk", "id", "uk"];

let state = {
  region: (localStorage.getItem("region") || "us").toLowerCase(),
  category: localizeCat(localStorage.getItem("cat") || "us"),
  data: null,
  itemsByCat: { us: [], finance: [], entertainment: [], world: [], crypto: [] }
};

function localizeCat(c){ return CATS.includes(c) ? c : "us"; }

const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

/* ---------- Helpers ---------- */
function proxyImg(u) {
  return u ? `/img?u=${encodeURIComponent(u)}` : COVER;
}
function setNotice(text) {
  const n = $("#notice");
  if (!n) return;
  if (!text) { n.hidden = true; n.textContent = ""; return; }
  n.hidden = false;
  n.textContent = text;
}
function saveRegion(r) { try { localStorage.setItem("region", r); } catch {} }
function saveCategory(c) { try { localStorage.setItem("cat", c); } catch {} }

/* ---------- Region modal + footer trigger ---------- */
function openRegionModal() {
  const m = $("#regionModal");
  if (!m) return;
  m.hidden = false;                 // <-- use attribute, not just a CSS class
  m.classList.add("show");          // optional styling hook
}
function closeRegionModal() {
  const m = $("#regionModal");
  if (!m) return;
  m.classList.remove("show");
  m.hidden = true;                  // <-- actually hide the modal
}
function initRegionModal() {
  const m = $("#regionModal");
  if (!m) return;

  // Show on first visit only (no region saved yet)
  if (!localStorage.getItem("region")) {
    m.hidden = false;
    m.classList.add("show");
  } else {
    m.hidden = true;
    m.classList.remove("show");
  }

  // Choose region by clicking one of the buttons
  m.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-region]");
    if (!b) return;
    const r = b.getAttribute("data-region");
    if (!REGIONS.includes(r)) return;
    state.region = r;
    saveRegion(r);
    if (!CATS.includes(state.category)) state.category = "us";
    closeRegionModal();
    loadArticles();                 // re-fetch with new region
  });

  // Footer "Change Region" link opens the modal
  $("#changeRegion")?.addAction("click", (e) => {
    e.preventDefault();
    openRegionModal();
  });

  // Click outside the inner card closes the modal
  m.addEventListener("mousedown", (e) => {
    if (e.target === m) closeRegionModal();
  });
}

/* helper: addEventListener shorthand with passive=false by default */
EventTarget.prototype.addAction = function(type, handler, opts){ 
  this.addEventListener(type, handler, opts || false);
};

/* ---------- Category bar + swipe ---------- */
function initCategoryBar() {
  const catButtons = $$(".main-nav .nav-btn");
  catButtons.forEach((b) => {
    b.addAction("click", () => {
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
  document.addEventListener("touchstart", (e) => {
    if (!e.touches?.length) return;
    active = true;
    tsX = e.touches[0].clientX;
    tsY = e.touches[0].clientY;
  }, {passive:true});

  document.addEventListener("touchend", (e) => {
    if (!active) return;
    active = false;
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - tsX;
    const dy = t.clientY - tsY;
    if (Math.abs(dx) > 50 && Math.abs(dy) < 40) {
      const dir = dx > 0 ? -1 : 1;
      const i = CATS.indexOf(state.category);
      const ni = Math.min(CATS.length - 1, Math.max(0, i + dir));
      state.category = CATS[ni];
      saveCategory(state.category);
      highlightActiveCat();
      render();
    }
  }, {passive:true});
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
    state.itemsByCat = json.categories || { us: [], finance: [], entertainment: [], world: [], crypto: [] };

    if (!CATS.includes(state.category)) state.category = "us";
    highlightActiveCat();

    render();
  } catch (e) {
    console.error(e);
    setNotice("Failed to load stories. Please try again.");
  }
}

function pickHero(list) { return list && list.length ? list[0] : null; }

function render() {
  const list = state.itemsByCat[state.category] || [];
  const hero = pickHero(list);

  /* HERO — fill existing DOM nodes from index.html and toggle 'hidden' */
  const heroSection = $("#hero");
  if (heroSection) {
    if (hero) {
      const link  = $("#heroLink");
      const img   = $("#heroImg");
      const title = $("#heroTitle");
      const kicker= $("#heroKicker");
      const read  = $("#heroRead");

      if (link)  link.href  = `./article.html?id=${encodeURIComponent(hero.id)}`;
      if (img)   { img.src = proxyImg(hero.image); img.alt = hero.title || "Top story"; }
      if (title) title.textContent = hero.title || "";
      if (kicker) kicker.textContent = (hero.source || "Top story");
      if (read)  read.href = `./article.html?id=${encodeURIComponent(hero.id)}`;

      heroSection.hidden = false;   // <-- actually show hero
    } else {
      // no hero -> hide the section
      heroSection.hidden = true;
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
  if (window.ethers) { cb(); return; }
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js";
  s.onload = cb;
  document.head.appendChild(s);
}
function wireDonate() {
  const handler = (e) => {
    e.preventDefault();
    ensureEthersLoaded(async () => {
      if (!window.ethereum) { alert("Please install MetaMask or a compatible wallet."); return; }
      try {
        const provider = new ethers.providers.Web3Provider(window.ethereum);
        await provider.send("eth_requestAccounts", []);
        const signer = provider.getSigner();
        const CONTRACT = "0x6a98b87f8116678ed98f74ae9a638bf30ebf3846";
        const tx = await signer.sendTransaction({ to: CONTRACT, value: ethers.utils.parseEther("0.01") });
        await tx.wait();
        alert("Thank you for your donation!");
      } catch (err) {
        console.error(err); alert("Donation failed: " + (err?.message || err));
      }
    });
  };
  $("#donateBtn")?.addAction("click", handler);
  $("#donateBtnFooter")?.addAction("click", handler);
}

/* ---------- Single-logo guard (prevents double logo text+img) ---------- */
(function ensureSingleLogo() {
  const brand = $("#brand");
  if (!brand) return;
  const img = brand.querySelector(".logo-img");
  const label = brand.querySelector(".logo-text");
  if (!img || !label) return;
  function update() {
    if (img.naturalWidth > 0) {
      label.style.display = "none";
      img.style.display = "";
    } else {
      label.style.display = "inline-block";
      img.style.display = "none";
    }
  }
  if (img.complete) { update(); }
  img.addEventListener("load", update, { once: true });
  img.addEventListener("error", update, { once: true });
})();

/* ---------- Boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initRegionModal();
  initCategoryBar();
  wireDonate();
  loadArticles();
});
</script>