import crypto from 'crypto';

import type { AppCity } from '../../domain/cities';
import { pool } from '../../db';
import { logger } from '../../config';
import type { OrderLocation } from '../../types';

export type RecentLocationKind = 'pickup' | 'dropoff';

interface RecentLocationRow {
  location_id: string;
  query: string;
  address: string;
  lat: number;
  lon: number;
  two_gis_url: string | null;
}

const buildLocationId = (location: OrderLocation): string =>
  crypto
    .createHash('sha1')
    .update(`${location.query}|${location.address}|${location.latitude}|${location.longitude}`)
    .digest('hex');

const mapRowToLocation = (row: RecentLocationRow): OrderLocation => ({
  query: row.query,
  address: row.address,
  latitude: Number(row.lat),
  longitude: Number(row.lon),
  twoGisUrl: row.two_gis_url ?? undefined,
});

const RECENT_LOCATION_ID_HEX_LENGTH = 40;
const HEX_LOCATION_ID_PATTERN = /^[a-f0-9]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const encodeRecentLocationId = (locationId: string): string | null => {
  if (!HEX_LOCATION_ID_PATTERN.test(locationId) || locationId.length !== RECENT_LOCATION_ID_HEX_LENGTH) {
    logger.warn({ locationId }, 'Attempted to encode invalid recent location id');
    return null;
  }

  try {
    return Buffer.from(locationId, 'hex').toString('base64url');
  } catch (error) {
    logger.warn({ err: error, locationId }, 'Failed to encode recent location id');
    return null;
  }
};

export const decodeRecentLocationId = (value: string): string | null => {
  if (!value) {
    return null;
  }

  if (HEX_LOCATION_ID_PATTERN.test(value) && value.length === RECENT_LOCATION_ID_HEX_LENGTH) {
    return value;
  }

  if (!BASE64URL_PATTERN.test(value)) {
    return null;
  }

  try {
    const buffer = Buffer.from(value, 'base64url');
    const hex = buffer.toString('hex');
    return hex.length === RECENT_LOCATION_ID_HEX_LENGTH ? hex : null;
  } catch (error) {
    logger.warn({ err: error, value }, 'Failed to decode recent location id');
    return null;
  }
};

export const rememberLocation = async (
  userId: number,
  city: AppCity,
  kind: RecentLocationKind,
  location: OrderLocation,
): Promise<void> => {
  const locationId = buildLocationId(location);
  try {
    await pool.query(
      `
        INSERT INTO user_recent_locations (
          user_id,
          city,
          kind,
          location_id,
          query,
          address,
          lat,
          lon,
          two_gis_url,
          last_used_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
        ON CONFLICT (user_id, city, kind, location_id) DO UPDATE
        SET query = EXCLUDED.query,
            address = EXCLUDED.address,
            lat = EXCLUDED.lat,
            lon = EXCLUDED.lon,
            two_gis_url = EXCLUDED.two_gis_url,
            last_used_at = now()
      `,
      [
        userId,
        city,
        kind,
        locationId,
        location.query,
        location.address,
        location.latitude,
        location.longitude,
        location.twoGisUrl ?? null,
      ],
    );
  } catch (error) {
    logger.warn(
      { err: error, userId, city, kind, locationId },
      'Failed to remember recent location; continuing without persistence',
    );
  }
};

export interface RecentLocationOption {
  locationId: string;
  label: string;
}

export const loadRecentLocations = async (
  userId: number,
  city: AppCity,
  kind: RecentLocationKind,
  limit = 3,
): Promise<RecentLocationOption[]> => {
  try {
    const { rows } = await pool.query<RecentLocationRow>(
      `
        SELECT location_id, query, address, lat, lon, two_gis_url
        FROM user_recent_locations
        WHERE user_id = $1 AND city = $2 AND kind = $3
        ORDER BY last_used_at DESC
        LIMIT $4
      `,
      [userId, city, kind, limit],
    );

    return rows.map((row) => ({ locationId: row.location_id, label: row.address }));
  } catch (error) {
    logger.warn(
      { err: error, userId, city, kind, limit },
      'Failed to load recent locations; falling back to empty list',
    );
    return [];
  }
};

export const findRecentLocation = async (
  userId: number,
  city: AppCity,
  kind: RecentLocationKind,
  locationId: string,
): Promise<OrderLocation | null> => {
  try {
    const { rows } = await pool.query<RecentLocationRow>(
      `
        SELECT location_id, query, address, lat, lon, two_gis_url
        FROM user_recent_locations
        WHERE user_id = $1 AND city = $2 AND kind = $3 AND location_id = $4
        LIMIT 1
      `,
      [userId, city, kind, locationId],
    );

    const [row] = rows;
    if (!row) {
      return null;
    }

    return mapRowToLocation(row);
  } catch (error) {
    logger.warn(
      { err: error, userId, city, kind, locationId },
      'Failed to find recent location; falling back to manual entry',
    );
    return null;
  }
};
