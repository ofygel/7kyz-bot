import { pool } from './client';

const parseNumeric = (value: string | number | null | undefined): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'number') {
    return value;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

export interface CallbackMapRecord<TPayload = unknown> {
  token: string;
  action: string;
  chatId?: number;
  messageId?: number;
  payload: TPayload;
  expiresAt: Date;
}

interface CallbackMapRow<TPayload> {
  token: string;
  action: string;
  chat_id: string | number | null;
  message_id: string | number | null;
  payload: TPayload;
  expires_at: Date | string;
}

const mapRow = <TPayload>(row: CallbackMapRow<TPayload>): CallbackMapRecord<TPayload> => ({
  token: row.token,
  action: row.action,
  chatId: parseNumeric(row.chat_id),
  messageId: parseNumeric(row.message_id),
  payload: row.payload,
  expiresAt: new Date(row.expires_at),
});

export const upsertCallbackMapRecord = async <TPayload>(
  record: CallbackMapRecord<TPayload>,
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO callback_map (
        token,
        action,
        chat_id,
        message_id,
        payload,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (token) DO UPDATE
      SET
        action = EXCLUDED.action,
        chat_id = EXCLUDED.chat_id,
        message_id = EXCLUDED.message_id,
        payload = EXCLUDED.payload,
        expires_at = EXCLUDED.expires_at
    `,
    [
      record.token,
      record.action,
      record.chatId ?? null,
      record.messageId ?? null,
      record.payload,
      record.expiresAt,
    ],
  );
};

export const loadCallbackMapRecord = async <TPayload>(
  token: string,
): Promise<CallbackMapRecord<TPayload> | null> => {
  const { rows } = await pool.query<CallbackMapRow<TPayload>>(
    `
      SELECT token, action, chat_id, message_id, payload, expires_at
      FROM callback_map
      WHERE token = $1
    `,
    [token],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  return mapRow(row);
};

export const listCallbackMapRecords = async <TPayload>(
  action: string,
): Promise<CallbackMapRecord<TPayload>[]> => {
  const { rows } = await pool.query<CallbackMapRow<TPayload>>(
    `
      SELECT token, action, chat_id, message_id, payload, expires_at
      FROM callback_map
      WHERE action = $1 AND expires_at > NOW()
    `,
    [action],
  );

  return rows.map(mapRow);
};

export const deleteCallbackMapRecord = async (token: string): Promise<void> => {
  await pool.query(`DELETE FROM callback_map WHERE token = $1`, [token]);
};

