const EMOJI_REGEXP = /\p{Extended_Pictographic}+/gu;
const PUNCTUATION_REGEXP = /[!?.…]+/gu;

const MENU_KEYWORDS = new Set(['меню', 'menu', 'главное меню', 'на главную']);

const normaliseText = (value: string): string =>
  value
    .replace(EMOJI_REGEXP, ' ')
    .replace(PUNCTUATION_REGEXP, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const isStartCommand = (text: string): boolean => {
  const lower = text.trim().toLowerCase();
  if (!lower.startsWith('/start')) {
    return lower === 'start';
  }

  const [command] = lower.split(/\s+/); // handle `/start payload`
  return command === '/start' || command.startsWith('/start@');
};

export const isClientGlobalMenuIntent = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (isStartCommand(trimmed)) {
    return true;
  }

  const normalised = normaliseText(trimmed);
  if (!normalised) {
    return false;
  }

  if (MENU_KEYWORDS.has(normalised)) {
    return true;
  }

  return false;
};
