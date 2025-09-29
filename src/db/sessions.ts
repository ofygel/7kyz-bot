import type { PoolClient } from './client';

import type { SessionState } from '../bot/types';

export type SessionScope = 'chat' | 'user';

export interface SessionKey {
  scope: SessionScope;
  scopeId: string;
}

interface SessionRow {
  state: SessionState | string | null;
  safe_mode: boolean | null;
  is_degraded: boolean | null;
}

type Queryable = Pick<PoolClient, 'query'>;

const parseJsonValue = <T>(value: T | string | null | undefined): T | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return (JSON.parse(value) as T) ?? null;
  }

  if (typeof value === 'object') {
    return value as T;
  }

  return null;
};

const parseSessionPayload = (value: SessionRow['state']): SessionState => {
  if (value === null || value === undefined) {
    throw new Error('Session payload is empty');
  }

  if (typeof value === 'string') {
    return JSON.parse(value) as SessionState;
  }

  if (typeof value === 'object') {
    return value as SessionState;
  }

  throw new Error('Unsupported session payload type');
};

const parseSessionState = (row: SessionRow): SessionState => {
  const state = parseSessionPayload(row.state);

  if (typeof row.safe_mode === 'boolean') {
    state.safeMode = row.safe_mode;
  } else if (typeof (state as { safeMode?: unknown }).safeMode !== 'boolean') {
    state.safeMode = false;
  }

  const legacyState = state as { isDegraded?: unknown; degraded?: unknown };

  if (typeof row.is_degraded === 'boolean') {
    state.isDegraded = row.is_degraded;
  } else if (typeof legacyState.isDegraded === 'boolean') {
    state.isDegraded = legacyState.isDegraded;
  } else if (typeof legacyState.degraded === 'boolean') {
    state.isDegraded = legacyState.degraded;
  } else {
    state.isDegraded = false;
  }

  if ('degraded' in legacyState) {
    delete legacyState.degraded;
  }

  return state;
};

export const loadSessionState = async (
  client: PoolClient,
  key: SessionKey,
  options: { forUpdate?: boolean } = {},
): Promise<SessionState | null> => {
  const lockClause = options.forUpdate ? ' FOR UPDATE' : '';
  const { rows } = await client.query<SessionRow>(
    `
      SELECT state, safe_mode, is_degraded
      FROM sessions
      WHERE scope = $1 AND scope_id = $2${lockClause}
    `,
    [key.scope, key.scopeId],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  try {
    return parseSessionState(row);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
    throw new Error(
      `Failed to parse session state for ${key.scope}:${key.scopeId}: ${reason}`,
    );
  }
};

export const saveSessionState = async (
  queryable: Queryable,
  key: SessionKey,
  state: SessionState,
): Promise<void> => {
  let payload: string;
  try {
    payload = JSON.stringify(state);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
    throw new Error(`Failed to serialise session state: ${reason}`);
  }

  await queryable.query(
    `
      INSERT INTO sessions (scope, scope_id, state, safe_mode, is_degraded)
      VALUES ($1, $2, $3::jsonb, $4, $5)
      ON CONFLICT (scope, scope_id) DO UPDATE
      SET state = EXCLUDED.state,
          safe_mode = EXCLUDED.safe_mode,
          is_degraded = EXCLUDED.is_degraded,
          updated_at = now()
    `,
    [key.scope, key.scopeId, payload, state.safeMode === true, state.isDegraded === true],
  );
};

export const deleteSessionState = async (
  queryable: Queryable,
  key: SessionKey,
): Promise<void> => {
  await queryable.query(`DELETE FROM sessions WHERE scope = $1 AND scope_id = $2`, [
    key.scope,
    key.scopeId,
  ]);
};

const serialisePayload = (payload: unknown): string => {
  try {
    return JSON.stringify(payload ?? {});
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
    throw new Error(`Failed to serialise session flow payload: ${reason}`);
  }
};

interface FlowMetaRow {
  flow_state: string | null;
  flow_payload: unknown;
}

export interface FlowMeta {
  stepId: string | null;
  payload: unknown;
}

export const loadFlowMeta = async (
  queryable: Queryable,
  key: SessionKey,
): Promise<FlowMeta | null> => {
  const { rows } = await queryable.query<FlowMetaRow>(
    `
      SELECT flow_state, flow_payload
      FROM sessions
      WHERE scope = $1 AND scope_id = $2
    `,
    [key.scope, key.scopeId],
  );

  const [row] = rows;
  if (!row) {
    return null;
  }

  const payload = parseJsonValue<unknown>(row.flow_payload);
  return {
    stepId: row.flow_state ?? null,
    payload: payload ?? {},
  } satisfies FlowMeta;
};

export const updateFlowMeta = async (
  queryable: Queryable,
  key: SessionKey,
  stepId: string,
  payload?: unknown,
): Promise<void> => {
  const payloadJson = serialisePayload(payload);

  const { rows } = await queryable.query<{ flow_state: string | null }>(
    `SELECT flow_state FROM sessions WHERE scope = $1 AND scope_id = $2`,
    [key.scope, key.scopeId],
  );
  const previousState = rows[0]?.flow_state ?? null;

  await queryable.query(
    `
      INSERT INTO sessions (scope, scope_id, state, flow_state, flow_payload, last_step_at, nudge_sent_at, updated_at)
      VALUES ($1, $2, '{}'::jsonb, $3, $4::jsonb, now(), NULL, now())
      ON CONFLICT (scope, scope_id) DO UPDATE
      SET flow_state = EXCLUDED.flow_state,
          flow_payload = EXCLUDED.flow_payload,
          last_step_at = now(),
          nudge_sent_at = NULL,
          updated_at = now()
    `,
    [key.scope, key.scopeId, stepId, payloadJson],
  );

  if (previousState !== stepId) {
    await queryable.query(
      `
        INSERT INTO fsm_journal (scope, scope_id, from_state, to_state, step_id, payload)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [key.scope, key.scopeId, previousState, stepId, stepId, payloadJson],
    );
  }
};

export const markNudged = async (
  queryable: Queryable,
  key: SessionKey,
): Promise<void> => {
  await queryable.query(
    `
      UPDATE sessions
      SET nudge_sent_at = now(),
          updated_at = now()
      WHERE scope = $1 AND scope_id = $2
    `,
    [key.scope, key.scopeId],
  );
};

