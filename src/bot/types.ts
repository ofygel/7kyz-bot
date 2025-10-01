import type { Context } from 'telegraf';

import type {
  ExecutorPlanChoice,
  ExecutorPlanStatus,
  OrderLocation,
  OrderPriceDetails,
} from '../types';
import type { AppCity } from '../domain/cities';

export const EXECUTOR_VERIFICATION_PHOTO_COUNT = 3;

export type ExecutorKind = 'courier' | 'driver';

export const EXECUTOR_KINDS: readonly ExecutorKind[] = ['courier', 'driver'];

export type ExecutorRole = ExecutorKind;

export const EXECUTOR_ROLES = EXECUTOR_KINDS;

export type UserRole = 'guest' | 'client' | 'executor' | 'moderator';

export type UserVerifyStatus = 'none' | 'pending' | 'active' | 'rejected' | 'expired';

export type UserSubscriptionStatus = 'none' | 'active' | 'grace' | 'expired';

export interface AuthExecutorPlan {
  id: number;
  planChoice: ExecutorPlanChoice;
  status: ExecutorPlanStatus;
  startAt: Date;
  endsAt: Date;
}

export interface SessionUser {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  phoneVerified?: boolean;
}

export type UserStatus =
  | 'guest'
  | 'onboarding'
  | 'awaiting_phone'
  | 'active_client'
  | 'active_executor'
  | 'safe_mode'
  | 'trial_expired'
  | 'suspended'
  | 'banned';

export type UserMenuRole = 'client' | 'courier' | 'moderator';

export interface UserPerformanceMetrics {
  completionRate?: number;
  ordersCompleted?: number;
  ordersCancelled?: number;
  rating?: number;
  earningsTotal?: number;
  [metric: string]: number | string | undefined;
}

export interface AuthUser {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  phoneVerified: boolean;
  role: UserRole;
  executorKind?: ExecutorRole;
  status: UserStatus;
  verifyStatus: UserVerifyStatus;
  subscriptionStatus: UserSubscriptionStatus;
  isVerified: boolean;
  isBlocked: boolean;
  citySelected?: AppCity;
  verifiedAt?: Date;
  subscriptionExpiresAt?: Date;
  activeExecutorPlan?: AuthExecutorPlan;
  hasActiveOrder: boolean;
  lastMenuRole?: UserMenuRole;
  keyboardNonce?: string;
  performance?: UserPerformanceMetrics;
  performanceMetrics?: UserPerformanceMetrics;
}

export interface AuthExecutorState {
  verifiedRoles: Record<ExecutorRole, boolean>;
  hasActiveSubscription: boolean;
  isVerified: boolean;
}

export interface AuthState {
  user: AuthUser;
  executor: AuthExecutorState;
  isModerator: boolean;
}

export interface AuthStateSnapshot {
  role: UserRole;
  executorKind?: ExecutorRole;
  status: UserStatus;
  phoneVerified: boolean;
  verifyStatus: UserVerifyStatus;
  subscriptionStatus: UserSubscriptionStatus;
  userIsVerified: boolean;
  executor: AuthExecutorState;
  isModerator: boolean;
  subscriptionExpiresAt?: Date;
  executorPlan?: AuthExecutorPlan;
  city?: AppCity;
  hasActiveOrder: boolean;
  stale: boolean;
}

export interface ExecutorUploadedPhoto {
  fileId: string;
  messageId: number;
  fileUniqueId?: string;
}

export interface ExecutorVerificationMediaGroupProgress {
  photoUniqueIds: string[];
  progressNotified: boolean;
}

export type ExecutorVerificationStatus = 'idle' | 'collecting' | 'submitted';

export interface ExecutorVerificationModerationState {
  applicationId?: string;
  chatId?: number;
  messageId?: number;
  token?: string;
}

export interface ExecutorVerificationRoleState {
  status: ExecutorVerificationStatus;
  requiredPhotos: number;
  uploadedPhotos: ExecutorUploadedPhoto[];
  submittedAt?: number;
  moderation?: ExecutorVerificationModerationState;
  lastReminderAt?: number;
  processedMediaGroups: Record<string, ExecutorVerificationMediaGroupProgress>;
}

