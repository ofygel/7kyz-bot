export const CLIENT_ORDERS_ACTION = 'client:orders:list';
export const CLIENT_VIEW_ORDER_ACTION_PREFIX = 'client:orders:view';
export const CLIENT_CANCEL_ORDER_ACTION_PREFIX = 'client:orders:cancel';
export const CLIENT_CONFIRM_CANCEL_ORDER_ACTION_PREFIX = 'client:orders:cancel-confirm';
export const CLIENT_ORDER_AGAIN_ACTION = 'client:order:again';
export const CLIENT_TAXI_ORDER_AGAIN_ACTION = `${CLIENT_ORDER_AGAIN_ACTION}:taxi`;
export const CLIENT_DELIVERY_ORDER_AGAIN_ACTION = `${CLIENT_ORDER_AGAIN_ACTION}:delivery`;

export const CLIENT_VIEW_ORDER_ACTION_PATTERN = new RegExp(
  `^${CLIENT_VIEW_ORDER_ACTION_PREFIX}:(\\d+)$`,
);
export const CLIENT_CANCEL_ORDER_ACTION_PATTERN = new RegExp(
  `^${CLIENT_CANCEL_ORDER_ACTION_PREFIX}:(\\d+)$`,
);
export const CLIENT_CONFIRM_CANCEL_ORDER_ACTION_PATTERN = new RegExp(
  `^${CLIENT_CONFIRM_CANCEL_ORDER_ACTION_PREFIX}:(\\d+)$`,
);
