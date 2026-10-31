"""Billing endpoints: subscription status, Stripe checkout/portal, and webhooks."""

import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated

import stripe
from fastapi import APIRouter, Header, HTTPException, Request, status

from ..billing.models import (
    BillingInfo,
    CheckoutSessionRequest,
    CheckoutSessionResponse,
    PortalSessionResponse,
    SubscriptionStatus,
    UsageInfo,
)
from ..billing.store import BillingStore, MemoryBillingStore, SupabaseBillingStore
from ..config import Settings
from ..deps import Caller, CurrentCaller, SettingsDep

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/billing", tags=["billing"])


def billing_store(request: Request, caller: Caller, settings: Settings) -> BillingStore:
    """Get the appropriate billing store (memory or Supabase)."""
    if caller.is_local:
        store: BillingStore = request.app.state.local_billing
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Billing not configured")
    return SupabaseBillingStore(
        settings.supabase_url,
        api_key=settings.supabase_publishable_key,
        user_token=caller.token,
    )


def _check_stripe_config(settings: Settings) -> None:
    """Raise 503 if Stripe is not configured."""
    if not settings.stripe_api_key or not settings.stripe_price_id:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Stripe is not configured on this server",
        )


@router.get("/status")
def get_billing_status(
    request: Request, caller: CurrentCaller, settings: SettingsDep
) -> BillingInfo:
    """Get user's current billing status (subscription + usage)."""
    store = billing_store(request, caller, settings)
    
    # Check subscription
    subscription = store.get_subscription(caller.user_id)
    
    if subscription and subscription.status in ("active", "trialing"):
        # Premium user
        is_premium = subscription.current_period_end > datetime.now(timezone.utc)
        sub_status = SubscriptionStatus(
            is_premium=is_premium,
            status=subscription.status,
            current_period_end=subscription.current_period_end,
            cancel_at_period_end=subscription.cancel_at_period_end,
        )
        # Premium users don't need usage tracking
        return BillingInfo(subscription=sub_status, usage=None)
    
    # Free tier user - get usage session
    session = store.get_usage_session(caller.user_id)
    
    # Check if cooldown expired
    now = datetime.now(timezone.utc)
    if session.in_cooldown and session.cooldown_ends_at and now >= session.cooldown_ends_at:
        # Auto-reset expired cooldown
        session = store.reset_usage_session(caller.user_id)
    
    percentage = (session.seconds_used / settings.free_tier_session_seconds) * 100
    usage = UsageInfo(
        seconds_used=session.seconds_used,
        seconds_limit=settings.free_tier_session_seconds,
        percentage_used=round(percentage, 2),
        in_cooldown=session.in_cooldown,
        cooldown_ends_at=session.cooldown_ends_at,
    )
    
    sub_status = SubscriptionStatus(
        is_premium=False,
        status="free",
        current_period_end=None,
        cancel_at_period_end=False,
    )
    
    return BillingInfo(subscription=sub_status, usage=usage)


@router.post("/create-checkout-session")
def create_checkout_session(
    body: CheckoutSessionRequest,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> CheckoutSessionResponse:
    """Create a Stripe checkout session for upgrading to premium."""
    _check_stripe_config(settings)
    
    if not settings.stripe_api_key or not settings.stripe_price_id:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE)
    
    stripe.api_key = settings.stripe_api_key.get_secret_value()
    store = billing_store(request, caller, settings)
    
    # Check if user already has subscription
    existing = store.get_subscription(caller.user_id)
    if existing and existing.status in ("active", "trialing"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "User already has an active subscription",
        )
    
    try:
        # Get or create Stripe customer
        customer_id = existing.stripe_customer_id if existing else None
        
        if not customer_id:
            customer = stripe.Customer.create(metadata={"user_id": caller.user_id})
            customer_id = customer.id
        
        # Create checkout session
        session = stripe.checkout.Session.create(
            customer=customer_id,
            mode="subscription",
            line_items=[{"price": settings.stripe_price_id, "quantity": 1}],
            success_url=body.success_url,
            cancel_url=body.cancel_url,
            metadata={"user_id": caller.user_id},
            allow_promotion_codes=True,
        )
        
        return CheckoutSessionResponse(url=session.url or "")
        
    except stripe.StripeError as error:
        logger.error("Stripe checkout session creation failed: %s", error)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"Failed to create checkout session: {error}",
        ) from error


