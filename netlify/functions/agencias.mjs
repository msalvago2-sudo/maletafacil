// Agencias de Maleta Fácil: lista (pública) y alta/edición/baja (solo con contraseña).
// - GET  /.netlify/functions/agencias            → todas las agencias (agencias.json + las creadas desde la herramienta)
// - GET  /.netlify/functions/agencias?logo=SLUG  → logo subido desde la herramienta
// - POST /.netlify/functions/agencias            → {clave, accion:'login'|'guardar'|'borrar', ...}
// La contraseña NO está en el código: se lee de la variable de entorno MF_ADMIN_CLAVE en Netlify.
import { getStore } from "@netlify/blobs";

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
    const logo = url.searchParams.get("logo");
    if (logo) {
      if (!/^[a-z0-9-]+$/.test(logo)) return new Response("", { status: 400 });
      const r = await store.getWithMetadata("logo:" + logo, { type: "arrayBuffer" });
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
    const clave = process.env.MF_ADMIN_CLAVE;
    if (!clave || typeof body.clave !== "string" || body.clave !== clave) {
      await espera(1200); // frena los intentos a ciegas
      return json({ error: "clave" }, 401);
    }
    if (body.accion === "login") return json({ ok: true });

    const extra = (await store.get("lista", { type: "json" })) || {};

    if (body.accion === "borrar") {
      const slug = slugify(body.slug);
      if (!slug) return json({ error: "slug" }, 400);
      extra[slug] = { borrada: true };
      await store.setJSON("lista", extra);
      try { await store.delete("logo:" + slug); } catch (e) {}
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
      const a = { ...previa, nombre, tag, seguro, civitatis, modo: body.modo === "completo" ? "completo" : "" };
      if (body.logo) {
        const m = String(body.logo).match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return json({ error: "logo" }, 400);
        const bytes = Buffer.from(m[2], "base64");
        if (bytes.length > 700000) return json({ error: "logo-grande" }, 400);
        await store.set("logo:" + slug, new Blob([bytes]), { metadata: { tipo: m[1] } });
        a.logo = "/.netlify/functions/agencias?logo=" + slug + "&v=" + Date.now();
      }
      extra[slug] = a;
      await store.setJSON("lista", extra);
      return json({ ok: true, slug });
    }
    return json({ error: "accion" }, 400);
  }
  return json({ error: "metodo" }, 405);
};
