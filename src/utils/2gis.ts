import { CITY_2GIS_SLUG, type AppCity } from '../domain/cities';

const buildBase = (city: AppCity): string => `https://2gis.kz/${CITY_2GIS_SLUG[city]}`;

export const dgBase = (city: AppCity): string => buildBase(city);

export const dgPointLink = (city: AppCity, query: string): string =>
  `${buildBase(city)}/search/${encodeURIComponent(query)}`;

export const dgABLink = (city: AppCity, from: string, to: string): string =>
  `${buildBase(city)}/directions/points/${encodeURIComponent(from)}~${encodeURIComponent(to)}`;
