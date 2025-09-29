export type AppCity = 'almaty' | 'astana' | 'shymkent' | 'karaganda';

export const CITY_LABEL: Record<AppCity, string> = {
  almaty: 'Алматы',
  astana: 'Астана',
  shymkent: 'Шымкент',
  karaganda: 'Караганда',
};

export const CITY_2GIS_SLUG: Record<AppCity, string> = {
  almaty: 'almaty',
  astana: 'astana',
  shymkent: 'shymkent',
  karaganda: 'karaganda',
};

export const CITIES_ORDER: AppCity[] = ['almaty', 'astana', 'shymkent', 'karaganda'];

export const isAppCity = (value: unknown): value is AppCity =>
  typeof value === 'string' && (CITIES_ORDER as readonly string[]).includes(value);
