import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';

import type { OrderLocation } from '../../types';
import type { AppCity } from '../../domain/cities';
import { build2GisLink } from '../../utils/location';
import { dgABLink } from '../../utils/2gis';
import { buildInlineKeyboard } from './common';

export interface OrderLocationsKeyboardOptions {
  pickupLabel?: string;
  dropoffLabel?: string;
  routeLabel?: string;
}

export const buildOrderLocationsKeyboard = (
  city: AppCity,
  pickup: OrderLocation,
  dropoff: OrderLocation,
  options: OrderLocationsKeyboardOptions = {},
): InlineKeyboardMarkup => {
  const pickupUrl =
    pickup.twoGisUrl && pickup.twoGisUrl.length > 0
      ? pickup.twoGisUrl
      : build2GisLink(pickup.latitude, pickup.longitude, {
          query: pickup.address,
          city,
        });
  const dropoffUrl =
    dropoff.twoGisUrl && dropoff.twoGisUrl.length > 0
      ? dropoff.twoGisUrl
      : build2GisLink(dropoff.latitude, dropoff.longitude, {
          query: dropoff.address,
          city,
        });

  const pickupLabel = options.pickupLabel ?? '🅰️ Открыть в 2ГИС (A)';
  const dropoffLabel = options.dropoffLabel ?? '🅱️ Открыть в 2ГИС (B)';
  const routeLabel = options.routeLabel ?? '➡️ Маршрут (2ГИС)';
  const routeUrl = dgABLink(city, pickup.query, dropoff.query);

  return buildInlineKeyboard([
    [
      { label: pickupLabel, url: pickupUrl },
      { label: dropoffLabel, url: dropoffUrl },
    ],
    [{ label: routeLabel, url: routeUrl }],
  ]);
};
