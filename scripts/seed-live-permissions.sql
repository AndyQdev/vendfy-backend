-- ═══════════════════════════════════════════════════════════════════
-- Los dos permisos del Modo Live, y su enganche a los roles que ya
-- gestionan la tienda.
--
-- Existe como script aparte y no como paso del seeder porque `runSeeders()`
-- no se puede correr sobre una base con datos: crea roles, un super admin y
-- tiendas de ejemplo sin comprobar si ya están. Esto, en cambio, es idempotente
-- y no toca nada más: se puede ejecutar dos veces sin consecuencias.
--
--   psql "$DATABASE_URL" -f scripts/seed-live-permissions.sql
--
-- O desde el repo:  npm run typeorm -- query "$(cat scripts/seed-live-permissions.sql)"
-- ═══════════════════════════════════════════════════════════════════

-- 1. Los permisos. Los nombres tienen que coincidir EXACTAMENTE con los
--    valores del enum PERMISSION: el guard compara por nombre, no por clave.
INSERT INTO permission (name, description, type)
SELECT v.name, v.description, v.type
  FROM (VALUES
    ('Ver lives',       'Permite ver lives',       'inventory'),
    ('Gestionar lives', 'Permite gestionar lives', 'inventory')
  ) AS v(name, description, type)
 WHERE NOT EXISTS (
   SELECT 1 FROM permission p WHERE p.name = v.name
 );

-- 2. El enganche a los roles.
--    Se le dan a todo rol que ya pueda gestionar productos: quien da de alta
--    mercadería es quien va a transmitir. No se toca ningún otro rol, así que
--    nadie gana acceso a algo que antes no tenía en su propio terreno.
INSERT INTO permission_rol (permission_id, role_id)
SELECT nuevo.id, pr.role_id
  FROM permission nuevo
  JOIN permission_rol pr ON pr.permission_id = (
         SELECT id FROM permission WHERE name = 'Gestionar productos'
       )
 WHERE nuevo.name IN ('Ver lives', 'Gestionar lives')
   AND NOT EXISTS (
     SELECT 1 FROM permission_rol ya
      WHERE ya.permission_id = nuevo.id
        AND ya.role_id = pr.role_id
   );

-- 3. Qué quedó.
SELECT r.name AS rol, p.name AS permiso
  FROM permission_rol pr
  JOIN permission p ON p.id = pr.permission_id
  JOIN role r       ON r.id = pr.role_id
 WHERE p.name IN ('Ver lives', 'Gestionar lives')
 ORDER BY r.name, p.name;
