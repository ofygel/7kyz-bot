import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import type { OrderLocation } from '../../types';
import type { AppCity } from '../../domain/cities';
import { build2GisLink } from '../../utils/location';
import { dgABLink, dgPointLink } from '../../utils/2gis';
import { buildInlineKeyboard } from './common';

export interface OrderLocationsKeyboardOptions {
  pickupLabel?: string;
  dropoffLabel?: string;
  routeLabel?: string;
}

const isValidCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const resolveLocationUrl = (city: AppCity, location: OrderLocation): string => {
  const directUrl = location.twoGisUrl?.trim();
  if (directUrl) {
    return directUrl;
  }

  if (isValidCoordinate(location.latitude) && isValidCoordinate(location.longitude)) {
    try {
      return build2GisLink(location.latitude, location.longitude, {
        query: location.address,
        city,
      });
    } catch {
      // fall through to the query-based link below
    }
  }

  const query = location.query?.trim() || location.address;
  return dgPointLink(city, query);
};

const resolveRouteUrl = (city: AppCity, pickup: OrderLocation, dropoff: OrderLocation): string | undefined => {
  const from = pickup.query?.trim() || pickup.address;
  const to = dropoff.query?.trim() || dropoff.address;

  if (!from || !to) {
    return undefined;
  }

  return dgABLink(city, from, to);
};

export const buildOrderLocationsKeyboard = (
  city: AppCity,
  pickup: OrderLocation,
  dropoff: OrderLocation,
  options: OrderLocationsKeyboardOptions = {},
): InlineKeyboardMarkup => {
  const pickupUrl = resolveLocationUrl(city, pickup);
  const dropoffUrl = resolveLocationUrl(city, dropoff);

  const pickupLabel = options.pickupLabel ?? '🅰️ Открыть в 2ГИС (A)';
  const dropoffLabel = options.dropoffLabel ?? '🅱️ Открыть в 2ГИС (B)';
  const routeLabel = options.routeLabel ?? '➡️ Маршрут (2ГИС)';
  const routeUrl = resolveRouteUrl(city, pickup, dropoff);

  const rows: { label: string; url: string }[][] = [
    [
      { label: pickupLabel, url: pickupUrl },
      { label: dropoffLabel, url: dropoffUrl },
    ],
  ];

  if (routeUrl) {
    rows.push([{ label: routeLabel, url: routeUrl }]);
  }

  return buildInlineKeyboard(rows);
};
