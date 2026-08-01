export const PLAN_LIMITS = Object.freeze({
  free: {
    monthlySeconds: 600,
    maxAudioSeconds: 15,
    maxAudioMs: 15_000,
    rateLimitPerMinute: 10
  },
  pro: {
    monthlySeconds: 18000,
    maxAudioSeconds: 60,
    maxAudioMs: 60_000,
    rateLimitPerMinute: 30
  },
  admin: {
    monthlySeconds: 1_000_000,
    maxAudioSeconds: 60,
    maxAudioMs: 60_000,
    rateLimitPerMinute: 10_000
  }
});

export function getPlanLimit(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

export function isPaidStatus(status) {
  return status === "active" || status === "trialing";
}

export function isAdminPlan(plan) {
  return plan === "admin";
}
