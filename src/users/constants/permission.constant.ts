export const PERMISSION_KEY = 'permissions';

/**
 * Sistema de permisos granular para ecommerce multi-vendor
 * Patrón: SHOW_[ENTIDAD] para GET (lectura)
 *         GESTIONAR_[ENTIDAD] para CREATE, UPDATE, DELETE (escritura)
 */
export enum PERMISSION {
  // ========== USUARIOS Y ACCESOS (SISTEMA) ==========
  SHOW_USUARIOS = 'Ver usuarios',
  GESTIONAR_USUARIOS = 'Gestionar usuarios',
  
  SHOW_ROLES = 'Ver roles',
  GESTIONAR_ROLES = 'Gestionar roles',
  
  SHOW_PERMISOS = 'Ver permisos',
  GESTIONAR_PERMISOS = 'Gestionar permisos',

  // ========== TIENDAS (COMPANY) ==========
  SHOW_TIENDAS = 'Ver tiendas',
  GESTIONAR_TIENDAS = 'Gestionar tiendas',
  
  SHOW_MARCAS = 'Ver marcas',
  GESTIONAR_MARCAS = 'Gestionar marcas',

  // ========== PRODUCTOS E INVENTARIO ==========
  SHOW_PRODUCTOS = 'Ver productos',
  GESTIONAR_PRODUCTOS = 'Gestionar productos',
  
  SHOW_CATEGORIAS = 'Ver categorías',
  GESTIONAR_CATEGORIAS = 'Gestionar categorías',
  
  SHOW_INVENTARIO = 'Ver inventario',
  GESTIONAR_INVENTARIO = 'Gestionar inventario',

  // ========== PEDIDOS Y VENTAS ==========
  SHOW_PEDIDOS = 'Ver pedidos',
  GESTIONAR_PEDIDOS = 'Gestionar pedidos',
  
  SHOW_VENTAS = 'Ver ventas',
  GESTIONAR_VENTAS = 'Gestionar ventas',

  // ========== CRM (CLIENTES) ==========
  SHOW_CLIENTES = 'Ver clientes',
  GESTIONAR_CLIENTES = 'Gestionar clientes',

  // ========== MODO LIVE ==========
  SHOW_LIVE = 'Ver lives',
  GESTIONAR_LIVE = 'Gestionar lives',

  // ========== INTEGRACIONES ==========
  SHOW_WHATSAPP = 'Ver WhatsApp',
  GESTIONAR_WHATSAPP = 'Gestionar WhatsApp',

  SHOW_MARKETING = 'Ver marketing',
  GESTIONAR_MARKETING = 'Gestionar marketing',

  // ========== REPORTES ==========
  SHOW_REPORTES = 'Ver reportes',
  GESTIONAR_REPORTES = 'Gestionar reportes',

  // ========== CONFIGURACIÓN ==========
  SHOW_CONFIGURACION = 'Ver configuración',
  GESTIONAR_CONFIGURACION = 'Gestionar configuración',
}
