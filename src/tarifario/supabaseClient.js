const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// El cliente de Supabase arma internamente un RealtimeClient (para
// suscripciones en vivo, que acá no usamos — solo hacemos lecturas y
// escrituras normales) y necesita un WebSocket para eso. Node 20 (la imagen
// del Dockerfile de Render) todavía no trae WebSocket nativo — sin esto
// tira "Node.js detected but native WebSocket not found" al primer uso.

// Cliente único, creado la primera vez que se necesita. Si las variables de
// entorno todavía no están configuradas (proyecto nuevo, recién creado)
// devuelve null en vez de lanzar — así el resto de Tarifario/Estado de Pago
// sigue funcionando normal, y solo se avisa que el guardado en base de
// datos está desactivado hasta que se configure.
let cliente;

function getSupabase() {
  if (cliente !== undefined) return cliente;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    cliente = null;
    return cliente;
  }
  cliente = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { transport: WebSocket },
  });
  return cliente;
}

module.exports = { getSupabase };
