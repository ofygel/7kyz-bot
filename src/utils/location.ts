import { dgBase } from './2gis';
import type { AppCity } from '../domain/cities';

interface Build2GisLinkOptions {
  zoom?: number;
  hostname?: string;
  query?: string;
  city?: AppCity;
}

const DEFAULT_ZOOM = 18;
const DEFAULT_2GIS_HOST = `${dgBase('almaty')}/`;

const clampZoom = (zoom: number): number => {
  if (!Number.isFinite(zoom)) {
    return DEFAULT_ZOOM;
  }

  if (zoom < 1) {
    return 1;
  }

  if (zoom > 21) {
    return 21;
  }

  return Math.round(zoom * 100) / 100;
};

const formatCoordinate = (value: number): string => {
  if (!Number.isFinite(value)) {
    throw new Error('Invalid coordinate value supplied to build2GisLink');
  }

  return value.toFixed(6);
};

const resolveBaseHost = (options: Build2GisLinkOptions): string => {
  if (options.hostname) {
    return options.hostname;
  }

  if (options.city) {
    return `${dgBase(options.city)}/`;
  }

  return DEFAULT_2GIS_HOST;
};

export const build2GisLink = (
  latitude: number,
  longitude: number,
  options: Build2GisLinkOptions = {},
): string => {
  const base = resolveBaseHost(options);
  const url = new URL(base);

  const zoom = clampZoom(options.zoom ?? DEFAULT_ZOOM);
  const lonString = formatCoordinate(longitude);
  const latString = formatCoordinate(latitude);

  url.searchParams.set('m', `${lonString},${latString}/${zoom}`);

  const query = options.query?.trim();
  if (query) {
    url.searchParams.set('q', query);
  }

  return url.toString();
};

export type { Build2GisLinkOptions };
