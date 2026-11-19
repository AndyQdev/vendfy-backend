# Guía de Seeders

## 🌱 Descripción General

Los seeders son scripts que populan la base de datos con datos iniciales necesarios para el funcionamiento del sistema. Incluyen usuarios administradores, permisos base, categorías predeterminadas y datos de ejemplo.

## 🎯 Objetivo de los Seeders

1. **Inicialización rápida** del sistema
2. **Datos de desarrollo** consistentes
3. **Configuración base** para producción
4. **Testing** con datos predecibles

## 📁 Estructura de Seeders

```
src/database/seeders/
├── 01-permissions.seeder.ts     # Permisos del sistema
├── 02-users.seeder.ts           # Usuarios administradores
├── 03-company.seeder.ts         # Organizaciones y tiendas
├── 04-inventory.seeder.ts       # Categorías y productos
├── 05-crm.seeder.ts             # Clientes y segmentos
└── run-seeders.ts               # Ejecutor principal
```

## 🔄 Orden de Ejecución

### 1. Permissions Seeder
**Prioridad**: Primera (Base del sistema)

```typescript
// 01-permissions.seeder.ts
import { DataSource } from 'typeorm';
import { PermissionEntity } from 'src/users/entities/permission.entity';

export class PermissionsSeeder {
  async run(dataSource: DataSource): Promise<void> {
    const permissionRepository = dataSource.getRepository(PermissionEntity);

    const permissions = [
      // Inventory permissions
      { name: 'GESTIONAR_PRODUCTOS', description: 'Gestionar productos' },
      { name: 'GESTIONAR_CATEGORIAS', description: 'Gestionar categorías' },
      { name: 'GESTIONAR_INVENTARIO', description: 'Gestionar inventario' },

      // CRM permissions
      { name: 'GESTIONAR_CLIENTES', description: 'Gestionar clientes' },
      { name: 'VER_CLIENTES', description: 'Ver clientes' },

      // Company permissions
      { name: 'GESTIONAR_TIENDAS', description: 'Gestionar tiendas' },
      { name: 'GESTIONAR_MARCAS', description: 'Gestionar marcas' },

      // User permissions
      { name: 'GESTIONAR_USUARIOS', description: 'Gestionar usuarios' },
      { name: 'GESTIONAR_ROLES', description: 'Gestionar roles' },
    ];

    for (const permissionData of permissions) {
      const existingPermission = await permissionRepository.findOne({
        where: { name: permissionData.name },
      });

      if (!existingPermission) {
        const permission = permissionRepository.create(permissionData);
        await permissionRepository.save(permission);
        console.log(`✅ Permission created: ${permissionData.name}`);
      }
    }
  }
}
```

### 2. Users Seeder
**Prioridad**: Segunda (Depende de permissions)

```typescript
// 02-users.seeder.ts
import { DataSource } from 'typeorm';
import { UserEntity } from 'src/users/entities/user.entity';
import { RoleEntity } from 'src/users/entities/role.entity';
import { PermissionEntity } from 'src/users/entities/permission.entity';
import * as bcrypt from 'bcrypt';

export class UsersSeeder {
  async run(dataSource: DataSource): Promise<void> {
    const userRepository = dataSource.getRepository(UserEntity);
    const roleRepository = dataSource.getRepository(RoleEntity);
    const permissionRepository = dataSource.getRepository(PermissionEntity);

    // 1. Crear rol de Super Admin
    let superAdminRole = await roleRepository.findOne({
      where: { name: 'Super Admin' },
    });

    if (!superAdminRole) {
      const allPermissions = await permissionRepository.find();

      superAdminRole = roleRepository.create({
        name: 'Super Admin',
        description: 'Acceso completo al sistema',
        permissions: allPermissions,
      });

      await roleRepository.save(superAdminRole);
      console.log('✅ Super Admin role created');
    }

    // 2. Crear usuario administrador
    const adminExists = await userRepository.findOne({
      where: { email: 'admin@ventas.com' },
    });

    if (!adminExists) {
      const hashedPassword = await bcrypt.hash('admin123', 10);

      const adminUser = userRepository.create({
        firstName: 'Admin',
        lastName: 'Sistema',
        email: 'admin@ventas.com',
        password: hashedPassword,
        isActive: true,
        roles: [superAdminRole],
      });

      await userRepository.save(adminUser);
      console.log('✅ Admin user created: admin@ventas.com / admin123');
    }

    // 3. Crear roles específicos
    const rolesToCreate = [
      {
        name: 'Gerente de Tienda',
        description: 'Gestión completa de tienda',
        permissionNames: [
          'GESTIONAR_PRODUCTOS',
          'GESTIONAR_INVENTARIO',
          'GESTIONAR_CLIENTES',
          'VER_CLIENTES',
        ],
      },
      {
        name: 'Vendedor',
        description: 'Ventas y atención al cliente',
        permissionNames: [
          'VER_CLIENTES',
          'GESTIONAR_CLIENTES',
        ],
      },
    ];

    for (const roleData of rolesToCreate) {
      const existingRole = await roleRepository.findOne({
        where: { name: roleData.name },
      });

      if (!existingRole) {
        const permissions = await permissionRepository
          .createQueryBuilder('permission')
          .where('permission.name IN (:...names)', {
            names: roleData.permissionNames,
          })
          .getMany();

        const role = roleRepository.create({
          name: roleData.name,
          description: roleData.description,
          permissions,
        });

        await roleRepository.save(role);
        console.log(`✅ Role created: ${roleData.name}`);
      }
    }
  }
}
```

