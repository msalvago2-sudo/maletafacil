// Tarjeta de WhatsApp/redes para los enlaces de agencia.
// maletafacil.com/AGENCIA/DESTINO/... (o /?agencia=AGENCIA&destino=...) → título y logo de la agencia en la vista previa.
// Si algo falla, se sirve la página normal sin tocar.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const bonito = s => { try { s = decodeURIComponent(s); } catch (e) {} return s.replace(/[-_]+/g, " ").trim().replace(/(^|\s)\S/g, l => l.toUpperCase()).slice(0, 60); };

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
    const titulo = destino ? `Tu maleta para ${esc(bonito(destino))} · Maleta Fácil` : `Maleta Fácil · ${esc(ag.nombre || slug)}`;
    const og = ag && ag.og ? (/^https?:\/\//.test(ag.og) ? ag.og : new URL(ag.og.startsWith("/") ? ag.og : "/agencias/" + ag.og, url.origin).href) : "";

    let html = await res.text();
    html = html.replace(/(<meta property="og:title" content=")[^"]*/, `$1${titulo}`)
               .replace(/(<meta name="twitter:title" content=")[^"]*/, `$1${titulo}`);
    if (og) html = html.replace(/(<meta property="og:image" content=")[^"]*/, `$1${esc(og)}`)
                       .replace(/(<meta name="twitter:image" content=")[^"]*/, `$1${esc(og)}`);
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(html, { status: res.status, headers });
  } catch (e) {
    return;
  }
};

export const config = {
  path: "/*",
  excludedPath: ["/.netlify/*", "/agencias/*", "/enlace.html", "/*.html", "/sw.js", "/manifest.json", "/*.png", "/*.jpg", "/*.jpeg", "/*.svg", "/*.ico", "/*.js", "/*.css", "/*.json", "/*.txt", "/*.xml"],
};
