import { EventEmitter } from 'events';

import type { OrderRecord, OrderStatus } from '../types';

export type OrderEventType = 'created' | 'updated' | 'cancelled' | 'expired' | 'completed';

export interface OrderEventPayload {
  readonly type: OrderEventType;
  readonly order: OrderRecord;
}

type OrderEventListener = (payload: OrderEventPayload) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const mapStatusToEvent = (status: OrderStatus): OrderEventType => {
  switch (status) {
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'finished':
      return 'completed';
    default:
      return 'updated';
  }
};

export const buildStatusEvent = (order: OrderRecord): OrderEventPayload => ({
  type: mapStatusToEvent(order.status),
  order,
});

export const emitOrderEvent = (payload: OrderEventPayload): void => {
  emitter.emit('event', payload);
  emitter.emit(payload.type, payload);
};

export const emitStatusEvent = (order: OrderRecord): void => {
  emitOrderEvent(buildStatusEvent(order));
};

export const subscribeToOrderEvents = (listener: OrderEventListener): (() => void) => {
  emitter.on('event', listener);
  return () => {
    emitter.off('event', listener);
  };
};

export const subscribeToOrder = (
  orderId: number,
  listener: OrderEventListener,
): (() => void) => {
  const handler: OrderEventListener = (payload) => {
    if (payload.order.id === orderId) {
      listener(payload);
    }
  };

  emitter.on('event', handler);

  return () => {
    emitter.off('event', handler);
  };
};

export const onceOrderEvent = (
  orderId: number,
  listener: OrderEventListener,
): (() => void) => {
  const handler: OrderEventListener = (payload) => {
    if (payload.order.id !== orderId) {
      return;
    }

    listener(payload);
    emitter.off('event', handler);
  };

  emitter.on('event', handler);

  return () => {
    emitter.off('event', handler);
  };
};

export const OrderEvents = {
  mapStatusToEvent,
};