export type ExecutorSubscriptionStatus =
  | 'idle'
  | 'selectingPeriod'
  | 'awaitingReceipt'
  | 'pendingModeration';

export interface ExecutorSubscriptionState {
  status: ExecutorSubscriptionStatus;
  selectedPeriodId?: string;
  pendingPaymentId?: string;
  moderationChatId?: number;
  moderationMessageId?: number;
  lastInviteLink?: string;
  lastIssuedAt?: number;
  lastReminderAt?: number;
}

export type ExecutorVerificationState = Record<ExecutorRole, ExecutorVerificationRoleState>;

export type ExecutorJobStage = 'idle' | 'feed' | 'confirm' | 'inProgress' | 'complete';

export interface ExecutorJobsState {
  stage: ExecutorJobStage;
  activeOrderId?: number;
  pendingOrderId?: number;
  lastViewedAt?: number;
}

export interface ExecutorFlowState {
  role?: ExecutorRole;
  verification: ExecutorVerificationState;
  subscription: ExecutorSubscriptionState;
  jobs: ExecutorJobsState;
  awaitingRoleSelection?: boolean;
  roleSelectionStage?: 'role' | 'executorKind' | 'city';
}

export type OnboardingStep = 'role' | 'executorKind';

export interface OnboardingState {
  active: boolean;
  step?: OnboardingStep;
}

export type ClientOrderStage =
  | 'idle'
  | 'collectingPickup'
  | 'collectingDropoff'
  | 'selectingAddressType'
  | 'collectingApartment'
  | 'collectingEntrance'
  | 'collectingFloor'
  | 'collectingRecipientPhone'
  | 'collectingComment'
  | 'awaitingConfirmation'
  | 'creatingOrder';

export interface ClientOrderDraftState {
  stage: ClientOrderStage;
  pickup?: OrderLocation;
  dropoff?: OrderLocation;
  price?: OrderPriceDetails;
  confirmationMessageId?: number;
  notes?: string;
  isPrivateHouse?: boolean;
  apartment?: string;
  entrance?: string;
  floor?: string;
  recipientPhone?: string;
}

export interface ClientFlowState {
  taxi: ClientOrderDraftState;
  delivery: ClientOrderDraftState;
}

export interface UiTrackedStepState {
  chatId: number;
  messageId: number;
  cleanup: boolean;
}

export interface UiSessionState {
  steps: Record<string, UiTrackedStepState | undefined>;
  homeActions: string[];
  pendingCityAction?: 'clientMenu' | 'executorMenu' | 'executorRoleSelection';
  clientMenuVariant?: 'A' | 'B';
}

export type ModerationPlanWizardStep = 'phone' | 'nickname' | 'plan' | 'details' | 'summary';

export interface ModerationPlanWizardState {
  step: ModerationPlanWizardStep;
  threadId?: number;
  phone?: string;
  nickname?: string;
  planChoice?: ExecutorPlanChoice;
  startAt?: Date;
  comment?: string;
}

export interface ModerationPlanEditState {
  planId: number;
  chatId: number;
  messageId: number;
  threadId?: number;
}

export interface ModerationPlansSessionState {
  threads: Record<string, ModerationPlanWizardState | undefined>;
  edits: Record<string, ModerationPlanEditState | undefined>;
}

export type SupportRequestStatus = 'idle' | 'awaiting_message';

export interface SupportSessionState {
  status: SupportRequestStatus;
  lastThreadId?: string;
  lastThreadShortId?: string;
}

export interface SessionState {
  ephemeralMessages: number[];
  isAuthenticated: boolean;
  safeMode: boolean;
  isDegraded: boolean;
  safeModeReason?: string;
  safeModePrompt?: string;
  awaitingPhone: boolean;
  phoneNumber?: string;
  user?: SessionUser;
  city?: AppCity;
  authSnapshot: AuthStateSnapshot;
  executor: ExecutorFlowState;
  client: ClientFlowState;
  ui: UiSessionState;
  moderationPlans: ModerationPlansSessionState;
  support: SupportSessionState;
  onboarding: OnboardingState;
}

export type BotContext = Context & {
  session: SessionState;
  auth: AuthState;
};
