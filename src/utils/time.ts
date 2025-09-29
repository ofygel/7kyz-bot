import { DateTime } from 'luxon';

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

const ISO_TIMEZONE_PATTERN = /([zZ]|[+-]\d{2}:?\d{2})$/;

const LOCAL_FORMATS = [
  'dd.MM.yyyy, HH:mm:ss',
  'dd.MM.yyyy, HH:mm',
  'd.M.yyyy, HH:mm:ss',
  'd.M.yyyy, HH:mm',
  'dd.MM.yyyy HH:mm:ss',
  'dd.MM.yyyy HH:mm',
  'd.M.yyyy HH:mm:ss',
  'd.M.yyyy HH:mm',
  'dd.MM.yyyy',
  'd.M.yyyy',
];

export const parseDateTimeInTimezone = (
  value: string,
  timezone: string,
): Date | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (ISO_TIMEZONE_PATTERN.test(trimmed)) {
    const withOffset = DateTime.fromISO(trimmed);
    if (withOffset.isValid) {
      return withOffset.toJSDate();
    }
  }

  const iso = DateTime.fromISO(trimmed, { zone: timezone });
  if (iso.isValid) {
    return iso.toJSDate();
  }

  for (const format of LOCAL_FORMATS) {
    const parsed = DateTime.fromFormat(trimmed, format, {
      zone: timezone,
      locale: 'ru',
    });
    if (parsed.isValid) {
      return parsed.toJSDate();
    }
  }

  const numeric = Number.parseFloat(trimmed);
  if (Number.isFinite(numeric)) {
    if (trimmed.length === 10) {
      return new Date(numeric * 1000);
    }

    if (trimmed.length === 13) {
      return new Date(numeric);
    }
  }

  return null;
};
