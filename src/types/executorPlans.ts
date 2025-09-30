export type ExecutorPlanStatus = 'active' | 'blocked' | 'completed' | 'cancelled';

export type ExecutorPlanChoice = 'trial' | '7' | '15' | '30';

export interface ExecutorPlanRecord {
  id: number;
  chatId: number;
  threadId?: number;
  phone: string;
  nickname?: string;
  planChoice: ExecutorPlanChoice;
  startAt: Date;
  endsAt: Date;
  comment?: string;
  status: ExecutorPlanStatus;
  muted: boolean;
  reminderIndex: number;
  reminderLastSent?: Date;
  cardMessageId?: number;
  cardChatId?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExecutorPlanInsertInput {
  chatId: number;
  threadId?: number;
  phone: string;
  nickname?: string;
  planChoice: ExecutorPlanChoice;
  startAt: Date;
  endsAt?: Date;
  comment?: string;
}
