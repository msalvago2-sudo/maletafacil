// Recibe el email del viajero y le envía la guía por correo. Si acepta novedades, lo guarda en la lista de Brevo.
// Las claves nunca están aquí en el código: se leen de variables de entorno en Netlify
// (BREVO_API_KEY, BREVO_LIST_ID, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME).

const WEB = 'https://maletafacil.com';

const ICONOS = [
  ['IMPRESCINDIBLE', '📍'],
  ['CONSEJO', '💡'],
  ['MOVERTE', '🚇'],
  ['PLATO', '🍽️'],
  ['COMER', '🍽️']
];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Convierte **negrita** y *cursiva* en HTML
function enriquecer(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function capitalizar(t) {
  const s = t.toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatearGuiaHTML(guia) {
  const lineas = guia.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  let html = '';
  let enLista = false;
  let seccionAbierta = false;

  const abrirTarjeta = () => {
    html += '<div style="background:#FFFFFF;border:1px solid #E6DFCF;border-radius:12px;padding:18px 20px;margin:0 0 16px;">';
    seccionAbierta = true;
  };
  const cerrarLista = () => { if (enLista) { html += '</ul>'; enLista = false; } };
  const cerrarSeccion = () => { cerrarLista(); if (seccionAbierta) { html += '</div>'; seccionAbierta = false; } };

  const ponerTitulo = (t) => {
    cerrarSeccion();
    abrirTarjeta();
    const titulo = t.replace(/[:"«»]/g, '').trim();
    const icono = (ICONOS.find(([k]) => titulo.toUpperCase().includes(k)) || [null, '✈️'])[1];
    html += `<h3 style="margin:0 0 12px;font-family:Georgia,serif;color:#12302E;font-size:17px;">${icono} ${esc(capitalizar(titulo))}</h3>`;
  };

  const ponerParrafo = (t) => {
    cerrarLista();
    if (!seccionAbierta) abrirTarjeta();
    html += `<p style="margin:0 0 10px;color:#3A3530;font-size:14px;line-height:1.6;">${enriquecer(t)}</p>`;
  };

  for (const linea of lineas) {
    const limpia = linea.replace(/^#+\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1').replace(/^\d+[.)]\s+(?=[A-ZÁÉÍÓÚÑ"])/, '').trim();

    if (/^[A-ZÁÉÍÓÚÑ0-9\s"«»]+:?$/.test(limpia) && limpia.length < 50 && /[A-ZÁÉÍÓÚÑ]{3}/.test(limpia)) {
      ponerTitulo(limpia);
      continue;
    }

    const mixto = limpia.match(/^([A-ZÁÉÍÓÚÑ\s"«»]{4,45}):\s+(.+)$/);
    if (mixto) {
      ponerTitulo(mixto[1]);
      ponerParrafo(mixto[2]);
      continue;
    }

    const item = linea.match(/^[-•]\s+(.*)$/) || linea.match(/^\*\s+(.*)$/) || linea.match(/^\d+[.)]\s+(.*)$/);
    if (item) {
      if (!seccionAbierta) abrirTarjeta();
      if (!enLista) { html += '<ul style="margin:0;padding:0 0 0 18px;">'; enLista = true; }
      const txt = item[1];
      const partes = txt.match(/^([^:]{2,70}):\s*(.+)$/);
      const cuerpo = partes
        ? `<strong style="color:#12302E;">${enriquecer(partes[1].replace(/\*/g, ''))}</strong><br>${enriquecer(partes[2])}`
        : enriquecer(txt);
      html += `<li style="margin:0 0 12px;color:#3A3530;font-size:14px;line-height:1.6;">${cuerpo}</li>`;
      continue;
    }

    ponerParrafo(linea);
  }

  cerrarSeccion();
  return html;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Datos inválidos.' }) };
  }

  const { email, destino, dias, guia, enlace, aceptaNovedades } = body;
  if (!email || !guia || !destino) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos (email, destino o guía).' }) };
  }

  // Enlace para recuperar la maleta: solo se acepta si apunta a nuestra web
  const enlaceMaleta = (typeof enlace === 'string' && enlace.startsWith(WEB + '/')) ? enlace : WEB;

  const brevoKey = process.env.BREVO_API_KEY;
  const listId = process.env.BREVO_LIST_ID;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  // Mismo correo (BREVO_SENDER_EMAIL, p. ej. hola@maletafacil.com) y solo cambia el nombre visible
  // según lo que ha pedido el usuario. La marca va primero: en el móvil el nombre se corta por el final.
  const NOMBRES_REMITENTE = {
    guia: 'Maleta Fácil · Tu guía de viaje',
    maleta: 'Maleta Fácil · Tu maleta',
    soporte: 'Maleta Fácil'
  };
  const senderName = NOMBRES_REMITENTE[body.tipo] || NOMBRES_REMITENTE.guia;

  if (!brevoKey || !senderEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Falta configurar Brevo en Netlify (BREVO_API_KEY, BREVO_SENDER_EMAIL).' }) };
  }

  try {
    // 1) Solo si ha aceptado novedades: guardar/actualizar el contacto en la lista de Brevo
    if (aceptaNovedades && listId) {
      const contactoRes = await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          listIds: [parseInt(listId, 10)],
          updateEnabled: true,
          attributes: { ULTIMO_DESTINO: destino }
        })
      });
      if (!contactoRes.ok && contactoRes.status !== 400) {
        const err = await contactoRes.json().catch(() => ({}));
        console.error('Brevo (contacto):', err.message || contactoRes.status);
        // No bloqueamos el envío de la guía por esto
      }
    }

    // 2) Enviar el email con la guía maquetada
    const guiaHTML = formatearGuiaHTML(guia);
    const destinoSeguro = esc(destino);
    const numDias = parseInt(dias, 10) || 0;
    const htmlContent = `
      <div style="background:#F6F1E4;padding:0;margin:0;">
      <div style="max-width:560px;margin:0 auto;font-family:Arial,sans-serif;">
        <div style="background:#12302E;padding:30px 24px;text-align:center;">
          <p style="margin:0;color:#F6F1E4;font-family:Georgia,serif;font-size:24px;font-weight:bold;">🧳 Maleta Fácil</p>
          <p style="margin:8px 0 0;color:#CBDAD6;font-size:12px;letter-spacing:.06em;text-transform:uppercase;">Tu guía para ${destinoSeguro}</p>
        </div>
        <div style="background:#F6F1E4;padding:24px 18px;">
          <p style="margin:0 0 20px;color:#12302E;font-family:Georgia,serif;font-size:20px;font-weight:bold;text-align:center;">
            ${numDias ? `Tu viaje a ${destinoSeguro}: ${numDias} día${numDias > 1 ? 's' : ''}${numDias > 1 ? ` y ${numDias - 1} noche${numDias > 2 ? 's' : ''}` : ''}` : `Tu viaje a ${destinoSeguro}`}
          </p>
          ${guiaHTML}
          <div style="text-align:center;margin:24px 0 8px;">
            <a href="${esc(enlaceMaleta)}" style="display:inline-block;background:#12302E;color:#F6F1E4;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 24px;border-radius:999px;">Ver mi lista de maleta</a>
          </div>
        </div>
        <div style="background:#12302E;padding:16px 24px;text-align:center;">
          <p style="margin:0;color:#8FA9A4;font-size:11px;">Generada con Maleta Fácil · <a href="${WEB}" style="color:#F6F1E4;">maletafacil.com</a></p>
        </div>
      </div>
      </div>`;

    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email }],
        subject: `🧳 Tu guía de viaje para ${destino}`,
        htmlContent
      })
    });

    if (!emailRes.ok) {
      const err = await emailRes.json().catch(() => ({}));
      return { statusCode: 502, body: JSON.stringify({ error: 'Brevo (email): ' + (err.message || emailRes.status) }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Fallo al procesar la guía: ' + e.message }) };
  }
};
