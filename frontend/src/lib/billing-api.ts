/**
 * Billing API client - calls backend billing endpoints via Next.js API routes
 */

import type {
  BillingInfo,
  CheckoutSessionRequest,
  CheckoutSessionResponse,
  PortalSessionResponse,
} from "@mew/shared/src/billing";

/**
 * Get user's current billing status (subscription + usage)
 */
export async function getBillingStatus(): Promise<BillingInfo> {
  const response = await fetch("/api/billing/status", {
    cache: "no-store",
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get billing status: ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * Create Stripe checkout session for upgrading to premium
 */
export async function createCheckoutSession(
  request: CheckoutSessionRequest,
): Promise<CheckoutSessionResponse> {
  const response = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Failed to create checkout session: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Create Stripe customer portal session for managing subscription
 */
export async function createPortalSession(): Promise<PortalSessionResponse> {
  const response = await fetch("/api/billing/portal", {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Failed to create portal session: ${response.statusText}`);
  }

  return response.json();
}

