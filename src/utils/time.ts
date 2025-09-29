const SECOND_IN_MS = 1000;
const MINUTE_IN_MS = SECOND_IN_MS * 60;
const HOUR_IN_MS = MINUTE_IN_MS * 60;
const DAY_IN_MS = HOUR_IN_MS * 24;

export const SECOND = SECOND_IN_MS;
export const MINUTE = MINUTE_IN_MS;
export const HOUR = HOUR_IN_MS;
export const DAY = DAY_IN_MS;

/**
 * Suspends execution for the specified amount of milliseconds.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/**
 * Normalises the provided value into a numeric timestamp.
 * Returns `NaN` when the value cannot be converted.
 */
export const toTimestamp = (value: Date | number | string | null | undefined): number => {
  if (value === null || value === undefined) {
    return Number.NaN;
  }

  if (typeof value === 'number') {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }

  return Number.NaN;
};

/**
 * Calculates the difference between two timestamps in milliseconds.
 */
export const diffMilliseconds = (
  from: Date | number | string,
  to: Date | number | string = Date.now(),
): number => {
  const start = toTimestamp(from);
  const end = toTimestamp(to);

  if (Number.isNaN(start) || Number.isNaN(end)) {
    return Number.NaN;
  }

  return end - start;
};

/**
 * Determines whether the specified timestamp has elapsed by the given duration.
 */
export const hasElapsed = (
  since: Date | number | string,
  durationMs: number,
  now: Date | number | string = Date.now(),
): boolean => {
  const elapsed = diffMilliseconds(since, now);
  if (Number.isNaN(elapsed)) {
    return false;
  }

  return elapsed >= durationMs;
};

/**
 * Calculates the remaining time until the provided timestamp.
 */
export const remainingTime = (
  until: Date | number | string,
  now: Date | number | string = Date.now(),
): number => {
  const target = toTimestamp(until);
  const current = toTimestamp(now);

  if (Number.isNaN(target) || Number.isNaN(current)) {
    return Number.NaN;
  }

  return target - current;
};

/**
 * Adds the specified amount of milliseconds to the given timestamp and
 * returns a JavaScript `Date` instance representing the result.
 */
export const addMilliseconds = (
  value: Date | number | string,
  ms: number,
): Date | null => {
  const timestamp = toTimestamp(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp + ms);
};
