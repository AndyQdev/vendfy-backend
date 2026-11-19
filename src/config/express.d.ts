declare namespace Express {
  interface Request {
    /**
     * El NEGOCIO: su dueño. Con esto filtran los servicios los productos, los
     * clientes y las tiendas. Para el dueño es su propio id; para un empleado,
     * el de su dueño. La persona real está en `actorId`.
     */
    userId: string;
    /** La persona que hizo la petición (el dueño o uno de sus empleados). */
    actorId: string;
    roleId: string;
    /**
     * Nombre del rol, no su id. Lo pone AuthGuard, que ya trae el rol cargado.
     *
     * Existe para que SuperAdminGuard pueda decidir con una comparación de
     * texto en vez de volver a la base por cada petición del panel de
     * plataforma.
     */
    roleName: string;
    storeId: string;
    /** Plan, permisos y sucursales de quien pide. Lo arma AuthGuard. */
    acceso: import('../acceso/acceso.service').Acceso;
  }
}
