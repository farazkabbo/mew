import { z } from "zod";

/**
 * Billing types (mirrored from backend/src/mew_api/billing/models.py)
 */

export const SubscriptionStatus = z.object({
  is_premium: z.boolean(),
  status: z.enum(["free", "active", "canceled", "past_due", "incomplete", "trialing"]).nullable(),
  current_period_end: z.string().datetime().nullable(), // ISO 8601
  cancel_at_period_end: z.boolean(),
});
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const UsageInfo = z.object({
  seconds_used: z.number().int().min(0).max(18000), // 0 to 5 hours
  seconds_limit: z.number().int().default(18000),    // 5 hours in seconds
  percentage_used: z.number().min(0).max(100),
  in_cooldown: z.boolean(),
  cooldown_ends_at: z.string().datetime().nullable(), // ISO 8601
});
export type UsageInfo = z.infer<typeof UsageInfo>;

export const BillingInfo = z.object({
  subscription: SubscriptionStatus,
  usage: UsageInfo.nullable(), // null for premium users
});
export type BillingInfo = z.infer<typeof BillingInfo>;

export const CheckoutSessionRequest = z.object({
  success_url: z.string().max(2048),
  cancel_url: z.string().max(2048),
});
export type CheckoutSessionRequest = z.infer<typeof CheckoutSessionRequest>;

export const CheckoutSessionResponse = z.object({
  url: z.string(),
});
export type CheckoutSessionResponse = z.infer<typeof CheckoutSessionResponse>;

export const PortalSessionResponse = z.object({
  url: z.string(),
});
export type PortalSessionResponse = z.infer<typeof PortalSessionResponse>;

