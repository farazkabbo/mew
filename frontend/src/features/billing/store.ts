/**
 * Billing store: manages subscription status and usage data
 */

import type { BillingInfo } from "@mew/shared/src/billing";
import { create } from "zustand";

import { createCheckoutSession, createPortalSession, getBillingStatus } from "@/lib/billing-api";

interface BillingState {
  billing: BillingInfo | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  upgrade: () => Promise<void>;
  manageSubscription: () => Promise<void>;
}

export const useBillingStore = create<BillingState>((set, get) => ({
  billing: null,
  loaded: false,
  loading: false,
  error: null,

  load: async () => {
    if (get().loading) return;

    set({ loading: true, error: null });
    try {
      const billing = await getBillingStatus();
      set({ billing, loaded: true, loading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to load billing",
        loading: false,
      });
    }
  },

  upgrade: async () => {
    if (get().loading) return;

    set({ loading: true, error: null });
    try {
      const currentUrl = window.location.href;
      const response = await createCheckoutSession({
        success_url: `${window.location.origin}/billing?success=true`,
        cancel_url: currentUrl,
      });

      // Redirect to Stripe Checkout
      window.location.href = response.url;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to create checkout session",
        loading: false,
      });
    }
  },

  manageSubscription: async () => {
    if (get().loading) return;

    set({ loading: true, error: null });
    try {
      const response = await createPortalSession();
      
      // Redirect to Stripe Customer Portal
      window.location.href = response.url;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to open portal",
        loading: false,
      });
    }
  },
}));

