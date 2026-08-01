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

export type PlanName = keyof typeof PLAN_LIMITS;

export function getPlanLimit(plan: string | null | undefined) {
  return PLAN_LIMITS[(plan || "free") as PlanName] || PLAN_LIMITS.free;
}

export function isPaidStatus(status: string | null | undefined) {
  return status === "active" || status === "trialing";
}

export function isAdminPlan(plan: string | null | undefined) {
  return plan === "admin";
}
