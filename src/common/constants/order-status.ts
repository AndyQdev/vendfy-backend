export enum ORDER_STATUS {
  PENDIENTE = 'pendiente',
  EN_PROCESO = 'en-proceso',
  EN_CAMINO = 'en-camino',
  FINALIZADO = 'finalizado',
  CANCELADO = 'cancelado',
}

export const ORDER_STATUS_VALUES = Object.values(ORDER_STATUS);

// Estados que no permiten edición
export const NON_EDITABLE_STATUSES = [
  ORDER_STATUS.FINALIZADO,
  ORDER_STATUS.CANCELADO,
];

// Estados que no permiten cancelación
export const NON_CANCELLABLE_STATUSES = [
  ORDER_STATUS.FINALIZADO,
  ORDER_STATUS.EN_CAMINO,
];