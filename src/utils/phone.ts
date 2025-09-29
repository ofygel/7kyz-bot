export type E164Result = { ok: true; e164: string } | { ok: false; reason: string };

export function normalizeE164(raw: string, defaultCountry: 'KZ' | 'RU' = 'KZ'): E164Result {
  if (!raw) {
    return { ok: false, reason: 'empty' };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty' };
  }

  const plusMatches = trimmed.match(/\+/g) ?? [];
  if (plusMatches.length > 1) {
    return { ok: false, reason: 'unsupported_format' };
  }

  if (plusMatches.length === 1 && !trimmed.startsWith('+')) {
    return { ok: false, reason: 'unsupported_format' };
  }

  const digits = trimmed.replace(/[^0-9+]/g, '');
  if (!digits) {
    return { ok: false, reason: 'empty' };
  }

  if (digits.startsWith('+')) {
    const normalized = digits.replace(/\D/g, '');
    if (normalized.length < 10 || normalized.length > 15) {
      return { ok: false, reason: 'bad_length' };
    }
    return { ok: true, e164: `+${normalized}` };
  }

  if (/^[78]\d{10}$/.test(digits)) {
    return { ok: true, e164: `+7${digits.slice(1)}` };
  }

  if (/^\d{10}$/.test(digits)) {
    if (defaultCountry === 'KZ' || defaultCountry === 'RU') {
      return { ok: true, e164: `+7${digits}` };
    }
  }

  return { ok: false, reason: 'unsupported_format' };
}
