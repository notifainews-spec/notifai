// article.js — NotifAi article view
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

// clickable hero + full source link
const sourceLinkImage = document.getElementById("sourceLinkImage");
const fullLink = document.getElementById("fullLink");

// share buttons
const shareWa = document.getElementById("share-wa");
const shareX  = document.getElementById("share-x");
const shareFb = document.getElementById("share-fb");

// language
const LANG_KEY = "notifai_lang";
const DEFAULT_LANG = "en";
function currentLang(){ return localStorage.getItem(LANG_KEY) || DEFAULT_LANG; }
function setLang(l){ localStorage.setItem(LANG_KEY, l); }

if (!id) {
  if (titleEl) titleEl.textContent = "Article not found";
} else {
  load();
}

async function translateBatch(target, items){
  if (target === "en") return items;
  const res = await fetch(`${API_BASE}/api/translate`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ target, items })
  });
  const j = await res.json();
  return Array.isArray(j.items) ? j.items : items;
}

async function load() {
  try {
    const res = await fetch(`${API_BASE}/api/article/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`article ${res.status}`);
    const a = await res.json();

    const debate = a.debateJson ? JSON.parse(a.debateJson) : {};
    const lang = currentLang();

    const srcTexts = [
      a.title || "(untitled)",
      a.summary || "",
      debate?.socialist?.open  || "",
      debate?.rightwing?.open  || "",
      debate?.conspiracy?.open || ""
    ];

    let translated = srcTexts;
    if (lang !== "en") {
      try {
        translated = await translateBatch(lang, srcTexts);
      } catch (e) {
        console.warn("Translation failed", e);
      }
    }

    const [tTitle, tSummary, tSoc, tRight, tCons] = translated;

    const sourceUrl = a.url;
    const title = tTitle;
    if (titleEl) titleEl.textContent = title;
    if (sourceEl) sourceEl.textContent = a.source || "";
    if (whenEl) whenEl.textContent = a.publishedAt ? new Date(a.publishedAt).toLocaleString() : "";

    // image + links to source
    const img = toProxy(a.image);
    if (heroEl) heroEl.src = img;
    if (sourceLinkImage) sourceLinkImage.href = sourceUrl;
    if (fullLink) fullLink.href = sourceUrl;

    // summary
    if (summaryEl) summaryEl.textContent = tSummary || "";

    // voices
    if (vS) vS.textContent = tSoc || "—";
    if (vR) vR.textContent = tRight || "—";
    if (vC) vC.textContent = tCons || "—";

    // SHARE: share NotifAi article page (drives traffic to your site)
    const shareUrl  = `${API_BASE}/share/${encodeURIComponent(id)}`;
    const shareText = `${title} — NotifAi News`;

    if (shareWa) shareWa.href = `https://wa.me/?text=${encodeURIComponent(shareText + " " + shareUrl)}`;
    if (shareX)  shareX.href  = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`;
    if (shareFb) shareFb.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;

    // Apply RTL for Arabic
    if (lang === "ar") document.documentElement.setAttribute("dir","rtl");
    else document.documentElement.removeAttribute("dir");

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

// Language select wiring (desktop or mobile)
(function(){
  const sel = document.querySelector("#langSelect, #langSelectArticleMobile");
  if (!sel) return;
  const lang = currentLang();
  sel.value = lang;

  // RTL for Arabic
  if (lang === "ar") document.documentElement.setAttribute("dir","rtl");
  else document.documentElement.removeAttribute("dir");

  sel.addEventListener("change", ()=>{
    setLang(sel.value);
    if (sel.value === "ar") document.documentElement.setAttribute("dir","rtl");
    else document.documentElement.removeAttribute("dir");
    location.reload();
  });
})();
