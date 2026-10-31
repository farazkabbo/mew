"""Billing data models (mirrored by TypeScript in packages/shared/src/billing.ts)."""

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


class SubscriptionStatus(BaseModel):
    """User's subscription status."""

    is_premium: bool
    status: Literal["free", "active", "canceled", "past_due", "incomplete", "trialing"] | None
    current_period_end: datetime | None
    cancel_at_period_end: bool


class UsageInfo(BaseModel):
    """Free tier session usage information."""

    seconds_used: int = Field(ge=0, le=18000)  # 0 to 5 hours
    seconds_limit: int = Field(default=18000)  # 5 hours in seconds
    percentage_used: float = Field(ge=0, le=100)
    in_cooldown: bool
    cooldown_ends_at: datetime | None


class BillingInfo(BaseModel):
    """Complete billing information for a user."""

    subscription: SubscriptionStatus
    usage: UsageInfo | None  # None for premium users


class CheckoutSessionRequest(BaseModel):
    """Request body for creating a Stripe checkout session."""

    success_url: str = Field(max_length=2048)
    cancel_url: str = Field(max_length=2048)


class CheckoutSessionResponse(BaseModel):
    """Response containing Stripe checkout URL."""

    url: str


class PortalSessionResponse(BaseModel):
    """Response containing Stripe customer portal URL."""

    url: str


class UsageSession(BaseModel):
    """A user's current usage session (from database)."""

    user_id: str
    seconds_used: int
    in_cooldown: bool
    cooldown_started_at: datetime | None
    cooldown_ends_at: datetime | None
    session_started_at: datetime
    last_activity_at: datetime


class Subscription(BaseModel):
    """A user's Stripe subscription (from database)."""

    user_id: str
    stripe_customer_id: str
    stripe_subscription_id: str | None
    stripe_price_id: str
    status: Literal["active", "canceled", "past_due", "incomplete", "trialing"]
    current_period_start: datetime
    current_period_end: datetime
    cancel_at_period_end: bool
    created_at: datetime
    updated_at: datetime

