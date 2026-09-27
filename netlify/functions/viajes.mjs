// Viajes programados de todas las agencias (para el recuento diario y la pestaña "Hoy").
// POST (con contraseña): guardar, hoy, marcar, borrar, config, push, pushPrueba
// GET  ?vapid=1                 → clave pública para activar los avisos en el móvil
// GET  ?ir=SLUG.ID&t=TOKEN      → marca el viaje como enviado y abre WhatsApp con el mensaje ya escrito
// Los datos de los clientes se borran solos al terminar el viaje (lo hace resumen-diario).
import { getStore } from "@netlify/blobs";
import { createHmac, createHash, createECDH, createCipheriv, randomBytes, createPrivateKey, sign as firmar } from "node:crypto";

/* ---------- Avisos al móvil (Web Push) sin librerías: cifrado aes128gcm (RFC 8291) + firma VAPID (RFC 8292) ---------- */
const b64u = b => Buffer.from(b).toString("base64url");
const deB64u = s => Buffer.from(String(s), "base64url");
function hkdf(salt, ikm, info, len) {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
}
export function cifrarPush(payload, p256dh, auth) {
  const ua = deB64u(p256dh), secreto = deB64u(auth);
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys(); const as = ecdh.getPublicKey();
  const comun = ecdh.computeSecret(ua);
  const ikm = hkdf(secreto, comun, Buffer.concat([Buffer.from("WebPush: info\0"), ua, as]), 32);
  const sal = randomBytes(16);
  const cek = hkdf(sal, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(sal, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const cuerpo = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const cab = Buffer.alloc(21); sal.copy(cab, 0); cab.writeUInt32BE(4096, 16); cab[20] = as.length;
  return Buffer.concat([cab, as, cuerpo]);
}
function vapid(endpoint) {
  const pub = deB64u(process.env.VAPID_PUBLIC || "");
  const clave = createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: process.env.VAPID_PRIVATE }, format: "jwk" });
  const datos = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" })) + "." + b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:hola@maletafacil.com" }));
  const f = firmar("sha256", Buffer.from(datos), { key: clave, dsaEncoding: "ieee-p1363" });
  return `vapid t=${datos}.${b64u(f)}, k=${process.env.VAPID_PUBLIC}`;
}
export async function enviarPush(sub, mensaje) {
  const cuerpo = cifrarPush(JSON.stringify(mensaje), sub.keys.p256dh, sub.keys.auth);
  const r = await fetch(sub.endpoint, { method: "POST", headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "43200", Urgency: "high", Authorization: vapid(sub.endpoint) }, body: cuerpo });
  return { ok: r.ok, status: r.status }; // 404/410 = el móvil ya no acepta avisos: se borra la suscripción
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const esSlug = s => /^[a-z0-9-]{1,40}$/.test(s || "");
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const limpio = (s, max = 200) => String(s || "").trim().slice(0, max);
export const token = (txt) => createHmac("sha256", process.env.MF_ADMIN_CLAVE || "x").update(txt).digest("base64url").slice(0, 16);
export function hoyEn(tz = "Europe/Madrid") {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return p; // AAAA-MM-DD
}
export const sumaDias = (f, n) => { const d = new Date(f + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const fechaEnvio = v => sumaDias(v.ida, -(+v.dias || 0));
export const CFG_DEF = { hora: "09:00", dias: 5, tz: "Europe/Madrid", email: "" };

export function clasificar(viajes, hoy) {
  const pend = [], hechos = [], prox = [];
  for (const v of viajes) {
    if (v.ida < hoy) continue;
    const env = fechaEnvio(v);
    if (v.enviado) { if (String(v.enviadoDia || "") === hoy) hechos.push(v); continue; }
    if (env <= hoy) pend.push(v); else prox.push(v);
  }
  const orden = (a, b) => a.ida.localeCompare(b.ida);
  return { pend: pend.sort(orden), hechos: hechos.sort(orden), prox: prox.sort((a, b) => fechaEnvio(a).localeCompare(fechaEnvio(b))) };
}

/* ---------- Recuento diario (lo llama resumen-diario cada hora, o "Probar ahora" desde la herramienta) ---------- */
const WEB = process.env.URL || "https://maletafacil.com";
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const corto = f => { const [, m, d] = f.split("-").map(Number); return `${d} ${MES[m - 1]}`; };
const rango = v => v.vu ? `${corto(v.ida)} – ${corto(v.vu)}` : `sale el ${corto(v.ida)}`;
const horaEn = tz => parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date()), 10) % 24;

