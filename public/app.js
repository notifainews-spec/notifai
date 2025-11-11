/* NotifAi News — Frontend app (region via footer only) */

const API_BASE = window.API_BASE || location.origin;
const COVER = "/cover.jpg";
const CATS = ["us","finance","entertainment","world","crypto"];
const REGIONS = ["us","cn","pk","id","uk"];

let state = {
  region: (localStorage.getItem("region") || "us").toLowerCase(),
  category: localStorage.getItem("cat") || "us",
  data: null,
  itemsByCat: { us:[], finance:[], entertainment:[], world:[], crypto:[] },
  storyIndex: 0
};

const $  = (s,root=document)=>root.querySelector(s);
const $$ = (s,root=document)=>Array.from(root.querySelectorAll(s));

/* ---------- Helpers ---------- */
function proxyImg(u){ return u ? `/img?u=${encodeURIComponent(u)}` : COVER; }
function setNotice(text){ const n=$("#notice"); if(!n) return; if(!text){n.hidden=true;return;} n.hidden=false; n.textContent=text; }
function saveRegion(r){ try{ localStorage.setItem("region", r); }catch{} }
function saveCategory(c){ try{ localStorage.setItem("cat", c); }catch{} }

/* ---------- Region modal + footer trigger ---------- */
function openRegionModal(){
  const m = $("#regionModal"); if(!m) return;
  m.hidden = false;
}
function closeRegionModal(){
  const m = $("#regionModal"); if(!m) return;
  m.hidden = true;
}
function initRegionModal(){
  const m = $("#regionModal"); if(!m) return;

  // First visit: show if no stored region
  if (!localStorage.getItem("region")) m.hidden = false;

  m.addEventListener("click",(e)=>{
    const b = e.target.closest("button[data-region]");
    if(b){
      const r = b.getAttribute("data-region");
      if (!REGIONS.includes(r)) return;
      state.region = r; saveRegion(r);
      // if currently on "us" category and region != us, keep category as "us" (politics) but fetch region-specific politics from server
      if (!CATS.includes(state.category)) state.category = "us";
      closeRegionModal();
      loadArticles();
      return;
    }
    // click dim area to keep modal (explicit choice required)
  });

  // Footer link opens modal anytime
  $("#changeRegion")?.addEventListener("click",(e)=>{ e.preventDefault(); openRegionModal(); });
}

/* ---------- Category bar + swipe ---------- */
function initCategoryBar(){
  const catButtons = $$(".main-nav .nav-btn");
  catButtons.forEach(b=>{
    b.addEventListener("click",()=>{
      const c = b.getAttribute("data-cat");
      if(!c) return;
      state.category = c; saveCategory(c);
      highlightActiveCat(); render();
    });
  });

  // Swipe left/right anywhere to change category (mobile)
  let tsX=0, tsY=0, active=false;
  document.addEventListener("touchstart",(e)=>{
    if(!e.touches?.length) return;
    active=true; tsX=e.touches[0].clientX; tsY=e.touches[0].clientY;
  },{passive:true});
  document.addEventListener("touchend",(e)=>{
    if(!active) return; active=false;
    const t=e.changedTouches?.[0]; if(!t) return;
    const dx=t.clientX-tsX, dy=t.clientY-tsY;
    if(Math.abs(dx)>50 && Math.abs(dy)<40){
      const dir = dx>0 ? -1 : 1;
      const i   = CATS.indexOf(state.category);
      const ni  = Math.min(CATS.length-1, Math.max(0, i+dir));
      state.category = CATS[ni]; saveCategory(state.category);
      highlightActiveCat(); render();
    }
  },{passive:true});
}
function highlightActiveCat(){
  $$(".main-nav .nav-btn").forEach(b=>b.classList.remove("active"));
  const btn = $(`.main-nav .nav-btn[data-cat="${state.category}"]`);
  if(btn) btn.classList.add("active");
}

/* ---------- Fetch & render ---------- */
async function loadArticles(){
  setNotice("");
  try{
    const url = new URL(`${API_BASE}/api/articles`);
    url.searchParams.set("region", state.region);
    const res = await fetch(url.toString(), { cache:"no-store" });
    const json = await res.json();

    state.data = json;
    state.itemsByCat = json.categories || { us:[], finance:[], entertainment:[], world:[], crypto:[] };

    if(!CATS.includes(state.category)) state.category = "us";
    highlightActiveCat();

    // Auto story mode ON for mobile only
    if (matchMedia("(max-width: 720px)").matches){
      document.body.classList.remove("story-active");
      render();
    } else {
      document.body.classList.remove("story-active");
      render();
    }
  }catch(e){
    console.error(e);
    setNotice("Failed to load stories. Please try again.");
  }
}

function pickHero(list){ return list?.length ? list[0] : null; }

