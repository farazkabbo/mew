# Stripe Setup Guide - Action Items for You

## System Overview

**Two-Tier Voice System:**
- **Free Tier**: 5 hours/month with Kokoro AI (open-source, runs on your server)
- **Premium Tier**: Unlimited usage with ElevenLabs premium voices ($15/month)

## 1. Create Stripe Account

1. Go to https://stripe.com and sign up
2. Complete your business profile
3. Verify your email address

## 2. Create Premium Product & Price

### In Stripe Dashboard:

1. Go to **Products** → **Add Product**
2. Fill in:
   - **Name**: `Neb Premium`
   - **Description**: `Unlimited AI tutoring with premium ElevenLabs voices - $15/month`
   - **Pricing Model**: Standard pricing
   - **Price**: `$15.00`
   - **Billing Period**: Monthly
   - **Currency**: USD (or your preferred currency)
3. Click **Save product**
4. **Copy the Price ID** (starts with `price_...`) - you'll need this for `.env.local`

## 3. Set Up Webhook Endpoint

### In Stripe Dashboard:

1. Go to **Developers** → **Webhooks**
2. Click **Add endpoint**
3. **Endpoint URL**: 
   - Development: `https://your-dev-api-url.com/v1/billing/webhook`
   - Production: `https://your-production-api-url.com/v1/billing/webhook`
4. **Events to listen for** (click "Select events"):
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
5. Click **Add endpoint**
6. **Copy the Signing Secret** (starts with `whsec_...`)

## 4. Get API Keys

### In Stripe Dashboard:

1. Go to **Developers** → **API keys**
2. Copy the following:
   - **Publishable key** (starts with `pk_test_...` for test mode)
   - **Secret key** (click "Reveal" then copy - starts with `sk_test_...`)

### ⚠️ Important: Start with Test Mode
- Use test keys first (they have `_test_` in them)
- Only switch to live mode after thorough testing

## 5. Configure Customer Portal

### In Stripe Dashboard:

1. Go to **Settings** → **Customer Portal**
2. Click **Activate test link** (for test mode)
3. Configure these settings:
   - **✓ Cancel subscription** - Enable
   - **✓ Update payment method** - Enable
   - **✓ View invoice history** - Enable
4. Add your business information:
   - Business name
   - Support email
   - Support phone (optional)
   - Terms of service URL (optional)
   - Privacy policy URL (optional)
5. Click **Save**

## 6. Add Environment Variables

Add these to your `.env.local` file:

```bash
# ─── Stripe ─────────────────────────────────────────────────────────────────
# Get these from: https://dashboard.stripe.com/apikeys
STRIPE_API_KEY=sk_test_...                    # Your secret key (KEEP SECRET!)
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_... # Your publishable key
# Get this from: https://dashboard.stripe.com/webhooks
STRIPE_WEBHOOK_SECRET=whsec_...               # Webhook signing secret
# Get this from your product page (the Price ID)
STRIPE_PRICE_ID=price_...                     # Your $15/month price ID

# Free tier configuration (5-hour session limit)
FREE_TIER_SESSION_HOURS=5
FREE_TIER_COOLDOWN_HOURS=5
```

## 7. Testing Your Setup

### Voice Quality Testing:

Before going live, test both voice systems:

1. **Test Kokoro (Free Tier)**:
   - Create a test account
   - Don't add payment method
   - Verify Kokoro voice works
   - Check voice quality and latency

2. **Test ElevenLabs (Premium)**:
   - Upgrade test account
   - Verify ElevenLabs voices work
   - Confirm voice switching happens

### Test Cards (in Test Mode only):

- **Success**: `4242 4242 4242 4242`
- **Decline**: `4000 0000 0000 0002`
- **Requires authentication**: `4000 0025 0000 3155`
- **Expiry**: Any future date (e.g., 12/34)
- **CVC**: Any 3 digits (e.g., 123)
- **ZIP**: Any 5 digits (e.g., 12345)

