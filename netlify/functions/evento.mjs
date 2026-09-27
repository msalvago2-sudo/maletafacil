// Estadísticas anónimas por agencia y mes (sin datos personales): maletas enviadas, maletas abiertas,
// clics a Amazon y a Civitatis y destinos más frecuentes.
// POST/GET /.netlify/functions/evento?ev=abre|envio|amazon|civitatis&ag=SLUG&des=Destino&k=/ruta/del/enlace
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const EVENTOS = { abre: "aperturas", envio: "envios", amazon: "amazon", civitatis: "civitatis", sintel: "sinTelefono" };
const mesEn = (tz = "Europe/Madrid") => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const bonito = s => String(s || "").replace(/[-_]+/g, " ").trim().replace(/(^|\s)\S/g, l => l.toUpperCase()).slice(0, 40);

// Suma un evento a la agencia (lo usan también viajes.mjs al enviar desde "Hoy" o desde el email)
export async function sumar(slug, ev, des = "", clave = "") {
  const campo = EVENTOS[ev];
  if (!campo || !/^[a-z0-9-]{1,40}$/.test(slug || "")) return false;
  const store = getStore({ name: "estadisticas", consistency: "strong" });
  const key = `st:${slug}:${mesEn()}`;
  const d = (await store.get(key, { type: "json" })) || { envios: 0, aperturas: 0, amazon: 0, civitatis: 0, destinos: {}, vistos: [] };
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
  return true;
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

export default async (req) => {
  const url = new URL(req.url);
  const p = url.searchParams;
  try { await sumar(String(p.get("ag") || "").toLowerCase(), p.get("ev"), p.get("des"), p.get("k")); } catch (e) {}
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};
