/* COLUNCER · animaciones del tema espacial (aparición al desplazarse + hero que se desvanece).
   Si este archivo falla, la página se ve igual, solo sin animaciones. */
(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) return;
  root.classList.add("tj");

  function init() {
    var sel = [
      ".about .eyebrow", ".about h2", ".about p", ".chips", ".pl",
      ".sh", ".sc", ".step", ".hint",
      ".shophead", ".pc", ".store-cta",
      ".model .eyebrow", ".model h2", ".mc",
      ".clients h2", ".lr",
      ".contact .eyebrow", ".contact h2", ".contact .ci", ".cbox",
      ".stats .si", ".hvc",
      ".rcount", ".filters", ".card"
    ].join(",");
    var els = [].slice.call(document.querySelectorAll(sel)).filter(function (e) {
      return !e.closest(".pmodal,.drawer,.hero h1") && !e.classList.contains("rv");
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });

    var lastParent = null, n = 0;
    els.forEach(function (e) {
      if (e.parentNode !== lastParent) { lastParent = e.parentNode; n = 0; }
      e.style.setProperty("--td", Math.min(n++, 5) * 0.08 + "s");
      e.classList.add("rvx");
      io.observe(e);
    });
    /* Red de seguridad: nada se queda invisible si el observador no dispara */
    setTimeout(function () {
      els.forEach(function (e) { if (!e.classList.contains("in")) { var r = e.getBoundingClientRect(); if (r.top < innerHeight) e.classList.add("in"); } });
    }, 1800);

    /* Hero: se desvanece y se aleja suavemente al bajar, como en las páginas de Apple */
    var hero = document.querySelector(".hero");
    if (hero) {
      var ticking = false;
      var upd = function () {
        var p = Math.min(1, Math.max(0, scrollY / (hero.offsetHeight * 0.75)));
        hero.style.setProperty("--hp", p.toFixed(3));
        ticking = false;
      };
      addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(upd); } }, { passive: true });
      upd();
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