### Testing Checklist:

- [ ] Complete a test purchase
- [ ] Verify webhook is receiving events
- [ ] Check subscription appears in Stripe Dashboard
- [ ] Test canceling subscription via Customer Portal
- [ ] Test updating payment method
- [ ] Verify usage tracking works for free users

## 8. Before Going to Production

### Legal Requirements:

1. **Update Terms of Service** to include:
   - Subscription terms
   - Billing cycle information
   - Cancellation policy
   - Refund policy (if any)

2. **Update Privacy Policy** to mention:
   - Stripe as payment processor
   - What payment data is stored (minimal - Stripe handles it)

3. **Create Refund Policy**:
   - Example: "Full refund within 7 days, pro-rated after"
   - Or: "No refunds for subscription service"

### Stripe Production Setup:

1. Complete Stripe business verification
2. Switch from Test Mode to Live Mode in dashboard
3. Repeat steps 2-5 above for Live Mode
4. Update `.env.local` with live keys (pk_live_..., sk_live_...)
5. Test with a real card (you can cancel immediately)

## 9. Optional: Enable Stripe Tax

If you need to collect sales tax:

1. Go to **Settings** → **Tax**
2. Click **Enable Stripe Tax**
3. Configure your tax collection settings
4. Tax is automatically calculated at checkout

## 10. Support Resources

- **Stripe Documentation**: https://stripe.com/docs
- **Stripe Dashboard**: https://dashboard.stripe.com
- **Test Cards**: https://stripe.com/docs/testing
- **Webhooks Guide**: https://stripe.com/docs/webhooks
- **Support**: https://support.stripe.com

## 11. Kokoro AI Setup (No Action Required)

Kokoro AI is integrated automatically:
- **Package**: `pykokoro` (Python package)
- **Model**: Kokoro-82M (82 million parameters)
- **Size**: ~340MB (downloads on first use)
- **Runs on**: CPU (no GPU needed)
- **Voices**: American/British English, male/female
- **License**: Apache 2.0 (fully open-source)

The model will be downloaded automatically when the server first starts. It's stored locally and runs entirely on your server (no external API calls).

**Server Requirements:**
- At least 1GB free RAM for the model
- 500MB disk space for model files
- CPU only (GPU optional but not needed)

## Notes

- Keep your secret key (`sk_...`) secure - never commit it to git
- Webhook secret is different for each endpoint (test vs live)
- You can have multiple webhook endpoints (e.g., dev, staging, prod)
- Stripe Customer Portal handles most subscription management UI for you
- All payment data stays with Stripe (PCI compliant)
- **Kokoro AI runs locally** - no external TTS API calls for free users
- ElevenLabs is only used for premium subscribers

---

**Questions?** Check the Stripe docs or reach out to their support team.


## Quick Reference

### What Each Tier Gets

| Feature | Free Tier | Premium ($15/mo) |
|---------|-----------|------------------|
| Usage Limit | 5 hours (resets after 5hr wait) | Unlimited |
| Voice System | Kokoro AI (open-source) | ElevenLabs Premium |
| Voice Quality | Good | Excellent |
| Voice Options | 8 voices (English) | 100+ professional voices |
| Tutoring | ✓ Full access | ✓ Full access |
| Courses | ✓ Full access | ✓ Full access |
| Notebooks | ✓ Full access | ✓ Full access |
| Handwriting | ✓ Full access | ✓ Full access |

### Cost Breakdown

- **Development**: Free (test mode, unlimited)
- **Production Free Tier**: $0/user (server costs only)
- **Production Premium**: $15/user/month
- **Stripe Fee**: 2.9% + $0.30 per transaction
- **You Keep**: ~$14.50 per premium subscriber

### Timeline

- **Stripe Setup**: ~30 minutes
- **Testing**: ~30 minutes
- **Total Your Time**: ~1 hour

Development takes ~15-20 hours (done by AI).