### 3. Company Seeder
**Prioridad**: Tercera (Estructura organizacional)

```typescript
// 03-company.seeder.ts
import { DataSource } from 'typeorm';
import { OrganizationEntity } from 'src/company/entities/organization.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { BrandEntity } from 'src/company/entities/brand.entity';

export class CompanySeeder {
  async run(dataSource: DataSource): Promise<void> {
    const organizationRepository = dataSource.getRepository(OrganizationEntity);
    const storeRepository = dataSource.getRepository(StoreEntity);
    const brandRepository = dataSource.getRepository(BrandEntity);

    // 1. Crear organización principal
    let organization = await organizationRepository.findOne({
      where: { name: 'Mi Empresa Demo' },
    });

    if (!organization) {
      organization = organizationRepository.create({
        name: 'Mi Empresa Demo',
        description: 'Organización de demostración',
        type: 'company',
        isActive: true,
      });

      await organizationRepository.save(organization);
      console.log('✅ Organization created: Mi Empresa Demo');
    }

    // 2. Crear tienda principal
    let store = await storeRepository.findOne({
      where: { name: 'Tienda Principal' },
    });

    if (!store) {
      store = storeRepository.create({
        name: 'Tienda Principal',
        description: 'Tienda principal de demostración',
        address: 'Calle Principal 123',
        phone: '+1234567890',
        email: 'tienda@ventas.com',
        isActive: true,
        organization,
      });

      await storeRepository.save(store);
      console.log('✅ Store created: Tienda Principal');
    }

    // 3. Crear marcas de ejemplo
    const brandsData = [
      {
        name: 'Apple',
        description: 'Productos tecnológicos de Apple',
        imageUrl: 'https://example.com/apple-logo.png',
      },
      {
        name: 'Samsung',
        description: 'Electrónicos Samsung',
        imageUrl: 'https://example.com/samsung-logo.png',
      },
      {
        name: 'Nike',
        description: 'Ropa deportiva Nike',
        imageUrl: 'https://example.com/nike-logo.png',
      },
    ];

    for (const brandData of brandsData) {
      const existingBrand = await brandRepository.findOne({
        where: { name: brandData.name },
      });

      if (!existingBrand) {
        const brand = brandRepository.create({
          ...brandData,
          store,
        });

        await brandRepository.save(brand);
        console.log(`✅ Brand created: ${brandData.name}`);
      }
    }
  }
}
```

### 4. Inventory Seeder
**Prioridad**: Cuarta (Depende de company)

