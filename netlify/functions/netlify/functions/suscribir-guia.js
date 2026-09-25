// Recibe el email del viajero, lo guarda como contacto en Brevo y le envía la guía por correo.
// Las claves nunca están aquí en el código: se leen de variables de entorno en Netlify
// (BREVO_API_KEY, BREVO_LIST_ID, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME).

function formatearGuiaHTML(guia) {
  const bloques = guia.split(/\n\s*\n/).filter(Boolean);
  return bloques.map(b => {
    const lineas = b.split('\n');
    const primera = lineas[0].trim();
    const esTitulo = /^[A-ZÁÉÍÓÚÑ0-9\s]+:$/.test(primera) && primera.length < 40;
    if (esTitulo) {
      const resto = lineas.slice(1).join(' ').trim();
      return `<h3 style="font-family:Georgia,serif;color:#12302E;font-size:16px;margin:22px 0 6px;">${primera.replace(':', '')}</h3>
              <p style="margin:0;color:#3A3530;font-size:14px;line-height:1.6;">${resto}</p>`;
    }
    return `<p style="margin:0 0 14px;color:#3A3530;font-size:14px;line-height:1.6;">${b.replace(/\n/g, ' ')}</p>`;
  }).join('\n');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Datos inválidos.' }) };
  }

  const { email, destino, dias, guia } = body;
  if (!email || !guia || !destino) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos (email, destino o guía).' }) };
  }

  const brevoKey = process.env.BREVO_API_KEY;
  const listId = process.env.BREVO_LIST_ID;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Maleta Fácil';

  if (!brevoKey || !listId || !senderEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Falta configurar Brevo en Netlify (BREVO_API_KEY, BREVO_LIST_ID, BREVO_SENDER_EMAIL).' }) };
  }

  try {
    // 1) Guardar/actualizar el contacto en la lista de Brevo
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
    // Brevo devuelve 204 en éxito, o 400 "Contact already exist" si ya estaba — ambos son válidos aquí
    if (!contactoRes.ok && contactoRes.status !== 400) {
      const err = await contactoRes.json().catch(() => ({}));
      return { statusCode: 502, body: JSON.stringify({ error: 'Brevo (contacto): ' + (err.message || contactoRes.status) }) };
    }

    // 2) Enviar el email con la guía, maquetado con los colores de Maleta Fácil
    const guiaHTML = formatearGuiaHTML(guia);
    const htmlContent = `
      <div style="max-width:520px;margin:0 auto;font-family:Arial,sans-serif;">
        <div style="background:#12302E;padding:28px 24px;text-align:center;">
          <p style="margin:0;color:#F6F1E4;font-family:Georgia,serif;font-size:22px;font-weight:bold;">Maleta Fácil</p>
          <p style="margin:6px 0 0;color:#CBDAD6;font-size:12px;letter-spacing:.04em;text-transform:uppercase;">Tu guía para ${destino}</p>
        </div>
        <div style="background:#F6F1E4;padding:28px 24px;">
          <p style="margin:0 0 18px;color:#12302E;font-size:15px;font-weight:bold;">Tu viaje de ${dias} día${dias > 1 ? 's' : ''} a ${destino}</p>
          ${guiaHTML}
        </div>
        <div style="background:#12302E;padding:16px 24px;text-align:center;">
          <p style="margin:0;color:#8FA9A4;font-size:11px;">Generada con Maleta Fácil · <a href="https://maletafacil.com" style="color:#F6F1E4;">maletafacil.com</a></p>
        </div>
      </div>`;

    const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email }],
        subject: `Tu guía de viaje para ${destino}`,
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
