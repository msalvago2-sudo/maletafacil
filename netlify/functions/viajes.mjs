// Viajes programados de todas las agencias (para el recuento diario y la pestaña "Hoy").
// POST (con contraseña): guardar, hoy, marcar, borrar, config, push, pushPrueba
// GET  ?vapid=1                 → clave pública para activar los avisos en el móvil
// GET  ?ir=SLUG.ID&t=TOKEN      → marca el viaje como enviado y abre WhatsApp con el mensaje ya escrito
// Los datos de los clientes se borran solos al terminar el viaje (lo hace resumen-diario).
import { getStore } from "@netlify/blobs";
import { quien } from "./agencias.mjs";
import { sumar, leerEstadisticas, statsAgencia } from "./evento.mjs";
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
export const CFG_DEF = { hora: "09:30", dias: 7, tz: "Europe/Madrid", email: "" };
// Días de antelación y hora del resumen: los decide el administrador (general y, si quiere, por agencia)
export async function efectiva(store, slug) {
  const g = (await store.get("cfg:_global", { type: "json" })) || {};
  const a = (await store.get("cfg:" + slug, { type: "json" })) || {};
  return { ...CFG_DEF, ...(g.hora ? { hora: g.hora } : {}), ...(g.dias != null ? { dias: g.dias } : {}), ...a, general: { hora: g.hora || CFG_DEF.hora, dias: g.dias ?? CFG_DEF.dias } };
}
const minutosEn = tz => { const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).split(":").map(Number); return (h % 24) * 60 + m; };

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

async function enviarEmail(para, asunto, html, copia = false) {
  const key = process.env.BREVO_API_KEY, de = process.env.BREVO_SENDER_EMAIL;
  if (!key || !de || !para) return false;
  const cuerpo = { sender: { email: de, name: "Maleta Fácil" }, to: [{ email: para }], subject: asunto, htmlContent: html };
  if (copia && de.toLowerCase() !== String(para).toLowerCase()) cuerpo.bcc = [{ email: de }]; // copia para el administrador
  const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
  return r.ok;
}