```typescript
// 04-inventory.seeder.ts
import { DataSource } from 'typeorm';
import { CategoryEntity } from 'src/inventory/entities/category.entity';
import { ProductEntity } from 'src/inventory/entities/product.entity';
import { StoreEntity } from 'src/company/entities/store.entity';
import { BrandEntity } from 'src/company/entities/brand.entity';

export class InventorySeeder {
  async run(dataSource: DataSource): Promise<void> {
    const categoryRepository = dataSource.getRepository(CategoryEntity);
    const productRepository = dataSource.getRepository(ProductEntity);
    const storeRepository = dataSource.getRepository(StoreEntity);
    const brandRepository = dataSource.getRepository(BrandEntity);

    const store = await storeRepository.findOne({
      where: { name: 'Tienda Principal' },
    });

    if (!store) {
      console.log('❌ Store not found, skipping inventory seeder');
      return;
    }

    // 1. Crear categorías
    const categoriesData = [
      {
        name: 'Electrónicos',
        description: 'Dispositivos electrónicos y tecnología',
      },
      {
        name: 'Ropa',
        description: 'Vestimenta y accesorios',
      },
      {
        name: 'Hogar',
        description: 'Artículos para el hogar',
      },
      {
        name: 'Deportes',
        description: 'Equipamiento deportivo',
      },
    ];

    const createdCategories = [];

    for (const categoryData of categoriesData) {
      let category = await categoryRepository.findOne({
        where: { name: categoryData.name },
      });

      if (!category) {
        category = categoryRepository.create({
          ...categoryData,
          store,
        });

        await categoryRepository.save(category);
        console.log(`✅ Category created: ${categoryData.name}`);
      }

      createdCategories.push(category);
    }

    // 2. Crear productos de ejemplo
    const apple = await brandRepository.findOne({ where: { name: 'Apple' } });
    const samsung = await brandRepository.findOne({ where: { name: 'Samsung' } });
    const nike = await brandRepository.findOne({ where: { name: 'Nike' } });

    const electronicsCategory = createdCategories.find(c => c.name === 'Electrónicos');
    const clothingCategory = createdCategories.find(c => c.name === 'Ropa');

    const productsData = [
      {
        name: 'iPhone 15 Pro',
        description: 'Smartphone de última generación con chip A17 Pro',
        price: 999.99,
        stockQuantity: 50,
        sku: 'IPH15PRO128',
        imageUrl: 'https://example.com/iphone15pro.jpg',
        category: electronicsCategory,
        brand: apple,
      },
      {
        name: 'Samsung Galaxy S24',
        description: 'Smartphone Android premium con cámara de 200MP',
        price: 899.99,
        stockQuantity: 30,
        sku: 'SGS24256',
        imageUrl: 'https://example.com/galaxys24.jpg',
        category: electronicsCategory,
        brand: samsung,
      },
      {
        name: 'Nike Air Max 270',
        description: 'Zapatillas deportivas con tecnología Air Max',
        price: 129.99,
        stockQuantity: 75,
        sku: 'NAM270BLK42',
        imageUrl: 'https://example.com/airmax270.jpg',
        category: clothingCategory,
        brand: nike,
      },
    ];

    for (const productData of productsData) {
      const existingProduct = await productRepository.findOne({
        where: { sku: productData.sku },
      });

      if (!existingProduct) {
        const product = productRepository.create({
          ...productData,
          store,
        });

        await productRepository.save(product);
        console.log(`✅ Product created: ${productData.name}`);
      }
    }
  }
}
```

### 5. CRM Seeder
**Prioridad**: Quinta (Datos de clientes)

```typescript
// 05-crm.seeder.ts
import { DataSource } from 'typeorm';
import { CustomerEntity } from 'src/crm/entities/customer.entity';
import { StoreEntity } from 'src/company/entities/store.entity';

export class CrmSeeder {
  async run(dataSource: DataSource): Promise<void> {
    const customerRepository = dataSource.getRepository(CustomerEntity);
    const storeRepository = dataSource.getRepository(StoreEntity);

    const store = await storeRepository.findOne({
      where: { name: 'Tienda Principal' },
    });

    if (!store) {
      console.log('❌ Store not found, skipping CRM seeder');
      return;
    }

    const customersData = [
      {
        firstName: 'Ana',
        lastName: 'García',
        email: 'ana.garcia@email.com',
        phone: '+34612345678',
        address: 'Calle Mayor 123, Madrid',
        status: 'active',
      },
      {
        firstName: 'Carlos',
        lastName: 'Rodríguez',
        email: 'carlos.rodriguez@email.com',
        phone: '+34687234567',
        address: 'Avenida Diagonal 456, Barcelona',
        status: 'active',
      },
      {
        firstName: 'María',
        lastName: 'Fernández',
        email: 'maria.fernandez@email.com',
        phone: '+34654876543',
        address: 'Plaza España 789, Valencia',
        status: 'vip',
      },
    ];

    for (const customerData of customersData) {
      const existingCustomer = await customerRepository.findOne({
        where: { email: customerData.email },
      });

      if (!existingCustomer) {
        const customer = customerRepository.create({
          ...customerData,
          store,
        });

        await customerRepository.save(customer);
        console.log(`✅ Customer created: ${customerData.firstName} ${customerData.lastName}`);
      }
    }
  }
}
```

