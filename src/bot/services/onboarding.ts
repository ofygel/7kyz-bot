import type { BotContext, OnboardingState, OnboardingStep } from '../types';

const ensureState = (ctx: BotContext): OnboardingState => {
  if (!ctx.session.onboarding) {
    ctx.session.onboarding = { active: false };
  }

  return ctx.session.onboarding;
};

export const setOnboardingStep = (ctx: BotContext, step: OnboardingStep): void => {
  const state = ensureState(ctx);
  state.active = true;
  state.step = step;
};

export const clearOnboardingState = (ctx: BotContext): void => {
  const state = ensureState(ctx);
  state.active = false;
  state.step = undefined;
};

export const getOnboardingStep = (ctx: BotContext): OnboardingStep | undefined =>
  ensureState(ctx).step;

export const isOnboardingActive = (ctx: BotContext): boolean => ensureState(ctx).active;