async function nombresAgencias() {
  try { const r = await fetch(WEB + "/.netlify/functions/agencias"); if (r.ok) return await r.json(); } catch (e) {}
  return {};
}

function htmlEmail(nombreAg, hoy, pend) {
  const [a, m, d] = hoy.split("-").map(Number); const f = new Date(Date.UTC(a, m - 1, d));
  const filas = pend.map(v => {
    const ir = `${WEB}/.netlify/functions/viajes?ir=${v.slug}.${v.id}&t=${token(v.slug + "." + v.id)}`;
    const btn = v.tel
      ? `<a href="${ir}" style="background:#25D366;color:#0B3B21;text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:100px;display:inline-block">WhatsApp</a>`
      : `<span style="background:#F3E1D8;color:#8F4430;font-weight:700;font-size:12px;padding:6px 10px;border-radius:100px;display:inline-block">Sin teléfono</span>`;
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #EEE7D8"><b style="font-size:15px;color:#12302E">${esc(v.cli || "Cliente")} · ${esc(v.des)}</b><br><span style="font-size:13px;color:#6B665B">${rango(v)}${v.tel ? " · +" + esc(v.tel) : ""}</span></td><td align="right" style="padding:12px 0;border-bottom:1px solid #EEE7D8">${btn}</td></tr>`;
  }).join("");
  return `<!doctype html><html><body style="margin:0;background:#EFEBE3;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px 10px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#12302E;padding:16px 20px;color:#F6F1E4"><b style="font-family:Georgia,serif;font-size:18px">Maleta Fácil</b><br><span style="font-size:12px;color:#9FC2BC">Resumen del ${DIAS[f.getUTCDay()]} ${d} de ${["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"][m - 1]} · ${esc(nombreAg)}</span></td></tr>
<tr><td style="padding:18px 20px">
<div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#12302E;margin-bottom:6px">Hoy toca enviar la maleta a ${pend.length} cliente${pend.length > 1 ? "s" : ""}</div>
<p style="font-size:14px;color:#555;line-height:1.5;margin:0 0 8px">Toca <b>WhatsApp</b> en cada uno: se abre su chat con el mensaje ya escrito. Solo tienes que pulsar enviar.</p>
<table width="100%" cellpadding="0" cellspacing="0">${filas}</table>
<p style="margin:18px 0 0"><a href="${WEB}/enlace.html?ag=${pend[0].slug}#hoy" style="color:#B65B3F;font-weight:bold">Ver la lista en la herramienta</a></p>
</td></tr>
<tr><td style="padding:0 20px 16px;font-size:11px;color:#999;line-height:1.4">Recibes este resumen porque ${esc(nombreAg)} usa Maleta Fácil. Los datos de los clientes se borran automáticamente al terminar el viaje.</td></tr>
</table></td></tr></table></body></html>`;
}

async function enviarEmail(para, asunto, html) {
  const key = process.env.BREVO_API_KEY, de = process.env.BREVO_SENDER_EMAIL;
  if (!key || !de || !para) return false;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST", headers: { "api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ sender: { email: de, name: "Maleta Fácil" }, to: [{ email: para }], subject: asunto, htmlContent: html }),
  });
  return r.ok;
}

