import type { AppCity } from '../domain/cities';

export type OrderKind = 'taxi' | 'delivery';

export type OrderStatus = 'open' | 'claimed' | 'cancelled' | 'done';

export interface OrderLocation {
  query: string;
  address: string;
  latitude: number;
  longitude: number;
  twoGisUrl?: string;
}

export interface OrderPriceDetails {
  amount: number;
  currency: string;
  distanceKm: number;
  etaMinutes: number;
}

export interface OrderExecutorInfo {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface OrderRecord {
  id: number;
  shortId: string;
  kind: OrderKind;
  status: OrderStatus;
  city: AppCity;
  clientId?: number;
  clientPhone?: string;
  recipientPhone?: string;
  customerName?: string;
  customerUsername?: string;
  clientComment?: string;
  apartment?: string;
  entrance?: string;
  floor?: string;
  isPrivateHouse?: boolean;
  claimedBy?: number;
  claimedAt?: Date;
  completedAt?: Date;
  pickup: OrderLocation;
  dropoff: OrderLocation;
  price: OrderPriceDetails;
  channelMessageId?: number;
  createdAt: Date;
}

export interface OrderWithExecutor extends OrderRecord {
  executor?: OrderExecutorInfo;
}

export interface OrderInsertInput {
  kind: OrderKind;
  city: AppCity;
  clientId?: number;
  clientPhone?: string;
  recipientPhone?: string;
  customerName?: string;
  customerUsername?: string;
  clientComment?: string;
  apartment?: string;
  entrance?: string;
  floor?: string;
  isPrivateHouse?: boolean;
  pickup: OrderLocation;
  dropoff: OrderLocation;
  price: OrderPriceDetails;
}
