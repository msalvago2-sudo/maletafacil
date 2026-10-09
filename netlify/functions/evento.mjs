// Estadísticas anónimas por agencia y mes (sin datos personales): maletas enviadas, maletas abiertas,
// clics a Amazon y a Civitatis y destinos más frecuentes.
// POST/GET /.netlify/functions/evento?ev=abre|envio|amazon|civitatis&ag=SLUG&des=Destino&k=/ruta/del/enlace
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const EVENTOS = { abre: "aperturas", envio: "envios", amazon: "amazon", civitatis: "civitatis", sintel: "sinTelefono" };
const diaEn = (tz = "Europe/Madrid") => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const mesEn = (tz = "Europe/Madrid") => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const bonito = s => String(s || "").replace(/[-_]+/g, " ").trim().replace(/(^|\s)\S/g, l => l.toUpperCase()).slice(0, 40);

// Suma un evento a la agencia (lo usan también viajes.mjs al enviar desde "Hoy" o desde el email)
export async function sumar(slug, ev, des = "", clave = "") {
  const campo = EVENTOS[ev];
  if (!campo || !/^[a-z0-9-]{1,40}$/.test(slug || "")) return false;
  const store = getStore({ name: "estadisticas", consistency: "strong" });
  const key = `st:${slug}:${mesEn()}`;
  const d = (await store.get(key, { type: "json" })) || { envios: 0, aperturas: 0, amazon: 0, civitatis: 0, destinos: {}, vistos: [] };
  if (!Array.isArray(d.vistos)) d.vistos = [];
  if (campo === "envios" && clave) {
    // Una maleta enviada cuenta una vez: si se reenvía (por un error, o desde otro botón) no suma otra vez
    const h = "e" + createHash("sha1").update(String(clave)).digest("hex").slice(0, 12);
    if (d.vistos.includes(h)) return false;
    d.vistos.push(h); if (d.vistos.length > 5000) d.vistos = d.vistos.slice(-5000);
  }
  if (campo === "aperturas") {
    // Una maleta abierta cuenta una vez (aunque el cliente la abra varias veces): se recuerda solo una huella del enlace
    const h = createHash("sha1").update(String(clave || "")).digest("hex").slice(0, 12);
    if (clave && d.vistos.includes(h)) return false;
    if (clave) { d.vistos.push(h); if (d.vistos.length > 5000) d.vistos = d.vistos.slice(-5000); }
  }
  d[campo] = (d[campo] || 0) + 1;
  const dd = bonito(des);
  if (dd && campo === "envios") { // destinos de las maletas enviadas (sin contar dos veces al abrirlas)
    d.destinos[dd] = (d.destinos[dd] || 0) + 1;
    const orden = Object.entries(d.destinos).sort((a, b) => b[1] - a[1]).slice(0, 40);
    d.destinos = Object.fromEntries(orden);
  }
  await store.setJSON(key, d);
  // Además, el día (para ver la evolución: ayer, última semana, fechas a elegir)
  const kd = `dia:${slug}:${diaEn()}`;
  const x = (await store.get(kd, { type: "json" })) || { envios: 0, aperturas: 0, amazon: 0, civitatis: 0, sinTelefono: 0, destinos: {} };
  x[campo] = (x[campo] || 0) + 1;
  if (dd && campo === "envios") x.destinos[dd] = (x.destinos[dd] || 0) + 1;
  await store.setJSON(kd, x);
  return true;
}

// Estadísticas de un rango de días (desde/hasta en AAAA-MM-DD): totales por agencia y evolución día a día
export async function leerRango(desde, hasta, soloSlug = "") {
  const store = getStore({ name: "estadisticas", consistency: "strong" });
  const { blobs } = await store.list({ prefix: "dia:" });
  const agencias = {}, dias = {};
  for (const b of blobs) {
    const [, slug, f] = b.key.split(":");
    if (f < desde || f > hasta || (soloSlug && slug !== soloSlug)) continue;
    const d = (await store.get(b.key, { type: "json" })) || {};
    const a = agencias[slug] || (agencias[slug] = { envios: 0, aperturas: 0, amazon: 0, civitatis: 0, sinTelefono: 0, destinos: {} });
    const t = dias[f] || (dias[f] = { envios: 0, aperturas: 0, amazon: 0, civitatis: 0 });
    for (const k of ["envios", "aperturas", "amazon", "civitatis", "sinTelefono"]) { a[k] += d[k] || 0; if (k in t) t[k] += d[k] || 0; }
    for (const [x, n] of Object.entries(d.destinos || {})) a.destinos[x] = (a.destinos[x] || 0) + n;
  }
  for (const a of Object.values(agencias)) a.destinos = Object.fromEntries(Object.entries(a.destinos).sort((p, q) => q[1] - p[1]).slice(0, 10));
  const { blobs: mb } = await store.list({ prefix: "st:" });
  return { desde, hasta, agencias, dias, meses: [...new Set(mb.map(x => x.key.split(":")[2]))].sort().reverse() };
}