export async function ejecutarResumen(forzarSlug = "") {
  const store = getStore({ name: "viajes", consistency: "strong" });
  const slugs = forzarSlug ? [forzarSlug] : (await store.list({ prefix: "ag:" })).blobs.map(x => x.key.slice(3));
  const forzar = !!forzarSlug;
  const nombres = slugs.length ? await nombresAgencias() : {};
  const informe = [];

  for (const slug of slugs) {
    const cfgGuardada = (await store.get("cfg:" + slug, { type: "json" })) || {};
    const cfg = { ...CFG_DEF, ...cfgGuardada };
    const hoy = hoyEn(cfg.tz);
    let lista = (await store.get("ag:" + slug, { type: "json" })) || [];

    // Borrar viajes ya terminados (el día después de la vuelta)
    const antes = lista.length;
    lista = lista.filter(v => (v.vu || v.ida) >= sumaDias(hoy, -1));
    if (lista.length !== antes) await store.setJSON("ag:" + slug, lista);

    // ¿Es la hora del resumen de esta agencia y aún no se ha mandado hoy?
    const horaCfg = parseInt(cfg.hora, 10);
    if (!forzar && (horaEn(cfg.tz) !== horaCfg || cfgGuardada.ultimo === hoy)) continue;

    const { pend } = clasificar(lista, hoy);
    if (!forzar) await store.setJSON("cfg:" + slug, { ...cfgGuardada, ultimo: hoy }); // "Probar ahora" no gasta el resumen del día
    if (!pend.length) { informe.push({ slug, pend: 0 }); continue; }
    pend.forEach(v => { v.slug = slug; });
    const nombreAg = (nombres[slug] && nombres[slug].nombre) || slug;
    const titulo = `🧳 Hoy toca enviar la maleta a ${pend.length} cliente${pend.length > 1 ? "s" : ""}`;

    // 1) Aviso al móvil de cada agente
    const subs = (await store.get("push:" + slug, { type: "json" })) || [];
    const vivas = []; let avisos = 0;
    for (const s of subs) {
      try {
        const r = await enviarPush(s, { title: titulo, body: pend.slice(0, 4).map(v => `${v.cli || "Cliente"} · ${v.des}`).join(", ") + (pend.length > 4 ? "…" : ""), url: `/enlace.html?ag=${slug}#hoy` });
        if (r.ok) avisos++;
        if (r.status !== 404 && r.status !== 410) vivas.push(s);
      } catch (e) { vivas.push(s); }
    }
    if (vivas.length !== subs.length) await store.setJSON("push:" + slug, vivas);

    // 2) Email a la agencia (si tiene email configurado)
    let email = false;
    try { email = await enviarEmail(cfg.email, titulo, htmlEmail(nombreAg, hoy, pend)); } catch (e) {}
    informe.push({ slug, pend: pend.length, avisos, email });
  }
  return informe;
}


