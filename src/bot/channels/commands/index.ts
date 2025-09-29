import type { Telegraf } from 'telegraf';

import type { BotContext } from '../../types';
import { registerFromCommand } from './from';

export const registerChannelCommands = (bot: Telegraf<BotContext>): void => {
  registerFromCommand(bot);
};
