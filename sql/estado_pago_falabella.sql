-- Estado de Pago (Falabella) — detalle por ruta. Correr una vez en Supabase →
-- SQL Editor, DESPUÉS de sql/estado_pago_cenco.sql (reutiliza corridas_pago).

-- Resumen completo del cálculo (totales por origen, multas, complementos, NDS
-- bajo, etc.). Solo lo usa Falabella; los cálculos de Cenco lo dejan en null.
alter table corridas_pago add column if not exists resumen jsonb;

create table if not exists detalle_pago_falabella (
  id                uuid primary key default gen_random_uuid(),
  corrida_id        uuid not null references corridas_pago(id) on delete cascade,
  origen            text,            -- Geosort | Simpli
  fecha             date,
  idruta            text,
  ct                text,
  patente           text,
  zona              text,
  tipo_ruta         text,            -- AM | PM
  terminados        integer,
  total             integer,
  nivel             numeric,         -- terminados / total
  vehiculo          text,
  tarifa_base       numeric,
  tarifa_variable   numeric,
  pago              numeric,
  servicio          text,
  observacion       text,
  estado_fila       text             -- PAGADA | SIN_TARIFA | NDS_BAJO | COMPLEMENTO
);

create index if not exists idx_detalle_falabella_corrida on detalle_pago_falabella (corrida_id);
create index if not exists idx_detalle_falabella_idruta  on detalle_pago_falabella (idruta);
create index if not exists idx_detalle_falabella_fecha   on detalle_pago_falabella (fecha);
create index if not exists idx_corridas_pago_cliente     on corridas_pago (cliente);

alter table detalle_pago_falabella enable row level security;
grant all on detalle_pago_falabella to service_role;