// Poner a cero las estadísticas de una agencia (meses y días). Solo el administrador, para borrar pruebas.
export async function borrarStats(slug) {
  const store = getStore({ name: "estadisticas", consistency: "strong" });
  let n = 0;
  for (const pre of [`st:${slug}:`, `dia:${slug}:`]) {
    const { blobs } = await store.list({ prefix: pre });
    for (const b of blobs) { await store.delete(b.key); n++; }
  }
  return n;
}

// Datos de una agencia en un mes (para el informe mensual)
export async function statsAgencia(slug, mes) {
  const store = getStore({ name: "estadisticas", consistency: "strong" });
  const d = (await store.get(`st:${slug}:${mes}`, { type: "json" })) || {};
  delete d.vistos;
  return { envios: 0, aperturas: 0, amazon: 0, civitatis: 0, sinTelefono: 0, destinos: {}, ...d };
}

export async function leerEstadisticas(mes) {
  const store = getStore({ name: "estadisticas", consistency: "strong" });
  const { blobs } = await store.list({ prefix: "st:" });
  const meses = new Set(), out = {};
  for (const b of blobs) {
    const [, slug, m] = b.key.split(":");
    meses.add(m);
    if (m !== mes) continue;
    const d = (await store.get(b.key, { type: "json" })) || {};
    delete d.vistos;
    out[slug] = d;
  }
  return { mes, meses: [...meses].sort().reverse(), agencias: out };
}

// ---------- Cómo se usa la web (anónimo, sin cookies): pasos por los que pasa cada visita ----------
// Cada visita manda cada paso una sola vez. Se guarda por día: web:AAAA-MM-DD → {o:{origen:{paso:n}}, dev:{}, des:{}}
const PASOS = new Set(["visita", "destino", "cal", "fechas", "preparar", "lista", "marca", "amazon", "civitatis", "comparte", "fin", "inst_ver", "inst_si", "instalada", "error"]);
const ORIGENES = new Set(["web", "agencia", "lanzamiento", "cliente", "guardada", "app", "guias"]);
export async function sumarPaso(paso, origen, dev, des) {
  if (!PASOS.has(paso)) return false;
  const o = ORIGENES.has(origen) ? origen : "web";
  const store = getStore({ name: "estadisticas", consistency: "strong" });
  const k = `web:${diaEn()}`;
  const d = (await store.get(k, { type: "json" })) || { o: {}, dev: {}, des: {} };
  const x = d.o[o] || (d.o[o] = {});
  x[paso] = (x[paso] || 0) + 1;
  if (paso === "visita") { const v = ["iphone", "android", "ordenador"].includes(dev) ? dev : "ordenador"; d.dev[v] = (d.dev[v] || 0) + 1; }
  const dd = bonito(des);
  if (paso === "lista" && dd) {
    d.des[dd] = (d.des[dd] || 0) + 1;
    d.des = Object.fromEntries(Object.entries(d.des).sort((a, b) => b[1] - a[1]).slice(0, 60));
  }
  await store.setJSON(k, d);
  return true;
}
export async function leerWeb(desde, hasta) {
  const store = getStore({ name: "estadisticas", consistency: "strong" });
  const { blobs } = await store.list({ prefix: "web:" });
  const out = { o: {}, dev: {}, des: {}, dias: {} };
  for (const b of blobs) {
    const f = b.key.slice(4); if (f < desde || f > hasta) continue;
    const d = (await store.get(b.key, { type: "json" })) || {};
    for (const [o, pasos] of Object.entries(d.o || {})) { const t = out.o[o] || (out.o[o] = {}); for (const [p, n] of Object.entries(pasos)) t[p] = (t[p] || 0) + n; }
    for (const [v, n] of Object.entries(d.dev || {})) out.dev[v] = (out.dev[v] || 0) + n;
    for (const [v, n] of Object.entries(d.des || {})) out.des[v] = (out.des[v] || 0) + n;
    out.dias[f] = Object.values(d.o || {}).reduce((a, x) => a + (x.visita || 0), 0);
  }
  out.des = Object.fromEntries(Object.entries(out.des).sort((a, b) => b[1] - a[1]).slice(0, 10));
  return out;
}

export default async (req) => {
  const url = new URL(req.url);
  const p = url.searchParams;
  if (p.get("ev") === "paso") {
    try { await sumarPaso(p.get("p"), p.get("o"), p.get("dev"), p.get("des")); } catch (e) {}
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  try { await sumar(String(p.get("ag") || "").toLowerCase(), p.get("ev"), p.get("des"), p.get("k")); } catch (e) {}
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};
