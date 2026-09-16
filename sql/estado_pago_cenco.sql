-- Estado de Pago (Cenco) — historial de cálculos, para consultar más
-- adelante. Correr esto una vez en Supabase → SQL Editor, en un proyecto
-- nuevo o existente.
--
-- Una "corrida" es un cálculo de Estado de Pago para un rango de fechas
-- (botón "Procesar" en el panel). Cada vez que se procesa, queda guardada
-- una corrida nueva — no se sobrescriben las anteriores, así se puede ver
-- qué se calculó y cuándo, incluso si después se corrige una tarifa.

create table if not exists corridas_pago (
  id                            uuid primary key default gen_random_uuid(),
  cliente                       text not null default 'cenco',
  fecha_inicio                  date not null,
  fecha_fin                     date not null,
  festivos                      text[],
  ejecutado_at                  timestamptz not null default now(),
  total_pedidos                 integer not null default 0,
  total_pago                    numeric not null default 0,
  resumen_por_sala              jsonb,
  sin_codigo_tienda             integer not null default 0,
  sin_sala_asignada             integer not null default 0,
  sin_coordenadas               integer not null default 0,
  fuera_de_todos_los_poligonos  integer not null default 0,
  sin_tarifa_configurada        integer not null default 0,
  fuera_de_vigencia             integer not null default 0,
  errores_descarga              jsonb
);

create table if not exists detalle_pago (
  id                     uuid primary key default gen_random_uuid(),
  corrida_id             uuid not null references corridas_pago(id) on delete cascade,
  orden_id               text not null,
  fecha                  date,
  sala                   text,
  zona                   text,
  tipo_dia               text,
  estado                 text,
  tarifa_base            numeric,
  bono                   numeric,
  multiplicador          numeric,
  monto_pago_conductor   numeric,
  motivo                 text
);

create index if not exists idx_corridas_pago_fechas   on corridas_pago (fecha_inicio, fecha_fin);
create index if not exists idx_corridas_pago_ejecutado on corridas_pago (ejecutado_at desc);
create index if not exists idx_detalle_pago_corrida   on detalle_pago (corrida_id);
create index if not exists idx_detalle_pago_orden     on detalle_pago (orden_id);
create index if not exists idx_detalle_pago_fecha     on detalle_pago (fecha);

-- El backend escribe/lee con la Service Role Key (bypassa RLS), así que
-- Row Level Security se deja activado por defecto sin políticas — nadie
-- puede leer/escribir estas tablas usando la clave "anon" pública.
alter table corridas_pago enable row level security;
alter table detalle_pago  enable row level security;

-- Tablas creadas por SQL directo (en vez del Table Editor) a veces no
-- heredan el grant automático a service_role — sin este permiso explícito
-- el backend recibe "permission denied for table ..." aunque la tabla
-- exista y RLS esté bien configurado (service_role bypassa RLS, pero
-- igual necesita el grant base de Postgres para tocar la tabla).
grant all on corridas_pago to service_role;
grant all on detalle_pago  to service_role;
