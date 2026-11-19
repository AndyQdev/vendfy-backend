export interface IPayload {
  sub: string;           // ID del usuario
  role: string;          // ID o nombre del rol
  storeIds: string[];    // IDs de todas las tiendas del usuario
  mainStoreId: string | null; // ID de la tienda principal (primera)
}
