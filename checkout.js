/* COLUNCER · datos de envío ANTES del pago.
   Uso:  const customer = await CheckoutShip.ask({ lines:["1x Producto — $390.000"], total:390000 });
         → devuelve el objeto del cliente, o null si cancela. Después se abre Wompi. */
(function () {
  var KEY = "coluncer_ship";
  var DEPS = ["Amazonas","Antioquia","Arauca","Atlántico","Bogotá D.C.","Bolívar","Boyacá","Caldas","Caquetá","Casanare","Cauca","Cesar","Chocó","Córdoba","Cundinamarca","Guainía","Guaviare","Huila","La Guajira","Magdalena","Meta","Nariño","Norte de Santander","Putumayo","Quindío","Risaralda","San Andrés y Providencia","Santander","Sucre","Tolima","Valle del Cauca","Vaupés","Vichada"];
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var cop = function (n) { return "$" + Math.round(n).toLocaleString("es-CO"); };

  var css = ".cs-ov{position:fixed;inset:0;z-index:100000;background:rgba(15,16,24,.6);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:none;align-items:center;justify-content:center;padding:14px}" +
    ".cs-ov.on{display:flex}" +
    ".cs-box{background:#fff;color:#15171F;width:100%;max-width:560px;max-height:calc(100dvh - 28px);overflow:auto;border-radius:28px;padding:30px 28px;font-family:'Inter',system-ui,sans-serif;box-shadow:0 40px 100px -30px rgba(0,0,0,.6)}" +
    ".cs-box h2{font-size:1.5rem;font-weight:700;letter-spacing:-.03em;line-height:1.1;margin:0 0 6px;font-family:inherit}" +
    ".cs-sub{color:#6E707A;font-size:.9rem;line-height:1.5;margin:0 0 16px}" +
    ".cs-sum{background:#F4F5F1;border:1px solid #E7E8E2;border-radius:16px;padding:12px 16px;font-size:.85rem;margin-bottom:18px}" +
    ".cs-sum div{display:flex;justify-content:space-between;gap:10px;padding:2px 0;color:#54545A}.cs-sum .t{font-weight:700;color:#15171F;border-top:1px solid #E7E8E2;margin-top:6px;padding-top:8px}" +
    ".cs-g{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cs-g .f{grid-column:1/-1}" +
    "@media(max-width:520px){.cs-g{grid-template-columns:1fr}.cs-box{padding:24px 18px;border-radius:24px}}" +
    ".cs-box label{display:block;font-size:.76rem;font-weight:700;color:#54545A;margin-bottom:5px}" +
    ".cs-box input,.cs-box select,.cs-box textarea{width:100%;padding:12px 13px;border:1px solid #E7E8E2;border-radius:12px;font:inherit;font-size:.92rem;background:#fff;color:#15171F;box-sizing:border-box}" +
    ".cs-box input:focus,.cs-box select:focus,.cs-box textarea:focus{outline:2px solid #6B46E3;outline-offset:1px;border-color:#6B46E3}" +
    ".cs-box textarea{resize:vertical;min-height:64px}" +
    ".cs-ok{display:flex;gap:10px;align-items:flex-start;font-size:.8rem;color:#54545A;line-height:1.45;font-weight:500}.cs-ok input{width:18px;height:18px;margin-top:2px;flex:none;accent-color:#6B46E3}" +
    ".cs-err{color:#C0392B;font-size:.84rem;margin-top:12px;display:none;font-weight:600}" +
    ".cs-btns{display:flex;gap:10px;margin-top:20px}.cs-btns button{flex:1;padding:15px 18px;border-radius:100px;border:0;font:inherit;font-weight:700;font-size:.95rem;cursor:pointer}" +
    ".cs-cancel{background:#F4F5F1;color:#15171F;flex:0 0 auto!important}.cs-go{background:#C6ED2E;color:#15171F}.cs-go:hover{background:#d6f64c}" +
    ".cs-note{font-size:.76rem;color:#6E707A;margin-top:12px;text-align:center}";

  var built = false, ov, resolver = null, order = null;

  function field(id, label, extra, cls) {
    return '<div' + (cls ? ' class="' + cls + '"' : "") + '><label for="cs_' + id + '">' + label + '</label>' + extra + "</div>";
  }
  function build() {
    if (built) return; built = true;
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    ov = document.createElement("div"); ov.className = "cs-ov"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-labelledby", "cs_title");
    ov.innerHTML = '<form class="cs-box" id="cs_form" novalidate>' +
      '<h2 id="cs_title">¿A dónde enviamos tu pedido?</h2>' +
      '<p class="cs-sub">Primero tus datos de envío; en el siguiente paso pagas de forma segura con Wompi.</p>' +
      '<div class="cs-sum" id="cs_sum"></div>' +
      '<div class="cs-g">' +
      field("nombre", "Nombre completo *", '<input id="cs_nombre" autocomplete="name" maxlength="120" required>', "f") +
      field("doc", "Cédula / documento *", '<input id="cs_doc" inputmode="numeric" autocomplete="off" maxlength="20" required>') +
      field("tel", "Celular / WhatsApp *", '<input id="cs_tel" type="tel" inputmode="tel" autocomplete="tel" placeholder="3001234567" maxlength="20" required>') +
      field("mail", "Correo electrónico (para tu recibo)", '<input id="cs_mail" type="email" autocomplete="email" maxlength="120">', "f") +
      field("dep", "Departamento *", '<select id="cs_dep" autocomplete="address-level1" required><option value="">Selecciona…</option>' + DEPS.map(function (d) { return "<option>" + esc(d) + "</option>"; }).join("") + "</select>") +
      field("ciu", "Ciudad / municipio *", '<input id="cs_ciu" autocomplete="address-level2" maxlength="80" required>') +
      field("dir", "Dirección de entrega *", '<input id="cs_dir" autocomplete="street-address" maxlength="200" placeholder="Calle / carrera, número, torre, apto…" required>', "f") +
      field("barrio", "Barrio / indicaciones adicionales", '<textarea id="cs_barrio" maxlength="300" placeholder="Barrio, punto de referencia, horario para recibir…"></textarea>', "f") +
      '<div class="f"><label class="cs-ok"><input type="checkbox" id="cs_ok"> Autorizo a COLUNCER a usar estos datos únicamente para gestionar el envío de mi pedido. *</label></div>' +
      "</div>" +
      '<p class="cs-err" id="cs_err" role="alert"></p>' +
      '<div class="cs-btns"><button type="button" class="cs-cancel" id="cs_cancel">Cancelar</button><button type="submit" class="cs-go" id="cs_go">Continuar al pago →</button></div>' +
      '<p class="cs-note">🔒 Pago seguro con Wompi. Tus datos solo se usan para el envío.</p>' +
      "</form>";
    document.body.appendChild(ov);
    ov.addEventListener("mousedown", function (e) { if (e.target === ov) finish(null); });
    document.getElementById("cs_cancel").onclick = function () { finish(null); };
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && ov.classList.contains("on")) finish(null); });
    document.getElementById("cs_form").addEventListener("submit", submit);
  }
  var g = function (id) { return document.getElementById("cs_" + id).value.trim(); };

  function submit(e) {
    e.preventDefault();
    var err = document.getElementById("cs_err"); err.style.display = "none";
    var tel = g("tel").replace(/\D/g, ""), mail = g("mail");
    var problem = ["nombre", "doc", "tel", "dep", "ciu", "dir"].some(function (k) { return !g(k); }) ? "Completa los campos marcados con *."
      : g("nombre").length < 3 ? "Escribe tu nombre completo."
      : (tel.length < 10 || tel.length > 12) ? "Revisa tu número de celular (10 dígitos)."
      : (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) ? "Revisa tu correo electrónico."
      : !document.getElementById("cs_ok").checked ? "Debes autorizar el uso de tus datos para gestionar el envío."
      : "";
    if (problem) { err.textContent = problem; err.style.display = "block"; return; }
    var c = { nombre: g("nombre"), doc: g("doc"), tel: g("tel"), mail: mail, dep: g("dep"), ciu: g("ciu"), dir: g("dir"), barrio: g("barrio") };
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (x) {}   // para no volver a escribirlos la próxima vez
    finish(c);
  }
  function finish(value) {
    ov.classList.remove("on");
    var r = resolver; resolver = null;
    if (r) r(value);
  }

  window.CheckoutShip = {
    ask: function (o) {
      build();
      order = o || {};
      document.getElementById("cs_sum").innerHTML = (order.lines || []).map(function (l) { return "<div><span>" + esc(l) + "</span></div>"; }).join("") +
        '<div class="t"><span>Total a pagar</span><span>' + cop(order.total || 0) + "</span></div>";
      var saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (x) {}
      ["nombre", "doc", "tel", "mail", "dep", "ciu", "dir", "barrio"].forEach(function (k) { document.getElementById("cs_" + k).value = saved[k] || ""; });
      document.getElementById("cs_ok").checked = false;
      document.getElementById("cs_err").style.display = "none";
      ov.classList.add("on");
      setTimeout(function () { var f = document.getElementById("cs_nombre"); if (f) f.focus(); }, 50);
      return new Promise(function (resolve) { if (resolver) resolver(null); resolver = resolve; });
    }
  };
})();
