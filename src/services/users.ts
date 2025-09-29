import { hasUsersCitySelectedColumn, pool } from '../db';
import type { AppCity } from '../domain/cities';
import { logger } from '../config';

export class CitySelectionError extends Error {
  public readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'CitySelectionError';
    this.cause = cause;
  }
}

export const setUserCitySelected = async (telegramId: number, city: AppCity): Promise<void> => {
  if (!(await hasUsersCitySelectedColumn())) {
    return;
  }

  try {
    await pool.query(
      `
        INSERT INTO users (tg_id, city_selected, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (tg_id) DO UPDATE
        SET city_selected = EXCLUDED.city_selected,
            updated_at = now()
      `,
      [telegramId, city],
    );
  } catch (error) {
    logger.error({ err: error, telegramId, city }, 'Failed to persist user city selection');
    throw new CitySelectionError('Failed to persist city selection', error);
  }
};

export const getUserCitySelected = async (telegramId: number): Promise<AppCity | null> => {
  if (!(await hasUsersCitySelectedColumn())) {
    return null;
  }

  try {
    const { rows } = await pool.query<{ city_selected: AppCity | null }>(
      `SELECT city_selected FROM users WHERE tg_id = $1`,
      [telegramId],
    );

    const [row] = rows;
    return row?.city_selected ?? null;
  } catch (error) {
    logger.error({ err: error, telegramId }, 'Failed to load user city selection');
    throw new CitySelectionError('Failed to load city selection', error);
  }
};