function render(){
  const list = state.itemsByCat[state.category] || [];
  const hero = pickHero(list);

  // Hero
  const heroEl = $("#hero");
  if (hero){
    const heroImg = $("#heroImg");
    heroImg.src = proxyImg(hero.image);
    heroImg.alt = hero.title || "";

    $("#heroLink").href   = `/article.html?id=${encodeURIComponent(hero.id)}`;
    $("#heroKicker").textContent = (state.category==='us'?'Politics':state.category).toUpperCase();
    $("#heroTitle").textContent  = hero.title || "";
    $("#heroRead").href   = `/article.html?id=${encodeURIComponent(hero.id)}`;
    heroEl.hidden = false;
  } else {
    heroEl.hidden = true;
  }

  // Grid
  const grid = $("#grid");
  grid.innerHTML = "";
  const rest = (list || []).slice(hero ? 1 : 0);

  if (!rest.length){
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No more stories yet.";
    grid.appendChild(div);
    return;
  }

  for (const a of rest){
    const card = document.createElement("a");
    card.className = "card";
    card.href = `/article.html?id=${encodeURIComponent(a.id)}`;
    card.innerHTML = `
      <div class="thumb"><img loading="lazy" src="${proxyImg(a.image)}" alt=""></div>
      <div class="info">
        <h3>${a.title || ""}</h3>
        <p class="summary">${(a.summary || "").replace(/\s+/g," ").slice(0,280)}</p>
        <div class="meta">
          <span>${a.source || ""}</span>
          <span class="read">Read more →</span>
        </div>
      </div>
    `;
    // Make the whole card clickable
    card.addEventListener("click", (e)=>{ /* anchor handles it */ });
    grid.appendChild(card);
  }
}

/* ---------- Story Mode (mobile) ---------- */
function vhMinusHeaderFooter(){
  const header = document.querySelector(".site-header");
  const footer = document.querySelector(".site-footer");
  const h = header ? header.getBoundingClientRect().height : 0;
  const f = footer ? footer.getBoundingClientRect().height : 0;
  const vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
  return Math.max(220, vh - h - f - 8);
}
function buildStoryMode(){
  const sm = $("#storyMode"); if(!sm) return;
  const list = state.itemsByCat[state.category] || [];
  state.storyIndex = 0;

  sm.style.height = `${vhMinusHeaderFooter()}px`;
  window.addEventListener("resize", ()=>{ sm.style.height = `${vhMinusHeaderFooter()}px`; });

  sm.innerHTML = "";
  if (!list.length) return;

  const renderCard = (i)=>{
    const a = list[i]; if (!a) return "";
    const img = proxyImg(a.image);
    return `
      <article class="story-card">
        <div class="story-media"><img src="${img}" alt=""></div>
        <div class="story-body">
          <div class="story-source">${a.source || ""}</div>
          <h3 class="story-title">${a.title || ""}</h3>
          <p class="story-summary">${(a.summary || "").replace(/\s+/g," ").slice(0,220)}</p>
          <div class="story-actions">
            <a class="btn" href="/article.html?id=${encodeURIComponent(a.id)}">Read summary</a>
            <a class="btn" href="${a.url}" target="_blank" rel="noopener">Full article</a>
          </div>
        </div>
      </article>
    `;
  };

  sm.innerHTML = renderCard(0);

  let startY=0;
  sm.addEventListener("touchstart",(e)=>{ startY = e.touches[0].clientY; },{passive:true});
  sm.addEventListener("touchend",(e)=>{
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dy) < 60) return;
    const dir = dy < 0 ? 1 : -1; // swipe up -> next
    const next = state.storyIndex + dir;
    if (next < 0 || next >= list.length) return;

    const animOut = dy < 0 ? "slide-out-up" : "slide-out-down";
    const animIn  = dy < 0 ? "slide-in-up"  : "slide-in-down";

    const cur = sm.firstElementChild;
    cur.classList.add(animOut);
    cur.addEventListener("animationend", ()=>{
      state.storyIndex = next;
      sm.innerHTML = renderCard(next);
      sm.firstElementChild.classList.add(animIn);
    }, { once:true });
  },{passive:true});

  $("#storyNext")?.addEventListener("click", ()=>{
    const next = state.storyIndex + 1;
    if (next >= list.length) return;
    state.storyIndex = next;
    sm.innerHTML = renderCard(next);
  });
}

/* ---------- Donate (MetaMask) ---------- */
function wireDonate(){
  const act = (e)=>{
    e.preventDefault();
    ensureEthersLoaded(async ()=>{
      if (!window.ethereum){ alert("Please install MetaMask or a compatible wallet."); return; }
      try{
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
      }catch(err){
        console.error(err);
        alert("Donation failed: " + (err?.message || err));
      }
    });
  };
  $("#donateBtn")?.addEventListener("click", act);
  $("#donateBtnFooter")?.addEventListener("click", act);
}

/* ---------- Single-logo logic (no double logos) ---------- */
(function ensureSingleLogo(){
  const brand = document.getElementById('brand');
  const img   = brand?.querySelector('.logo-img');
  if (!brand || !img) return;
  const ok = () => brand.classList.add('logo-has-img');
  const fail = () => brand.classList.remove('logo-has-img');
  if (img.complete) {
    (img.naturalWidth > 0 ? ok : fail)();
  } else {
    img.addEventListener('load', ok, { once:true });
    img.addEventListener('error', fail, { once:true });
  }
})();

/* ---------- Boot ---------- */
document.addEventListener("DOMContentLoaded", ()=>{
  initRegionModal();
  initCategoryBar();
  wireDonate();
  loadArticles();
});
