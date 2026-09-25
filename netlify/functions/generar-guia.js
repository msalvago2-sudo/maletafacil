// Genera una guía de viaje corta con Gemini (Google AI). La clave nunca está aquí en el
// código: se lee de una variable de entorno configurada en Netlify (GEMINI_API_KEY).

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const destino = (params.destino || '').trim();
  const dias = parseInt(params.dias, 10) || 5;
  const tipo = (params.tipo || 'ciudad').trim();

  if (!destino) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el destino.' }) };
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Falta configurar GEMINI_API_KEY en Netlify.' }) };
  }

  const tipoTexto = {
    playa: 'un viaje de playa y relax',
    aventura: 'un viaje de aventura y naturaleza',
    negocios: 'un viaje de negocios',
    ciudad: 'una escapada urbana'
  }[tipo] || 'un viaje';

  const prompt = `Eres un guía de viajes experto y cercano. Escribe una guía breve y práctica para ${tipoTexto} de ${dias} días en ${destino}.

Estructura en estas secciones, con títulos claros:
1. "Lo imprescindible" — 3-4 lugares o experiencias que no hay que perderse.
2. "Un consejo local" — un truco o recomendación poco conocida.
3. "Cómo moverte" — la forma más práctica de desplazarse por ${destino}.
4. "Un plato que probar" — una comida o bebida típica.

Escribe en español, en un tono cercano y directo, sin relleno ni frases genéricas de "espero que disfrutes tu viaje". Máximo 300 palabras en total. No uses markdown con almohadillas (#), usa los títulos en mayúscula seguidos de dos puntos.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 2048, temperature: 0.8 }
        })
      }
    );
    const data = await res.json();

    if (data.error) {
      return { statusCode: 502, body: JSON.stringify({ error: data.error.message || 'Gemini devolvió un error.' }) };
    }

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!texto) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Gemini no devolvió texto.' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guia: texto, destino, dias })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Fallo al generar la guía: ' + e.message }) };
  }
};
