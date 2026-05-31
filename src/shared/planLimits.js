export const PLAN_LIMITS = Object.freeze({
  free: {
    monthlySeconds: 600,
    maxAudioSeconds: 60,
    rateLimitPerMinute: 10
  },
  pro: {
    monthlySeconds: 18000,
    maxAudioSeconds: 60,
    rateLimitPerMinute: 30
  }
});

export function getPlanLimit(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

export function isPaidStatus(status) {
  return status === "active" || status === "trialing";
}