## 🎮 Ejecutor Principal

```typescript
// run-seeders.ts
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { PermissionsSeeder } from './01-permissions.seeder';
import { UsersSeeder } from './02-users.seeder';
import { CompanySeeder } from './03-company.seeder';
import { InventorySeeder } from './04-inventory.seeder';
import { CrmSeeder } from './05-crm.seeder';

async function runSeeders() {
  const configService = new ConfigService();

  const dataSource = new DataSource({
    type: 'postgres',
    host: configService.get('DATABASE_HOST'),
    port: configService.get('DATABASE_PORT'),
    username: configService.get('DATABASE_USERNAME'),
    password: configService.get('DATABASE_PASSWORD'),
    database: configService.get('DATABASE_NAME'),
    entities: ['dist/**/*.entity.js'],
    synchronize: false,
  });

  try {
    await dataSource.initialize();
    console.log('🔗 Database connected');

    // Ejecutar seeders en orden
    console.log('🌱 Running seeders...\n');

    const permissionsSeeder = new PermissionsSeeder();
    await permissionsSeeder.run(dataSource);
    console.log('');

    const usersSeeder = new UsersSeeder();
    await usersSeeder.run(dataSource);
    console.log('');

    const companySeeder = new CompanySeeder();
    await companySeeder.run(dataSource);
    console.log('');

    const inventorySeeder = new InventorySeeder();
    await inventorySeeder.run(dataSource);
    console.log('');

    const crmSeeder = new CrmSeeder();
    await crmSeeder.run(dataSource);
    console.log('');

    console.log('✅ All seeders completed successfully!');
  } catch (error) {
    console.error('❌ Error running seeders:', error);
  } finally {
    await dataSource.destroy();
  }
}

runSeeders();
```

## 📜 Scripts de NPM

```json
{
  "scripts": {
    "seed": "ts-node src/database/seeders/run-seeders.ts",
    "seed:permissions": "ts-node src/database/seeders/01-permissions.seeder.ts",
    "seed:users": "ts-node src/database/seeders/02-users.seeder.ts",
    "seed:company": "ts-node src/database/seeders/03-company.seeder.ts",
    "seed:inventory": "ts-node src/database/seeders/04-inventory.seeder.ts",
    "seed:crm": "ts-node src/database/seeders/05-crm.seeder.ts"
  }
}
```

## 🚀 Comandos de Uso

```bash
# Ejecutar todos los seeders
npm run seed

# Ejecutar seeders individuales
npm run seed:permissions
npm run seed:users
npm run seed:company
npm run seed:inventory
npm run seed:crm

# Para desarrollo - resetear y sembrar
npm run migration:reset
npm run seed
```

## 🔧 Configuración de Entorno

### Variables Necesarias
```env
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=password
DATABASE_NAME=ventas_db
```

## ⚠️ Consideraciones Importantes

### 1. Idempotencia
- Los seeders verifican si los datos ya existen
- No duplican información en múltiples ejecuciones
- Seguro ejecutar múltiples veces

### 2. Dependencias
- Respetar el orden de ejecución
- Cada seeder valida dependencias necesarias
- Fallo en seeder anterior puede afectar siguientes

### 3. Entornos
- **Desarrollo**: Datos completos para testing
- **Staging**: Datos mínimos para pruebas
- **Producción**: Solo datos esenciales (permisos, admin)

### 4. Performance
- Usar transacciones para operaciones batch
- Verificar existencia antes de crear
- Logs detallados para debugging

## 🧪 Testing con Seeders

```typescript
// En tests
beforeEach(async () => {
  await runSeeders();
});

// Datos predecibles para tests
const testUser = await userRepository.findOne({
  where: { email: 'admin@ventas.com' }
});
```

Los seeders garantizan un **estado inicial consistente** y **datos de prueba realistas** para desarrollo y testing del sistema.