@router.post("/create-portal-session")
def create_portal_session(
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> PortalSessionResponse:
    """Create a Stripe customer portal session for managing subscription."""
    _check_stripe_config(settings)
    
    if not settings.stripe_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE)
    
    stripe.api_key = settings.stripe_api_key.get_secret_value()
    store = billing_store(request, caller, settings)
    
    # Get user's subscription
    subscription = store.get_subscription(caller.user_id)
    if not subscription:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "No subscription found",
        )
    
    try:
        # Create portal session
        session = stripe.billing_portal.Session.create(
            customer=subscription.stripe_customer_id,
            return_url=f"{settings.app_origin or 'http://localhost:3000'}/billing",
        )
        
        return PortalSessionResponse(url=session.url)
        
    except stripe.StripeError as error:
        logger.error("Stripe portal session creation failed: %s", error)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"Failed to create portal session: {error}",
        ) from error


@router.post("/webhook")
async def stripe_webhook(
    request: Request,
    settings: SettingsDep,
    stripe_signature: Annotated[str, Header(alias="stripe-signature")],
) -> dict[str, str]:
    """Handle Stripe webhook events."""
    if not settings.stripe_webhook_secret or not settings.stripe_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Stripe not configured")
    
    stripe.api_key = settings.stripe_api_key.get_secret_value()
    
    # Get raw body for signature verification
    body = await request.body()
    
    try:
        # Verify webhook signature
        event = stripe.Webhook.construct_event(
            body,
            stripe_signature,
            settings.stripe_webhook_secret.get_secret_value(),
        )
    except ValueError:
        logger.error("Invalid webhook payload")
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid payload")
    except stripe.SignatureVerificationError:
        logger.error("Invalid webhook signature")
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid signature")
    
    # Log event (with idempotency check)
    # TODO: Store in stripe_events table for idempotency
    
    # Handle different event types
    event_type = event["type"]
    data = event["data"]["object"]
    
    logger.info("Received Stripe webhook: %s", event_type)
    
    # Get service-role billing store (bypass RLS)
    if not settings.supabase_url or not settings.supabase_secret_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Database not configured")
    
    store = SupabaseBillingStore(
        settings.supabase_url,
        api_key=settings.supabase_secret_key.get_secret_value(),
    )
    
    try:
        if event_type == "checkout.session.completed":
            # New subscription created
            user_id = data["metadata"].get("user_id")
            customer_id = data["customer"]
            subscription_id = data["subscription"]
            
            if not user_id:
                logger.error("No user_id in checkout session metadata")
                return {"status": "error", "message": "Missing user_id"}
            
            # Get subscription details from Stripe
            subscription = stripe.Subscription.retrieve(subscription_id)
            
            from ..billing.models import Subscription
            
            sub = Subscription(
                user_id=user_id,
                stripe_customer_id=customer_id,
                stripe_subscription_id=subscription_id,
                stripe_price_id=subscription["items"]["data"][0]["price"]["id"],
                status=subscription["status"],
                current_period_start=datetime.fromtimestamp(
                    subscription["current_period_start"], tz=timezone.utc
                ),
                current_period_end=datetime.fromtimestamp(
                    subscription["current_period_end"], tz=timezone.utc
                ),
                cancel_at_period_end=subscription["cancel_at_period_end"],
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )
            
            store.create_subscription(sub)
            logger.info("Created subscription for user %s", user_id)
            
        elif event_type in ("customer.subscription.updated", "customer.subscription.deleted"):
            # Subscription status changed
            subscription_id = data["id"]
            
            # Find user by subscription_id
            # TODO: Add index lookup method
            
            logger.info("Subscription %s updated/deleted", subscription_id)
            
        else:
            logger.info("Unhandled webhook event type: %s", event_type)
    
    except Exception as error:
        logger.error("Error processing webhook: %s", error)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(error)) from error
    
    return {"status": "success"}

