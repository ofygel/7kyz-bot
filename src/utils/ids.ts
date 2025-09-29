const DEFAULT_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const DEFAULT_LENGTH = 8;

const isAlphabetValid = (alphabet: string): boolean =>
  Boolean(alphabet) && new Set(alphabet).size === alphabet.length;

const randomInt = (max: number): number => Math.floor(Math.random() * max);

export interface ShortIdOptions {
  /** Custom alphabet used to generate IDs. Defaults to base36 characters. */
  alphabet?: string;
  /** Desired length of the generated identifier. Defaults to 8 symbols. */
  length?: number;
}

export const createShortId = (options: ShortIdOptions = {}): string => {
  const alphabet = isAlphabetValid(options.alphabet ?? DEFAULT_ALPHABET)
    ? options.alphabet ?? DEFAULT_ALPHABET
    : DEFAULT_ALPHABET;
  const length = options.length ?? DEFAULT_LENGTH;

  if (length <= 0) {
    throw new Error('Short ID length must be a positive integer');
  }

  let id = '';
  for (let index = 0; index < length; index += 1) {
    id += alphabet[randomInt(alphabet.length)];
  }

  return id;
};

export interface ShortCallbackIdOptions extends ShortIdOptions {
  /** Optional delimiter used between prefix and generated identifier. */
  delimiter?: string;
}

export const createShortCallbackId = (
  prefix: string,
  options: ShortCallbackIdOptions = {},
): string => {
  const delimiter = options.delimiter ?? ':';
  const id = createShortId(options);
  return `${prefix}${delimiter}${id}`;
};

export const parseShortCallbackId = (
  value: string,
  delimiter = ':',
): { prefix: string; id: string } | null => {
  if (!value.includes(delimiter)) {
    return null;
  }

  const [prefix, id] = value.split(delimiter);
  if (!prefix || !id) {
    return null;
  }

  return { prefix, id };
};

export const isShortCallbackId = (value: string, prefix: string, delimiter = ':'): boolean => {
  const parsed = parseShortCallbackId(value, delimiter);
  return parsed?.prefix === prefix;
};
