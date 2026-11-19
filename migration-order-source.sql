-- Migración: Asignar permiso "Ver reportes" a todos los roles que ya tienen "Ver pedidos"
-- Ejecutar esto para que tu usuario actual pueda acceder a los endpoints de reportes

-- 1. Asegurar que el permiso "Ver reportes" existe
INSERT INTO "permission" ("id", "name", "description", "type", "created_at", "updated_at", "enabled")
SELECT gen_random_uuid(), 'Ver reportes', 'Permite ver reportes', 'admin', NOW(), NOW(), true
WHERE NOT EXISTS (SELECT 1 FROM "permission" WHERE "name" = 'Ver reportes');

-- 2. Asignar "Ver reportes" a todos los roles que ya tienen "Ver pedidos"
INSERT INTO "permission_rol" ("id", "created_at", "updated_at", "enabled", "permissionId", "roleId")
SELECT gen_random_uuid(), NOW(), NOW(), true, p.id, pr."roleId"
FROM "permission" p
CROSS JOIN (
  SELECT DISTINCT pr2."roleId"
  FROM "permission_rol" pr2
  JOIN "permission" p2 ON p2.id = pr2."permissionId"
  WHERE p2."name" = 'Ver pedidos'
) pr
WHERE p."name" = 'Ver reportes'
AND NOT EXISTS (
  SELECT 1 FROM "permission_rol" pr3
  WHERE pr3."permissionId" = p.id AND pr3."roleId" = pr."roleId"
);
