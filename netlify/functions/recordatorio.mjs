// Recordatorios de envío para el calendario del móvil (.ics).
// La herramienta de enlaces pide aquí un archivo de calendario con uno o varios avisos:
// el día y la hora elegidos salta el aviso y, al tocar el enlace, se abre WhatsApp con el mensaje ya escrito.
// GET  /.netlify/functions/recordatorio?d=<json en base64url>   (un cliente)
// POST /.netlify/functions/recordatorio   campo "datos" = json   (varios clientes)
// json = [{ t: "título", u: "https://wa.me/...", w: "2026-09-30T10:00" }, ...]

const b64url = s => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const escTxt = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// Las líneas de un .ics no pueden pasar de 75 bytes: se parten con salto + espacio
function doblar(linea) {
  const bytes = Buffer.from(linea, "utf8");
  if (bytes.length <= 75) return linea;
  const partes = []; let i = 0, max = 75;
  while (i < bytes.length) {
    let fin = Math.min(i + max, bytes.length);
    while (fin < bytes.length && (bytes[fin] & 0xc0) === 0x80) fin--; // no cortar una letra por la mitad
    partes.push(bytes.slice(i, fin).toString("utf8")); i = fin; max = 74;
  }
  return partes.join("\r\n ");
}

export default async (req) => {
  let datos = [];
  try {
    const url = new URL(req.url);
    if (req.method === "POST") {
      const form = await req.formData();
      datos = JSON.parse(String(form.get("datos") || "[]"));
    } else {
      datos = JSON.parse(b64url(url.searchParams.get("d") || ""));
    }
  } catch (e) { return new Response("Datos no válidos", { status: 400 }); }
  if (!Array.isArray(datos)) datos = [datos];
  datos = datos.filter(e => e && /^https:\/\/wa\.me\//.test(e.u || "") && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e.w || "")).slice(0, 300);
  if (!datos.length) return new Response("Sin recordatorios", { status: 400 });

  const ahora = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Maleta Facil//Recordatorios//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  datos.forEach((e, i) => {
    const t = String(e.t || "Enviar maleta").slice(0, 120);
    const inicio = e.w.replace(/[-:]/g, "") + "00"; // hora local del móvil
    const texto = "Toca el enlace: se abre WhatsApp con el mensaje ya escrito. Solo tienes que pulsar enviar.\n\n" + e.u;
    L.push("BEGIN:VEVENT",
      `UID:mf-${inicio}-${i}-${Math.random().toString(36).slice(2, 10)}@maletafacil.com`,
      `DTSTAMP:${ahora}`, `DTSTART:${inicio}`, "DURATION:PT15M",
      `SUMMARY:${escTxt(t)}`, `DESCRIPTION:${escTxt(texto)}`, `URL:${e.u}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escTxt(t)}`, "TRIGGER:PT0M", "END:VALARM",
      "END:VEVENT");
  });
  L.push("END:VCALENDAR");
  const ics = L.map(doblar).join("\r\n") + "\r\n";
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="maleta-recordatorio${datos.length > 1 ? "s" : ""}.ics"`,
      "cache-control": "no-store",
    },
  });
};
