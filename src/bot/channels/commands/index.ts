import type { Telegraf } from 'telegraf';

import type { BotContext } from '../../types';
import { registerFormCommand } from './form';

export const registerChannelCommands = (bot: Telegraf<BotContext>): void => {
  registerFormCommand(bot);
};