/* ---------- Informe mensual para cada agencia ---------- */
const MESES_ = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export const mesPrevio = m => { const [a, b] = m.split("-").map(Number); return new Date(Date.UTC(a, b - 2, 1)).toISOString().slice(0, 7); };
const nomMes = m => MESES_[+m.slice(5, 7) - 1];
const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
export async function datosInforme(slug, mes) {
  const act = await statsAgencia(slug, mes), ant = await statsAgencia(slug, mesPrevio(mes));
  const top = Object.entries(act.destinos || {}).sort((x, y) => y[1] - x[1]).slice(0, 4);
  return { mes, nombreMes: nomMes(mes), mesAnterior: nomMes(mesPrevio(mes)), act, ant, top,
    pctAct: pct(act.aperturas, act.envios), pctAnt: pct(ant.aperturas, ant.envios) };
}
// Informe de un periodo: "mes" (un mes cerrado), "parcial" (lo que va de mes, sin comparar) o "trimestre" (3 meses)
async function sumaMeses(slug, meses) {
  const t = { envios: 0, aperturas: 0, amazon: 0, civitatis: 0, sinTelefono: 0, destinos: {} };
  for (const m of meses) { const d = await statsAgencia(slug, m); for (const k of ["envios", "aperturas", "amazon", "civitatis", "sinTelefono"]) t[k] += d[k] || 0; for (const [x, n] of Object.entries(d.destinos || {})) t.destinos[x] = (t.destinos[x] || 0) + n; }
  return t;
}
export async function datosPeriodo(slug, tipo, mes) {
  if (tipo === "parcial") { const i = await datosInforme(slug, mes); i.nombreMes = "lo que llevas de " + nomMes(mes); i.ant = { envios: 0, aperturas: 0, amazon: 0, civitatis: 0, sinTelefono: 0 }; i.pctAnt = 0; return i; }
  if (tipo === "trimestre") {
    const m3 = [mesPrevio(mesPrevio(mes)), mesPrevio(mes), mes], p3 = m3.map(x => mesPrevio(mesPrevio(mesPrevio(x))));
    const act = await sumaMeses(slug, m3), ant = await sumaMeses(slug, p3);
    return { mes, nombreMes: `${nomMes(m3[0])}–${nomMes(mes)}`, mesAnterior: "el trimestre anterior", act, ant,
      top: Object.entries(act.destinos).sort((x, y) => y[1] - x[1]).slice(0, 4), pctAct: pct(act.aperturas, act.envios), pctAnt: pct(ant.aperturas, ant.envios) };
  }
  return datosInforme(slug, mes);
}
// ¿Toca informe hoy según la periodicidad elegida? → {tipo, mes, clave} o null
export function informeToca(cada, hoy) {
  const dia = +hoy.slice(8, 10), mesAct = hoy.slice(0, 7), mesAnt = mesPrevio(mesAct);
  const dow = new Date(hoy + "T12:00:00Z").getUTCDay();
  if (cada === "nunca") return null;
  if (cada === "semanal") { if (dow !== 1) return null; return dia <= 7 ? { tipo: "mes", mes: mesAnt, clave: hoy } : { tipo: "parcial", mes: mesAct, clave: hoy }; }
  if (cada === "quincenal") { if (dia === 1) return { tipo: "mes", mes: mesAnt, clave: mesAnt }; if (dia === 16) return { tipo: "parcial", mes: mesAct, clave: mesAct + "-16" }; return null; }
  if (cada === "trimestral") { if (dia === 1 && [1, 4, 7, 10].includes(+mesAct.slice(5, 7))) return { tipo: "trimestre", mes: mesAnt, clave: "T" + mesAnt }; return null; }
  return dia === 1 ? { tipo: "mes", mes: mesAnt, clave: mesAnt } : null; // mensual (por defecto)
}
const flecha = (a, b, suf = "") => { const d = a - b; return d > 0 ? `▲ ${d}${suf}` : d < 0 ? `▼ ${-d}${suf}` : "= igual"; };
export function textoInforme(nombreAg, i) {
  const L = [`Hola, ${nombreAg} 👋 Tu mes en Maleta Fácil (${i.nombreMes}):`, "",
    `🧳 *${i.act.envios} maletas enviadas*` + (i.ant.envios ? ` (${i.act.envios >= i.ant.envios ? (i.act.envios - i.ant.envios) + " más" : (i.ant.envios - i.act.envios) + " menos"} que en ${i.mesAnterior})` : ""),
    `✅ *${i.act.aperturas} clientes la abrieron (${i.pctAct} %)*`];
  if (i.top.length) L.push(`🌍 Destinos estrella: ${i.top.slice(0, 3).map(x => x[0]).join(", ").replace(/, ([^,]*)$/, " y $1")}`);
  if (i.act.civitatis) L.push(`🎟️ ${i.act.civitatis} clics a Civitatis`);
  if (i.act.sinTelefono) L.push("", `💡 ${i.act.sinTelefono} cliente${i.act.sinTelefono > 1 ? "s no tenían" : " no tenía"} teléfono: añádelo en tu Excel y también les llegará por WhatsApp.`);
  L.push("", "¡Gracias por cuidar así a tus viajeros! Maleta Fácil");
  return L.join("\n");
}
function htmlInforme(nombreAg, logo, i) {
  const gratis = i.plan !== "pro";
  const caja = (num, txt, sub, color) => `<td width="50%" valign="top" style="padding:4px"><div style="background:#F6F1E4;border-radius:12px;padding:12px;min-height:92px"><div style="font-family:Georgia,serif;font-size:28px;font-weight:bold;color:#12302E">${num}</div><div style="font-size:13px;color:#6B665B">${txt}</div>${sub ? `<div style="font-size:12px;font-weight:bold;color:${color || "#2E827C"}">${sub}</div>` : ""}</div></td>`;
  const destinos = i.top.map(([d, n]) => `<span style="display:inline-block;background:#E3EFEC;color:#2E5E59;font-weight:bold;font-size:13px;padding:4px 10px;border-radius:100px;margin:0 4px 6px 0">${esc(d)} · ${n}</span>`).join("");
  const consejo = i.act.sinTelefono ? `${i.act.sinTelefono} cliente${i.act.sinTelefono > 1 ? "s no tenían" : " no tenía"} teléfono. Añádelo en tu Excel y les llegará su maleta por WhatsApp.`
    : i.pctAct && i.pctAct < 50 ? "Menos de la mitad de tus clientes abrió su maleta. Un mensaje personal («¡Hola, Ana!») ayuda a que la abran."
    : "Sube tu Excel de reservas cada semana: así ningún cliente se queda sin su maleta.";
  return `<!doctype html><html><body style="margin:0;background:#EFEBE3;font-family:Arial,Helvetica,sans-serif"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px 10px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#12302E;padding:16px 20px;color:#F6F1E4"><table width="100%"><tr><td><b style="font-family:Georgia,serif;font-size:18px">Maleta Fácil</b><br><span style="font-size:12px;color:#9FC2BC">Informe de ${i.nombreMes} · ${esc(nombreAg)}</span></td>${logo ? `<td align="right"><img src="${logo}" alt="" height="28" style="border-radius:4px"></td>` : ""}</tr></table></td></tr>
<tr><td style="padding:18px 20px;font-size:14px;line-height:1.5;color:#12302E">
<div style="font-family:Georgia,serif;font-size:22px;font-weight:bold">${i.pocos ? "¡Empieza el mes con tus viajeros! 🧳" : "¡Buen mes! 🎉"}</div>
<p style="margin:4px 0 10px">${i.pocos ? "Programa en la herramienta los viajes de tus clientes de este mes (uno a uno o subiendo tu Excel): a cada uno le llegará su maleta por WhatsApp antes de salir, con tu logo. El mes que viene te contamos cómo les ha ido." : "Tus clientes han recibido su maleta antes de viajar:"}</p>
${i.pocos ? "" : `
<table width="100%" cellpadding="0" cellspacing="0"><tr>${caja(i.act.envios, "maletas enviadas", i.ant.envios ? flecha(i.act.envios, i.ant.envios) + " vs " + i.mesAnterior : "")}${caja(i.pctAct + " %", `la abrieron (${i.act.aperturas} clientes)`, i.ant.envios ? flecha(i.pctAct, i.pctAnt, " puntos") : "")}</tr>
${gratis ? "" : `<tr>${caja(i.act.civitatis, "clics a Civitatis (tu comisión)", i.ant.civitatis || i.act.civitatis ? flecha(i.act.civitatis, i.ant.civitatis) : "")}${caja(i.act.sinTelefono, "sin teléfono en el Excel", i.act.sinTelefono ? "no recibieron WhatsApp" : "¡todos con teléfono!", i.act.sinTelefono ? "#B65B3F" : "#2E827C")}</tr>`}</table>
${destinos ? `<p style="margin:14px 0 6px;font-weight:bold">Destinos del mes</p>${destinos}` : ""}
<div style="background:#FCEFD8;border-radius:12px;padding:10px 12px;margin-top:10px">💡 <b>Consejo:</b> ${gratis ? "Sube tu Excel de reservas cada semana: así ningún cliente se queda sin su maleta." : consejo}</div>`}
<p style="margin:14px 0 0">Gracias por cuidar así a tus viajeros.<br><b>Maleta Fácil</b></p></td></tr>
<tr><td style="padding:0 20px 16px;font-size:11.5px;color:#999">Lo ves también en tu herramienta → Mi agencia.</td></tr></table></td></tr></table></body></html>`;
}
// Plan Gratis: la agencia solo ve lo que motiva (maletas enviadas y abiertas) y a partir de un mínimo.
// Plan Pro (futuro): estadísticas completas. El administrador siempre lo ve todo.
export const MINIMO_INFORME = 10;
export const esPro = cfg => cfg && (cfg.plan === "pro" || cfg.informeContenido === "completo"); // informe completo: Pro o elegido por el administrador
export function recortarGratis(i) {
  const r = { ...i, plan: "gratis", pocos: i.act.envios < MINIMO_INFORME,
    act: { envios: i.act.envios, aperturas: i.act.aperturas, destinos: i.act.destinos },
    ant: { envios: i.ant.envios, aperturas: i.ant.aperturas } };
  if (r.pocos) { r.pctAct = 0; r.pctAnt = 0; r.top = []; r.act = { envios: i.act.envios, aperturas: 0 }; }
  return r;
}
export async function enviarInforme(store, slug, mes, nombres, copia = true, tipo = "mes") {
  const cfg = await efectiva(store, slug);
  const completo = await datosPeriodo(slug, tipo, mes);
  const i = esPro(cfg) ? { ...completo, plan: "pro" } : recortarGratis(completo);
  const ag = nombres[slug] || {}, nombreAg = ag.nombre || slug;
  const WEB_ = process.env.URL || "https://maletafacil.com";
  const logo = ag.logo ? (/^https?:/.test(ag.logo) ? ag.logo : WEB_ + (ag.logo.startsWith("/") ? ag.logo : "/agencias/" + encodeURIComponent(ag.logo))) : "";
  let email = false, avisos = 0;
  const canal = cfg.informeCanal || "ambos";
  if (canal !== "movil") { try { email = await enviarEmail(cfg.email, i.pocos ? "🧳 Programa los viajes de tus clientes" : `📊 Tu informe de Maleta Fácil: ${i.nombreMes}`, htmlInforme(nombreAg, logo, i), copia); } catch (e) {} }
  const subs = (await store.get("push:" + slug, { type: "json" })) || [];
  const aviso = i.pocos ? { title: "🧳 Nuevo mes en Maleta Fácil", body: "Programa los viajes de tus clientes de este mes: les llegará su maleta antes de salir." }
    : { title: `📊 Tu informe de ${i.nombreMes} está listo`, body: `${i.act.envios} maletas enviadas y ${i.act.aperturas} clientes la abrieron.` };
  if (canal !== "email") for (const sb of subs) { try { const r = await enviarPush(sb, { ...aviso, url: "/enlace.html#miagencia" }); if (r.ok) avisos++; } catch (e) {} }
  return { slug, mes, email, avisos };
}

