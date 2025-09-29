import { pool } from './client';
import { logger } from '../config';

let hasUsersCitySelectedColumnCache: boolean | undefined;
let missingColumnLogged = false;

const tableExistsCache: Record<string, boolean | undefined> = {};
const missingTableLogged: Record<string, boolean> = {};

const CHECK_USERS_CITY_SELECTED_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name = 'city_selected'
  ) AS exists
`;

export const hasUsersCitySelectedColumn = async (): Promise<boolean> => {
  if (hasUsersCitySelectedColumnCache) {
    return true;
  }

  try {
    const { rows } = await pool.query<{ exists: boolean }>(CHECK_USERS_CITY_SELECTED_SQL);
    const exists = rows[0]?.exists ?? false;

    if (exists) {
      hasUsersCitySelectedColumnCache = true;
    } else if (!missingColumnLogged) {
      logger.warn(
        { column: 'users.city_selected' },
        'users.city_selected column is missing; city selection features are disabled',
      );
      missingColumnLogged = true;
    }

    return exists;
  } catch (error) {
    if (!missingColumnLogged) {
      logger.error(
        { err: error, column: 'users.city_selected' },
        'Failed to verify users.city_selected column existence',
      );
      missingColumnLogged = true;
    }

    return false;
  }
};

const CHECK_TABLE_EXISTS_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = $1
  ) AS exists
`;

const hasTable = async (table: string): Promise<boolean> => {
  if (tableExistsCache[table]) {
    return true;
  }

  try {
    const { rows } = await pool.query<{ exists: boolean }>(CHECK_TABLE_EXISTS_SQL, [table]);
    const exists = rows[0]?.exists ?? false;

    if (exists) {
      tableExistsCache[table] = true;
    } else if (!missingTableLogged[table]) {
      logger.warn({ table }, `${table} table is missing; analytics features are disabled`);
      missingTableLogged[table] = true;
    }

    return exists;
  } catch (error) {
    if (!missingTableLogged[table]) {
      logger.error({ err: error, table }, 'Failed to verify table existence');
      missingTableLogged[table] = true;
    }

    return false;
  }
};

export const hasUserExperimentsTable = (): Promise<boolean> => hasTable('user_experiments');

export const hasUiEventsTable = (): Promise<boolean> => hasTable('ui_events');
