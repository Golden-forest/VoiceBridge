export const PLAN_LIMITS = Object.freeze({
  free: {
    monthlySeconds: 18000,
    maxAudioSeconds: 60,
    rateLimitPerMinute: 30
  },
  pro: {
    monthlySeconds: 18000,
    maxAudioSeconds: 60,
    rateLimitPerMinute: 30
  }
});

export type PlanName = keyof typeof PLAN_LIMITS;

export function getPlanLimit(plan: string | null | undefined) {
  return PLAN_LIMITS[(plan || "free") as PlanName] || PLAN_LIMITS.free;
}

export function isPaidStatus(status: string | null | undefined) {
  return status === "active" || status === "trialing";
}