export async function ejecutarResumen(forzarSlug = "") {
  const store = getStore({ name: "viajes", consistency: "strong" });
  const slugs = forzarSlug ? [forzarSlug] : (await store.list({ prefix: "ag:" })).blobs.map(x => x.key.slice(3));
  const forzar = !!forzarSlug;
  const nombres = slugs.length ? await nombresAgencias() : {};
  const informe = [];

  for (const slug of slugs) {
    const cfgGuardada = (await store.get("cfg:" + slug, { type: "json" })) || {};
    const cfg = await efectiva(store, slug);
    const hoy = hoyEn(cfg.tz);
    let lista = (await store.get("ag:" + slug, { type: "json" })) || [];

    // Borrar viajes ya terminados (el día después de la vuelta)
    const antes = lista.length;
    lista = lista.filter(v => (v.vu || v.ida) >= sumaDias(hoy, -1));
    if (lista.length !== antes) await store.setJSON("ag:" + slug, lista);

    // ¿Es la hora del resumen de esta agencia y aún no se ha mandado hoy?
    // Se manda en la primera pasada a partir de su hora (la función se ejecuta cada 15 minutos)
    const [hh, mm] = String(cfg.hora).split(":").map(Number), ahora = minutosEn(cfg.tz);
    if (!forzar && (ahora < hh * 60 + mm || ahora >= 21 * 60 || cfgGuardada.ultimo === hoy)) continue;

    // Informe de la agencia según la periodicidad que elija el administrador (por defecto, el día 1 de cada mes)
    const toca = informeToca(cfg.informeCada || "mensual", hoy);
    if (!forzar && toca && cfgGuardada.informe !== toca.clave) {
      try { informe.push({ ...(await enviarInforme(store, slug, toca.mes, nombres, true, toca.tipo)), tipo: "informe" }); } catch (e) {}
      cfgGuardada.informe = toca.clave;
    }

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
      const cfg = await efectiva(store, slug);
      v.enviado = Date.now(); v.enviadoDia = hoyEn(cfg.tz);
      await store.setJSON("ag:" + slug, lista);
      try { await sumar(slug, "envio", v.des); } catch (e) {}
    }
    return Response.redirect(`https://wa.me/${v.tel || ""}?text=${encodeURIComponent(v.msg || "")}`, 302);
  }

  if (req.method !== "POST") return json({ error: "metodo" }, 405);
  let b = {}; try { b = await req.json(); } catch (e) {}
  const yo = await quien(b);
  if (!yo) { await new Promise(r => setTimeout(r, 1200)); return json({ error: "clave" }, 401); }
  // Cada agencia solo ve y toca lo suyo; el administrador, todo
  const slug = yo.rol === "agencia" ? yo.slug : limpio(b.slug, 40).toLowerCase();

  if (b.accion === "guardar") {
    if (!esSlug(slug)) return json({ error: "agencia" }, 400);
    const lista = (await store.get("ag:" + slug, { type: "json" })) || [];
    let nuevos = 0, cambiados = 0;
    const diasFijos = yo.rol === "agencia" ? (await efectiva(store, slug)).dias : null;
    for (const e of (Array.isArray(b.viajes) ? b.viajes : []).slice(0, 500)) {
      const v = { cli: limpio(e.cli, 60), tel: String(e.tel || "").replace(/\D/g, "").slice(0, 15), des: limpio(e.des, 60), ida: e.ida, vu: esFecha(e.vu) ? e.vu : "",
        tipo: limpio(e.tipo, 20), dias: diasFijos != null ? diasFijos : Math.max(0, Math.min(60, parseInt(e.dias, 10) || 0)), msg: limpio(e.msg, 1500), url: limpio(e.url, 400) };
      if (!v.des || !esFecha(v.ida)) continue;
      v.id = createHash("sha1").update([slug, v.cli.toLowerCase(), v.tel, v.des.toLowerCase(), v.ida].join("|")).digest("hex").slice(0, 16);
      const i = lista.findIndex(x => x.id === v.id);
      if (i >= 0) { lista[i] = { ...lista[i], ...v }; cambiados++; } else { lista.push({ ...v, creado: Date.now(), enviado: null }); nuevos++; if (!v.tel) { try { await sumar(slug, "sintel"); } catch (e) {} } }
    }
    await store.setJSON("ag:" + slug, lista);
    return json({ ok: true, nuevos, cambiados });
  }

  if (b.accion === "hoy") {
    // Una agencia o todas (panel general)
    const slugs = esSlug(slug) ? [slug] : (await store.list({ prefix: "ag:" })).blobs.map(x => x.key.slice(3));
    const out = {};
    for (const s of slugs) {
      const cfg = await efectiva(store, s);
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
    else {
      const cfg = await efectiva(store, slug), antes = !!lista[i].enviado;
      lista[i].enviado = b.enviado ? Date.now() : null; lista[i].enviadoDia = b.enviado ? hoyEn(cfg.tz) : "";
      if (b.enviado && !antes) { try { await sumar(slug, "envio", lista[i].des); } catch (e) {} }
    }
    await store.setJSON("ag:" + slug, lista);
    return json({ ok: true });
  }

  if (b.accion === "informe" || b.accion === "informeAhora") {
    // La agencia ve el suyo; el administrador, el de cualquier agencia (y puede mandarlo ya)
    if (!esSlug(slug)) return json({ error: "agencia" }, 400);
    const mes = /^\d{4}-\d{2}$/.test(b.mes || "") ? b.mes : hoyEn().slice(0, 7);
    if (b.accion === "informeAhora") {
      if (yo.rol !== "admin") return json({ error: "rol" }, 403);
      return json({ ok: true, ...(await enviarInforme(store, slug, mes, await nombresAgencias(), false)) });
    }
    const completo = await datosInforme(slug, mes);
    // El administrador lo ve todo; la agencia, según su plan (Gratis: solo maletas enviadas y abiertas)
    const i = yo.rol === "admin" ? completo : esPro(await efectiva(store, slug)) ? (() => { const x = { ...completo, plan: "pro" }; delete x.act.amazon; delete x.ant.amazon; return x; })() : recortarGratis(completo);
    const nombres = await nombresAgencias();
    const { blobs } = await getStore({ name: "estadisticas", consistency: "strong" }).list({ prefix: `st:${slug}:` });
    return json({ ok: true, ...i, meses: blobs.map(x => x.key.split(":")[2]).sort().reverse(), texto: yo.rol === "admin" ? textoInforme((nombres[slug] || {}).nombre || slug, i) : undefined });
  }

  if (b.accion === "stats") {
    if (yo.rol !== "admin") return json({ error: "rol" }, 403);
    const mes = /^\d{4}-\d{2}$/.test(b.mes || "") ? b.mes : hoyEn().slice(0, 7);
    return json({ ok: true, ...(await leerEstadisticas(mes)) });
  }

  if (b.accion === "config") {
    // El email del resumen, los días, la hora y el horario los cambia solo el administrador
    if (yo.rol !== "admin") return json({ error: "rol" }, 403);
    if (!esSlug(slug)) return json({ error: "agencia" }, 400);
    const previa = (await store.get("cfg:" + slug, { type: "json" })) || {};
    const email = limpio(b.email, 200);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "email" }, 400);
    const nueva = { ...previa, email };
    if (yo.rol === "admin") nueva.tz = b.tz === "Europe/Lisbon" ? "Europe/Lisbon" : "Europe/Madrid"; // España/Portugal: solo el administrador
    if (yo.rol === "admin") {
      // Solo el administrador cambia días y hora; si coinciden con los generales, la agencia sigue los generales
      const gen = (await efectiva(store, "_x_")).general;
      const hora = /^\d{2}:\d{2}$/.test(b.hora || "") ? b.hora : gen.hora;
      const dias = b.dias === "" || b.dias == null ? gen.dias : Math.max(0, Math.min(60, parseInt(b.dias, 10)));
      if (hora === gen.hora) delete nueva.hora; else nueva.hora = hora;
      if (dias === gen.dias) delete nueva.dias; else nueva.dias = dias;
      // Cómo, cuándo y qué recibe la agencia en su informe
      if (["mensual", "quincenal", "semanal", "trimestral", "nunca"].includes(b.informeCada)) nueva.informeCada = b.informeCada;
      if (["ambos", "email", "movil"].includes(b.informeCanal)) nueva.informeCanal = b.informeCanal;
      if (["basico", "completo"].includes(b.informeContenido)) nueva.informeContenido = b.informeContenido;
    }
    await store.setJSON("cfg:" + slug, nueva);
    return json({ ok: true });
  }

  if (b.accion === "global") {
    if (yo.rol !== "admin") return json({ error: "rol" }, 403);
    if (b.guardar) {
      const hora = /^\d{2}:\d{2}$/.test(b.hora || "") ? b.hora : CFG_DEF.hora;
      const dias = Math.max(0, Math.min(60, parseInt(b.dias, 10) || CFG_DEF.dias));
      await store.setJSON("cfg:_global", { hora, dias });
    }
    return json({ ok: true, general: (await efectiva(store, "_x_")).general });
  }

  if (b.accion === "mapa") {
    // Columnas del Excel de esta agencia (para que la próxima vez se reconozcan solas)
    if (!esSlug(slug)) return json({ error: "agencia" }, 400);
    const previa = (await store.get("cfg:" + slug, { type: "json" })) || {};
    const cols = {};
    for (const k of ["nombre", "destino", "ida", "vuelta", "tel", "email"]) cols[k] = limpio((b.cols || {})[k], 80);
    await store.setJSON("cfg:" + slug, { ...previa, mapa: cols });
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
