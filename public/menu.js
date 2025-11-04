const menuBtn   = document.getElementById("hamburger");
const menuSheet = document.getElementById("siteMenu");
const menuClose = document.getElementById("menuClose");
const overlay   = document.getElementById("menuOverlay");

function openMenu(){
  if (!menuBtn || !menuSheet || !overlay) return;
  menuBtn.classList.add("active");
  menuBtn.setAttribute("aria-expanded","true");
  menuSheet.classList.add("open");
  menuSheet.setAttribute("aria-hidden","false");
  overlay.hidden = false;
}
function closeMenu(){
  if (!menuBtn || !menuSheet || !overlay) return;
  menuBtn.classList.remove("active");
  menuBtn.setAttribute("aria-expanded","false");
  menuSheet.classList.remove("open");
  menuSheet.setAttribute("aria-hidden","true");
  overlay.hidden = true;
}

if (menuBtn){
  menuBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    const open = menuBtn.classList.contains("active");
    open ? closeMenu() : openMenu();
  });
}
if (menuClose) menuClose.addEventListener("click", closeMenu);
if (overlay) overlay.addEventListener("click", closeMenu);

// Close on ESC
window.addEventListener("keydown", (e)=>{
  if (e.key === "Escape") closeMenu();
});
