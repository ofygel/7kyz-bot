import type { BotCommand } from 'telegraf/typings/core/types/typegram';

export const CLIENT_COMMANDS: BotCommand[] = [
  { command: 'start', description: 'Главное меню' },
  { command: 'taxi', description: 'Заказать такси' },
  { command: 'delivery', description: 'Оформить доставку' },
  { command: 'orders', description: 'Мои заказы' },
  { command: 'profile', description: 'Мой профиль' },
  { command: 'city', description: 'Сменить город' },
  { command: 'support', description: 'Поддержка' },
  { command: 'role', description: 'Сменить роль' },
];

export const EXECUTOR_COMMANDS: BotCommand[] = [
  { command: 'start', description: 'Главное меню' },
  { command: 'menu', description: 'Показать меню исполнителя' },
  { command: 'profile', description: 'Профиль' },
  { command: 'city', description: 'Сменить город' },
  { command: 'support', description: 'Связаться с поддержкой' },
];
