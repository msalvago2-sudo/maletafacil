// Función serverless: consulta el estado de un vuelo en AviationStack.
// La clave NUNCA está aquí en el código: se lee de una variable de entorno
// que configuras en Netlify (Site configuration > Environment variables > AVIATIONSTACK_KEY).
// Así, aunque cualquiera vea este archivo, no puede ver ni robar la clave.

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const flightIata = (params.flight_iata || '').trim().toUpperCase();
  const flightDate = (params.flight_date || '').trim(); // opcional, formato AAAA-MM-DD

  if (!flightIata) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Falta flight_iata (ej. IB3160, VY1234...).' })
    };
  }

  const key = process.env.AVIATIONSTACK_KEY;
  if (!key) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Falta configurar AVIATIONSTACK_KEY como variable de entorno en Netlify.' })
    };
  }

  let url = `https://api.aviationstack.com/v1/flights?access_key=${key}&flight_iata=${encodeURIComponent(flightIata)}`;
  if (flightDate) url += `&flight_date=${encodeURIComponent(flightDate)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: data.error.message || 'AviationStack devolvió un error.' })
      };
    }

    const vuelo = (data.data && data.data[0]) || null;
    if (!vuelo) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: 'No encontramos ese vuelo. En el plan gratuito solo se pueden consultar vuelos de HOY; para fechas futuras hace falta el plan Basic de pago. Revisa también que el número de vuelo esté bien escrito (ej. IB3160).'
        })
      };
    }

    const resumen = {
      aerolinea: vuelo.airline && vuelo.airline.name,
      numero: vuelo.flight && vuelo.flight.iata,
      estado: vuelo.flight_status, // scheduled, active, landed, cancelled, incident, diverted
      salida: {
        aeropuerto: vuelo.departure && vuelo.departure.airport,
        iata: vuelo.departure && vuelo.departure.iata,
        programada: vuelo.departure && vuelo.departure.scheduled,
        estimada: vuelo.departure && vuelo.departure.estimated,
        terminal: vuelo.departure && vuelo.departure.terminal,
        puerta: vuelo.departure && vuelo.departure.gate,
        retraso_min: (vuelo.departure && vuelo.departure.delay) || 0
      },
      llegada: {
        aeropuerto: vuelo.arrival && vuelo.arrival.airport,
        iata: vuelo.arrival && vuelo.arrival.iata,
        programada: vuelo.arrival && vuelo.arrival.scheduled,
        estimada: vuelo.arrival && vuelo.arrival.estimated
      }
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resumen)
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Fallo al consultar el vuelo: ' + e.message })
    };
  }
};
