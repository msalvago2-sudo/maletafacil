// Tarjeta de WhatsApp/redes para los enlaces de agencia.
// maletafacil.com/AGENCIA/DESTINO/... (o /?agencia=AGENCIA&destino=...) → título y logo de la agencia en la vista previa.
// Si algo falla, se sirve la página normal sin tocar.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const bonito = s => { try { s = decodeURIComponent(s); } catch (e) {} return s.split(",")[0].replace(/[-_]+/g, " ").trim().replace(/(^|\s)\S/g, l => l.toUpperCase()).slice(0, 60); };

// Plan Pro: los colores de la agencia van ya dentro de la página, para que no se vea primero el verde de Maleta Fácil
const colores = (hex, fondo) => {
  const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b), l = (mx+mn)/2; let h = 0, sat = 0;
  if (mx !== mn) { const d = mx-mn; sat = l > .5 ? d/(2-mx-mn) : d/(mx+mn); h = mx===r ? (g-b)/d+(g<b?6:0) : mx===g ? (b-r)/d+2 : (r-g)/d+4; h *= 60; }
  const H = Math.round(h), S = Math.round(Math.min(sat,.75)*100), SF = Math.min(S,55), SB = Math.max(S,35);
  const f = /^#[0-9a-f]{6}$/i.test(fondo || "") ? fondo : `hsl(${H},${SF}%,15%)`;
  return { css: `:root{--teal-900:${f};--teal-700:hsl(${H},${SB}%,30%);--teal-500:hsl(${H},${SB}%,40%);--rust:${hex};--mustard:hsl(${H},${SB}%,36%)}`, fondo: f };
};

export default async (req, context) => {
  try {
    const url = new URL(req.url);
    const seg = url.pathname.split("/").filter(Boolean);
    let slug = "", destino = "";
    if (seg.length >= 2 && /^[a-z0-9-]+$/i.test(seg[0])) { slug = seg[0].toLowerCase(); destino = seg[1]; }
    else if (seg.length === 1 && url.pathname !== "/index.html") { destino = seg[0]; }          // maletafacil.com/roma
    else { slug = (url.searchParams.get("agencia") || "").toLowerCase(); destino = url.searchParams.get("destino") || ""; }
    if (slug && !/^[a-z0-9-]+$/.test(slug)) slug = "";
    if (!slug && !destino) return; // portada normal: se queda con sus etiquetas

    const [res, lista] = await Promise.all([
      context.next(),
      slug ? fetch(new URL("/.netlify/functions/agencias", url.origin)).then(r => r.ok ? r.json() : {}).catch(() => ({})) : {},
    ]);
    if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
    const ag = slug ? lista[slug] : null;
    if (!ag && !destino) return res;

    // Con agencia: su logo va en la imagen y en la firma del mensaje; el título lleva la marca Maleta Fácil
    // Plan Pro: la marca de la agencia sustituye a la de Maleta Fácil también en la vista previa de WhatsApp
    const marca = ag && ag.plan === "pro" ? esc(ag.nombre || slug) : "Maleta Fácil";
    const titulo = destino ? `Tu maleta para ${esc(bonito(destino))} · ${marca}` : (ag && ag.plan === "pro" ? `Tu maleta en un minuto · ${marca}` : `Maleta Fácil · ${esc(ag.nombre || slug)}`);
    const og = ag && ag.og ? (/^https?:\/\//.test(ag.og) ? ag.og : new URL(ag.og.startsWith("/") ? ag.og : "/agencias/" + ag.og, url.origin).href) : "";

    let html = await res.text();
    html = html.replace(/(<meta property="og:title" content=")[^"]*/, `$1${titulo}`)
               .replace(/(<meta name="twitter:title" content=")[^"]*/, `$1${titulo}`);
    if (og) html = html.replace(/(<meta property="og:image" content=")[^"]*/, `$1${esc(og)}`)
                       .replace(/(<meta name="twitter:image" content=")[^"]*/, `$1${esc(og)}`);
    if (ag) {
      // Los datos de la agencia van dentro de la página (la web no tiene que pedirlos) y el logo se empieza a bajar ya
      const datos = JSON.stringify({ slug, ...ag }).replace(/</g, "\\u003c");
      const logo = !ag.logo ? "" : (/^(\/|https:\/\/)/.test(ag.logo) ? ag.logo : "/agencias/" + encodeURIComponent(ag.logo));
      let extra = `<script>window.__MF_AG=${datos}</script>`;
      if (logo) extra += `<link rel="preload" as="image" href="${esc(logo)}">`;
      if (ag.plan === "pro" && /^#[0-9a-f]{6}$/i.test(ag.color || "")) {
        const c = colores(ag.color, ag.fondo);
        extra += `<style id="colorAgencia">${c.css}</style>`;
        html = html.replace(/(<meta name="theme-color" content=")[^"]*/, `$1${c.fondo}`);
      }
      html = html.replace("</head>", extra + "</head>");
    }
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(html, { status: res.status, headers });
  } catch (e) {
    return;
  }
};

export const config = {
  path: "/*",
  excludedPath: ["/.netlify/*", "/agencias/*", "/que-llevar/*", "/enlace.html", "/*.html", "/sw.js", "/manifest.json", "/*.png", "/*.jpg", "/*.jpeg", "/*.svg", "/*.ico", "/*.js", "/*.css", "/*.json", "/*.txt", "/*.xml"],
};
