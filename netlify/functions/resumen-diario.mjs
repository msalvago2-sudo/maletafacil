// Recuento diario automático: Netlify lo ejecuta cada hora en punto.
// A la hora elegida por cada agencia le manda un aviso al móvil y un email con los clientes
// a los que toca enviar hoy su maleta por WhatsApp. También borra los viajes ya terminados.
// (Toda la lógica está en viajes.mjs, función ejecutarResumen.)
import { ejecutarResumen } from "./viajes.mjs";

export default async () => {
  const informe = await ejecutarResumen();
  console.log("resumen-diario", JSON.stringify(informe));
  return new Response("ok");
};

export const config = { schedule: "@hourly" };
