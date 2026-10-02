// Agencias de Maleta Fácil: lista (pública) y alta/edición/baja (solo con contraseña).
// - GET  /.netlify/functions/agencias            → todas las agencias (agencias.json + las creadas desde la herramienta)
// - GET  /.netlify/functions/agencias?logo=SLUG  → logo subido desde la herramienta
// - POST /.netlify/functions/agencias            → {token|clave, accion:'login'|'guardar'|'borrar'|..., ...}
// Accesos: el administrador entra con MF_ADMIN_CLAVE; cada agencia entra con su email y su contraseña
// (guardada cifrada con scrypt; nadie puede leerla, solo cambiarla).
import { getStore } from "@netlify/blobs";
import { createHmac, scryptSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/* ---------- Accesos y sesiones ---------- */
const SECRETO = () => process.env.MF_TOKEN_SECRET || process.env.MF_ADMIN_CLAVE || "";
const cuentas = () => getStore({ name: "cuentas", consistency: "strong" });
const hashClave = (pw, sal) => scryptSync(String(pw), sal, 32).toString("hex");
const normEmail = e => String(e || "").trim().toLowerCase().slice(0, 120);
const esEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
function firmarToken(d) { const p = Buffer.from(JSON.stringify({ ...d, x: Date.now() + 180 * 864e5 })).toString("base64url"); return p + "." + createHmac("sha256", SECRETO()).update(p).digest("base64url"); }
// ¿Quién hace la petición? → {rol:'admin'} | {rol:'agencia', slug, email} | null
export async function quien(body) {
  const adm = process.env.MF_ADMIN_CLAVE;
  if (adm && typeof body.clave === "string" && body.clave === adm) return { rol: "admin" };
  const [p, f] = String(body.token || "").split(".");
  if (!p || !f || !SECRETO()) return null;
  const bueno = createHmac("sha256", SECRETO()).update(p).digest("base64url");
  if (bueno.length !== f.length || !timingSafeEqual(Buffer.from(bueno), Buffer.from(f))) return null;
  let d; try { d = JSON.parse(Buffer.from(p, "base64url").toString()); } catch (e) { return null; }
  if (!d.x || d.x < Date.now()) return null;
  if (d.r === "admin") return { rol: "admin" };
  const u = await cuentas().get("u:" + d.e, { type: "json" });
  if (!u || u.bloqueada || u.slug !== d.s || u.v !== d.v) return null;
  return { rol: "agencia", slug: d.s, email: d.e };
}
const PALABRAS = ["Maleta", "Viaje", "Playa", "Brujula", "Mapa", "Isla", "Tren", "Barco", "Sol", "Luna", "Monte", "Puerto", "Faro", "Ruta", "Nube", "Palma"];
const claveNueva = () => `${PALABRAS[randomInt(16)]}-${PALABRAS[randomInt(16)]}-${randomInt(100, 1000)}`;

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const slugify = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const limpio = (s, max = 300) => String(s || "").trim().slice(0, max);
const espera = ms => new Promise(r => setTimeout(r, ms));

export default async (req) => {
  const url = new URL(req.url);
  const store = getStore({ name: "agencias", consistency: "strong" });

  if (req.method === "GET") {
    const og = url.searchParams.get("og");
    const logo = url.searchParams.get("logo") || og;
    if (logo) {
      if (!/^[a-z0-9-]+$/.test(logo)) return new Response("", { status: 400 });
      const r = await store.getWithMetadata((og ? "og:" : "logo:") + logo, { type: "arrayBuffer" });
      if (!r || !r.data) return new Response("", { status: 404 });
      return new Response(r.data, { headers: { "content-type": r.metadata?.tipo || "image/png", "cache-control": "public, max-age=300" } });
    }
    let base = {};
    try { const r = await fetch(new URL("/agencias/agencias.json", url.origin)); if (r.ok) base = await r.json(); } catch (e) {}
    const extra = (await store.get("lista", { type: "json" })) || {};
    const out = { ...base };
    for (const [k, v] of Object.entries(extra)) {
      if (!v || v.borrada) delete out[k];
      else out[k] = { ...(out[k] || {}), ...v };
    }
    return json(out);
  }

  if (req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch (e) {}
    // Entrar: el administrador con su contraseña; la agencia con su email + contraseña
    if (body.accion === "login") {
      const pw = String(body.pass || body.clave || "");
      if (process.env.MF_ADMIN_CLAVE && pw === process.env.MF_ADMIN_CLAVE) return json({ ok: true, rol: "admin", token: firmarToken({ r: "admin" }) });
      const email = normEmail(body.email);
      const u = email ? await cuentas().get("u:" + email, { type: "json" }) : null;
      if (!u || hashClave(pw, u.sal) !== u.hash) { await espera(1200); return json({ error: "clave" }, 401); }
      if (u.bloqueada) return json({ error: "bloqueada" }, 403);
      return json({ ok: true, rol: "agencia", slug: u.slug, email, cambiar: !!u.cambiar, token: firmarToken({ r: "agencia", s: u.slug, e: email, v: u.v }) });
    }
    const yo = await quien(body);
    if (!yo) { await espera(1200); return json({ error: "clave" }, 401); }
    if (body.accion === "sesion") return json({ ok: true, ...yo, cambiar: yo.rol === "agencia" ? !!((await cuentas().get("u:" + yo.email, { type: "json" })) || {}).cambiar : false });

    // La agencia cambia su propia contraseña
    if (body.accion === "cambiarClave") {
      if (yo.rol !== "agencia") return json({ error: "rol" }, 403);
      const u = await cuentas().get("u:" + yo.email, { type: "json" });
      if (hashClave(String(body.actual || ""), u.sal) !== u.hash) { await espera(800); return json({ error: "actual" }, 400); }
      const nueva = String(body.nueva || "");
      if (nueva.length < 8) return json({ error: "corta" }, 400);
      u.sal = randomBytes(16).toString("hex"); u.hash = hashClave(nueva, u.sal); u.cambiar = false; u.v = (u.v || 0) + 1;
      await cuentas().setJSON("u:" + yo.email, u);
      return json({ ok: true, token: firmarToken({ r: "agencia", s: u.slug, e: yo.email, v: u.v }) });
    }

    // Solo el administrador: accesos, nombre, logo y códigos de afiliado
    // (desde cualquier otra cuenta, todo lo demás se rechaza)
    if (yo.rol !== "admin") return json({ error: "rol" }, 403);
    if (body.accion === "accesos") {
      const { blobs } = await cuentas().list({ prefix: "u:" });
      const out = {};
      for (const b of blobs) { const u = await cuentas().get(b.key, { type: "json" }); if (u) out[u.slug] = { email: b.key.slice(2), bloqueada: !!u.bloqueada, cambiar: !!u.cambiar, tel: u.tel || "" }; }
      return json({ ok: true, accesos: out });
    }
    if (body.accion === "crearAcceso") {
      const slug = slugify(body.slug), email = normEmail(body.email);
      if (!slug || !esEmail(email)) return json({ error: "email" }, 400);
      const otra = await cuentas().get("u:" + email, { type: "json" });
      if (otra && otra.slug !== slug) return json({ error: "email-usado" }, 400);
      // Una sola cuenta por agencia: si cambia el email, se borra el anterior
      const { blobs } = await cuentas().list({ prefix: "u:" });
      for (const b of blobs) { const u = await cuentas().get(b.key, { type: "json" }); if (u && u.slug === slug && b.key !== "u:" + email) await cuentas().delete(b.key); }
      const pw = claveNueva(), sal = randomBytes(16).toString("hex");
      await cuentas().setJSON("u:" + email, { slug, sal, hash: hashClave(pw, sal), cambiar: true, bloqueada: false, v: ((otra && otra.v) || 0) + 1, tel: String(body.tel || "").replace(/\D/g, "").slice(0, 15), creado: Date.now() });
      return json({ ok: true, email, pass: pw });
    }
    if (body.accion === "bloquear") {
      const email = normEmail(body.email);
      const u = await cuentas().get("u:" + email, { type: "json" });
      if (!u) return json({ error: "email" }, 404);
      u.bloqueada = !!body.bloqueada; await cuentas().setJSON("u:" + email, u);
      return json({ ok: true });
    }

    const extra = (await store.get("lista", { type: "json" })) || {};

    if (body.accion === "borrar") {
      const slug = slugify(body.slug);
      if (!slug) return json({ error: "slug" }, 400);
      extra[slug] = { borrada: true };
      await store.setJSON("lista", extra);
      try { await store.delete("logo:" + slug); await store.delete("og:" + slug); } catch (e) {}
      return json({ ok: true });
    }

    if (body.accion === "guardar") {
      const nombre = limpio(body.nombre, 80);
      if (!nombre) return json({ error: "nombre" }, 400);
      const slug = slugify(body.slug) || slugify(nombre);
      if (!slug) return json({ error: "slug" }, 400);
      const tag = limpio(body.tag, 60);
      const seguro = limpio(body.seguro, 500);
      const civitatis = limpio(body.civitatis, 20);
      if (tag && !/^[a-z0-9-]+-21$/i.test(tag)) return json({ error: "tag" }, 400);
      if (seguro && !/^https:\/\//i.test(seguro)) return json({ error: "seguro" }, 400);
      if (civitatis && !/^\d+$/.test(civitatis)) return json({ error: "civitatis" }, 400);
      const previa = extra[slug] && !extra[slug].borrada ? extra[slug] : {};
      const a = { ...previa, nombre, tag, seguro, civitatis, modo: body.modo === "completo" ? "completo" : "", plan: body.plan === "pro" ? "pro" : "", color: /^#[0-9a-f]{6}$/i.test(body.color || "") ? body.color : "", fondo: /^#[0-9a-f]{6}$/i.test(body.fondo || "") ? body.fondo : "", tam: ["s", "l"].includes(body.tam) ? body.tam : "m" };
      if (body.logo) {
        const m = String(body.logo).match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return json({ error: "logo" }, 400);
        const bytes = Buffer.from(m[2], "base64");
        if (bytes.length > 700000) return json({ error: "logo-grande" }, 400);
        await store.set("logo:" + slug, new Blob([bytes]), { metadata: { tipo: m[1] } });
        a.logo = "/.netlify/functions/agencias?logo=" + slug + "&v=" + Date.now();
      }
      if (body.og) {
        // Tarjeta para WhatsApp (1200x630) con el logo de Maleta Fácil + el de la agencia, hecha en la herramienta
        const m = String(body.og).match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
        if (m) {
          const bytes = Buffer.from(m[2], "base64");
          if (bytes.length <= 700000) {
            await store.set("og:" + slug, new Blob([bytes]), { metadata: { tipo: m[1] } });
            a.og = "/.netlify/functions/agencias?og=" + slug + "&v=" + Date.now();
          }
        }
      }
      extra[slug] = a;
      await store.setJSON("lista", extra);
      return json({ ok: true, slug });
    }
    return json({ error: "accion" }, 400);
  }
  return json({ error: "metodo" }, 405);
};
