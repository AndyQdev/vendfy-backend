-- Migración manual para actualizar campos de teléfono en la tabla store
-- Ejecutar estos comandos en orden:

-- 1. Agregar la nueva columna currentCountry
ALTER TABLE "store" ADD COLUMN "currentCountry" VARCHAR(5);

-- 2. Actualizar los datos existentes (extraer código de país del campo phone)
-- Asumiendo que el formato actual es '+591 12345678'
UPDATE "store" 
SET "currentCountry" = SUBSTRING("phone", 1, 4)
WHERE "phone" LIKE '+591%';

UPDATE "store" 
SET "currentCountry" = SUBSTRING("phone", 1, 3)
WHERE "phone" LIKE '+54%' OR "phone" LIKE '+55%' OR "phone" LIKE '+56%' OR "phone" LIKE '+57%' OR "phone" LIKE '+51%' OR "phone" LIKE '+58%';

UPDATE "store" 
SET "currentCountry" = SUBSTRING("phone", 1, 4)
WHERE "phone" LIKE '+593%' OR "phone" LIKE '+595%' OR "phone" LIKE '+598%';

UPDATE "store" 
SET "currentCountry" = '+1'
WHERE "phone" LIKE '+1%';

-- 3. Actualizar el campo phone para que solo contenga el número sin código de país
UPDATE "store" 
SET "phone" = TRIM(SUBSTRING("phone", 5))
WHERE "phone" LIKE '+591%';

UPDATE "store" 
SET "phone" = TRIM(SUBSTRING("phone", 4))
WHERE "phone" LIKE '+54%' OR "phone" LIKE '+55%' OR "phone" LIKE '+56%' OR "phone" LIKE '+57%' OR "phone" LIKE '+51%' OR "phone" LIKE '+58%';

UPDATE "store" 
SET "phone" = TRIM(SUBSTRING("phone", 5))
WHERE "phone" LIKE '+593%' OR "phone" LIKE '+595%' OR "phone" LIKE '+598%';

UPDATE "store" 
SET "phone" = TRIM(SUBSTRING("phone", 3))
WHERE "phone" LIKE '+1%';

-- 4. Eliminar la columna whatsappNumber
ALTER TABLE "store" DROP COLUMN IF EXISTS "whatsappNumber";

-- 5. Establecer un valor por defecto para currentCountry si es null
UPDATE "store" 
SET "currentCountry" = '+591'
WHERE "currentCountry" IS NULL;