export default async (req) => {
  const url = new URL(req.url);
  const store = getStore({ name: "viajes", consistency: "strong" });

  if (req.method === "GET") {
    if (url.searchParams.get("vapid")) return json({ clave: process.env.VAPID_PUBLIC || "" });
    const ir = url.searchParams.get("ir") || "";
    const [slug, id] = ir.split(".");
    if (!esSlug(slug) || !/^[a-f0-9]{16}$/.test(id || "") || url.searchParams.get("t") !== token(ir)) return new Response("Enlace no válido", { status: 400 });
    const lista = (await store.get("ag:" + slug, { type: "json" })) || [];
    const v = lista.find(x => x.id === id);
    if (!v) return new Response("Este viaje ya no está en la lista.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    if (!v.enviado) {
      const cfg = { ...CFG_DEF, ...((await store.get("cfg:" + slug, { type: "json" })) || {}) };
      v.enviado = Date.now(); v.enviadoDia = hoyEn(cfg.tz);
      await store.setJSON("ag:" + slug, lista);
    }
    return Response.redirect(`https://wa.me/${v.tel || ""}?text=${encodeURIComponent(v.msg || "")}`, 302);
  }

  if (req.method !== "POST") return json({ error: "metodo" }, 405);
  let b = {}; try { b = await req.json(); } catch (e) {}
  if (!process.env.MF_ADMIN_CLAVE || b.clave !== process.env.MF_ADMIN_CLAVE) { await new Promise(r => setTimeout(r, 1200)); return json({ error: "clave" }, 401); }
  const slug = limpio(b.slug, 40).toLowerCase();

  if (b.accion === "guardar") {
    if (!esSlug(slug)) return json({ error: "agencia" }, 400);
    const lista = (await store.get("ag:" + slug, { type: "json" })) || [];
    let nuevos = 0, cambiados = 0;
    for (const e of (Array.isArray(b.viajes) ? b.viajes : []).slice(0, 500)) {
      const v = { cli: limpio(e.cli, 60), tel: String(e.tel || "").replace(/\D/g, "").slice(0, 15), des: limpio(e.des, 60), ida: e.ida, vu: esFecha(e.vu) ? e.vu : "",
        tipo: limpio(e.tipo, 20), dias: Math.max(0, Math.min(60, parseInt(e.dias, 10) || 0)), msg: limpio(e.msg, 1500), url: limpio(e.url, 400) };
      if (!v.des || !esFecha(v.ida)) continue;
      v.id = createHash("sha1").update([slug, v.cli.toLowerCase(), v.tel, v.des.toLowerCase(), v.ida].join("|")).digest("hex").slice(0, 16);
      const i = lista.findIndex(x => x.id === v.id);
      if (i >= 0) { lista[i] = { ...lista[i], ...v }; cambiados++; } else { lista.push({ ...v, creado: Date.now(), enviado: null }); nuevos++; }
    }
    await store.setJSON("ag:" + slug, lista);
    return json({ ok: true, nuevos, cambiados });
  }

  if (b.accion === "hoy") {
    // Una agencia o todas (panel general)
    const slugs = esSlug(slug) ? [slug] : (await store.list({ prefix: "ag:" })).blobs.map(x => x.key.slice(3));
    const out = {};
    for (const s of slugs) {
      const cfg = { ...CFG_DEF, ...((await store.get("cfg:" + s, { type: "json" })) || {}) };
      const hoy = hoyEn(cfg.tz);
      const { pend, hechos, prox } = clasificar((await store.get("ag:" + s, { type: "json" })) || [], hoy);
      const conLink = v => ({ ...v, ir: `/.netlify/functions/viajes?ir=${s}.${v.id}&t=${token(s + "." + v.id)}`, envio: fechaEnvio(v) });
      out[s] = { hoy, cfg, pend: pend.map(conLink), hechos: hechos.map(conLink), prox: prox.slice(0, 60).map(conLink), avisos: ((await store.get("push:" + s, { type: "json" })) || []).length };
    }
    return json({ ok: true, agencias: out });
  }

  if (b.accion === "marcar" || b.accion === "borrar") {
    if (!esSlug(slug)) return json({ error: "agencia" }, 400);
    const lista = (await store.get("ag:" + slug, { type: "json" })) || [];
    const i = lista.findIndex(x => x.id === b.id);
    if (i < 0) return json({ error: "viaje" }, 404);
    if (b.accion === "borrar") lista.splice(i, 1);
    else { const cfg = { ...CFG_DEF, ...((await store.get("cfg:" + slug, { type: "json" })) || {}) }; lista[i].enviado = b.enviado ? Date.now() : null; lista[i].enviadoDia = b.enviado ? hoyEn(cfg.tz) : ""; }
    await store.setJSON("ag:" + slug, lista);
    return json({ ok: true });
  }

  if (b.accion === "config") {
    if (!esSlug(slug)) return json({ error: "agencia" }, 400);
    const previa = (await store.get("cfg:" + slug, { type: "json" })) || {};
    const email = limpio(b.email, 200);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "email" }, 400);
    const hora = /^\d{2}:\d{2}$/.test(b.hora || "") ? b.hora : CFG_DEF.hora;
    const tz = b.tz === "Europe/Lisbon" ? "Europe/Lisbon" : "Europe/Madrid";
    await store.setJSON("cfg:" + slug, { ...previa, email, hora, tz, dias: Math.max(0, Math.min(60, parseInt(b.dias, 10) || CFG_DEF.dias)) });
    return json({ ok: true });
  }

  if (b.accion === "push") {
    if (!esSlug(slug) || !b.sub || !/^https:\/\//.test(b.sub.endpoint || "")) return json({ error: "datos" }, 400);
    const subs = ((await store.get("push:" + slug, { type: "json" })) || []).filter(x => x.endpoint !== b.sub.endpoint);
    subs.push({ endpoint: b.sub.endpoint, keys: b.sub.keys, alta: Date.now(), quien: limpio(b.quien, 40) });
    await store.setJSON("push:" + slug, subs.slice(-20));
    return json({ ok: true, total: subs.length });
  }

  if (b.accion === "pushPrueba") {
    if (!esSlug(slug)) return json({ error: "agencia" }, 400);
    const subs = (await store.get("push:" + slug, { type: "json" })) || [];
    let ok = 0;
    for (const s of subs) { try { const r = await enviarPush(s, { title: "🧳 Maleta Fácil", body: "¡Avisos activados! Cada mañana te diremos a quién toca enviar la maleta.", url: `/enlace.html?ag=${slug}#hoy` }); if (r.ok) ok++; } catch (e) {} }
    return json({ ok: true, enviados: ok, total: subs.length });
  }

  if (b.accion === "resumenAhora") {
    if (!esSlug(slug)) return json({ error: "agencia" }, 400);
    return json({ ok: true, informe: await ejecutarResumen(slug) });
  }

  return json({ error: "accion" }, 400);
};
