import { CITY_2GIS_SLUG, type AppCity } from '../domain/cities';

const buildBase = (city: AppCity): string => `https://2gis.kz/${CITY_2GIS_SLUG[city]}`;

export const dgBase = (city: AppCity): string => buildBase(city);

export const dgPointLink = (city: AppCity, query: string): string =>
  `${buildBase(city)}/search/${encodeURIComponent(query)}`;

export const dgABLink = (city: AppCity, from: string, to: string): string =>
  `${buildBase(city)}/directions/points/${encodeURIComponent(from)}~${encodeURIComponent(to)}`;

export const extractTwoGisCitySlug = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const segments = url.pathname
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    const [first] = segments;
    return first ? first.toLowerCase() : null;
  } catch {
    return null;
  }
};
