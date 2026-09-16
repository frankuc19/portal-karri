const { createClient } = require('@supabase/supabase-js');

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
  cliente = createClient(url, key, { auth: { persistSession: false } });
  return cliente;
}

module.exports = { getSupabase };
