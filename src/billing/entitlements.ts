export type StripeSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'
  | string;

export type FeatureEntitlements = {
  intelligentGeneration: boolean;
  safeRegeneration: boolean;
  uiOverrides: boolean;
  maxGenerations: number;
};

export type EffectiveEntitlements = {
  status: StripeSubscriptionStatus | 'none';
  isActive: boolean;
  reason: string;
  features: FeatureEntitlements;
};

const OFF_FEATURES: FeatureEntitlements = {
  intelligentGeneration: false,
  safeRegeneration: false,
  uiOverrides: false,
  maxGenerations: 0
};

const ON_FEATURES: FeatureEntitlements = {
  intelligentGeneration: true,
  safeRegeneration: true,
  uiOverrides: true,
  maxGenerations: -1
};

export function isSubscriptionEntitled(status: StripeSubscriptionStatus | null | undefined) {
  return status === 'active' || status === 'trialing';
}

export function entitlementsFromSubscriptionStatus(
  status: StripeSubscriptionStatus | null | undefined
): EffectiveEntitlements {
  if (status === 'active') {
    return {
      status,
      isActive: true,
      reason: 'subscription_active',
      features: ON_FEATURES
    };
  }

  if (status === 'trialing') {
    return {
      status,
      isActive: true,
      reason: 'trial_active',
      features: ON_FEATURES
    };
  }

  if (status === 'past_due' || status === 'unpaid') {
    return {
      status,
      isActive: false,
      reason: 'payment_pending',
      features: OFF_FEATURES
    };
  }

  if (status === 'canceled') {
    return {
      status,
      isActive: false,
      reason: 'subscription_canceled',
      features: OFF_FEATURES
    };
  }

  if (status === 'incomplete' || status === 'incomplete_expired' || status === 'paused') {
    return {
      status,
      isActive: false,
      reason: 'subscription_inactive',
      features: OFF_FEATURES
    };
  }

  return {
    status: status || 'none',
    isActive: false,
    reason: 'no_subscription',
    features: OFF_FEATURES
  };
}
