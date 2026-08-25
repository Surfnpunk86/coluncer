/* =================================================================
   COLUNCER · Catálogo de productos — capa de datos compartida
   Usado por: index.html (vista previa tienda), store.html (tienda
   completa) y admin.html (panel de administración).

   Orden de carga de datos (el primero que exista, gana):
     1. localStorage "coluncer_products"  → cambios guardados desde /admin.html
        en ESTE navegador (vista previa antes de publicar).
     2. products.json                     → catálogo publicado en el sitio.
     3. DEFAULT_PRODUCTS (abajo)          → catálogo de respaldo incluido
        en el código, por si products.json no existe todavía.
   ================================================================= */

const PRODUCTS_STORAGE_KEY = "coluncer_products";

const DEFAULT_PRODUCTS = [
  {id:9, name:"Altavoz Bluetooth AQUA AQ65W", by:"Coluncer Tech", cat:"Tecnología", badge:"Nuevo", price:399000, discount:10,
    img:"images/tecnologia/altavoz-aqua-aq65w.jpg", bg:"linear-gradient(135deg,#0a0a0a,#1c1c1c)",
    desc:"Altavoz Bluetooth AQUA AQ65W con luces LED multicolor e iluminación envolvente. Diseño resistente en tela reforzada, ideal para fiestas y uso diario.",
    sourceUrl:"https://bylcolombia.com/producto/aqua7-altavoz-bluetooth/"},
  {id:10, name:"Parlante portátil BL AM-61 30W IPX7", by:"Coluncer Tech", cat:"Tecnología", badge:null, price:240000, discount:10,
    img:"images/tecnologia/parlante-bl-am61.jpg", bg:"linear-gradient(135deg,#0a0a0a,#1c1c1c)",
    desc:"Parlante portátil Bluetooth BL AM-61, 30W de potencia y certificación sumergible IPX7. Perfecto para playa, piscina o actividades al aire libre.",
    sourceUrl:"https://bylcolombia.com/producto/parlante-bluetooth-portatil-bl-am-61-30w/"},
  {id:11, name:"Parlante portátil BL AM-67 50W IPX7", by:"Coluncer Tech", cat:"Tecnología", badge:"Más vendido", price:350000, discount:10,
    img:"images/tecnologia/parlante-bl-am67.jpg", bg:"linear-gradient(135deg,#0a0a0a,#1c1c1c)",
    desc:"Parlante portátil Bluetooth BL AM-67, 50W de potencia y certificación sumergible IPX7, con asa de transporte reforzada. Mayor sonido y autonomía para exteriores.",
    sourceUrl:"https://bylcolombia.com/producto/parlante-bluetooth-portatil-bl-am-67-50w/"},
];

function copFmt(n){ return "$" + Math.round(n).toLocaleString("es-CO"); }
function discPrice(p){ return Math.round(p.price * (1 - (p.discount||0)/100)); }

/* Carga el catálogo siguiendo el orden descrito arriba. Siempre devuelve un array. */
async function loadProducts(){
  try{
    const local = localStorage.getItem(PRODUCTS_STORAGE_KEY);
    if(local){
      const parsed = JSON.parse(local);
      if(Array.isArray(parsed) && parsed.length) return parsed;
    }
  }catch(e){ /* localStorage no disponible o dato corrupto: seguimos */ }

  try{
    const res = await fetch("products.json", {cache:"no-store"});
    if(res.ok){
      const data = await res.json();
      if(Array.isArray(data) && data.length) return data;
    }
  }catch(e){ /* products.json no existe o falló la carga: seguimos */ }

  return DEFAULT_PRODUCTS;
}
