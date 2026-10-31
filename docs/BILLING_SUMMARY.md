# Billing Integration Summary

## What's Being Built

A two-tier subscription system for Neb/Mew with voice quality differentiation.

## The Two Tiers

### Free Tier
- **Cost**: $0
- **Usage**: 5-hour session limit (cooldown system)
  - Get 5 hours of usage
  - When you use all 5 hours, wait 5 hours for reset
  - Example: Use all 5 hours → Wait 5 hours → Get 5 hours back
  - Simple and predictable
- **Voice**: Kokoro AI (82M parameter open-source TTS)
  - 8 voices (male/female, American/British English)
  - Good quality, fast generation
  - Runs on your server (no external API)
- **Features**: Full access to all features

### Premium Tier  
- **Cost**: $15/month
- **Usage**: Unlimited
- **Voice**: ElevenLabs Premium
  - 100+ professional voices
  - Highest quality synthesis
  - Natural intonation and emotion
- **Features**: Everything + priority support

## How It Works

### For Free Users
1. User signs up → starts with 5 hours available
2. Each tutoring session consumes from their session limit
3. Usage counter shows hours remaining (5.0, 4.5, 4.0, etc.)
4. At 80% usage (1 hour left) → gentle reminder with upgrade option
5. At 100% (0 hours left) → must wait 5 hours for reset (or upgrade)
6. Can still use app without voice features (notebook, courses remain accessible)
7. After 5-hour cooldown → session resets to 5 hours

### For Premium Users
1. User clicks "Upgrade" → Stripe Checkout
2. Pays $15/month
3. Instant access to ElevenLabs voices
4. No usage limits
5. Can cancel anytime via Customer Portal

## Technical Architecture

```
User Request
    ↓
Frontend (/api/tts)
    ↓
Backend checks subscription
    ↓
    ├─→ Free: Kokoro AI (local model)
    │   └─→ Returns PCM audio
    │
    └─→ Premium: ElevenLabs API
        └─→ Returns PCM audio
```

## What Gets Tracked

**Usage Tracking** (free users only):
- Each session starts at 0 hours
- Accumulates usage time per request
- At 5 hours used → starts 5-hour cooldown
- When cooldown ends → session resets to 0
- Simple state machine: Active → Limit Hit → Cooldown → Reset

**Subscription Data**:
- Stripe customer ID
- Subscription status
- Current period end date
- Cancellation status

## User Experience

### First Time User
1. Signs up → sees "Free Tier: 5 hours/month"
2. Uses app normally
3. Settings shows usage meter
4. Can upgrade anytime

### Upgrade Flow
1. User clicks "Upgrade to Premium"
2. Redirected to Stripe Checkout
3. Enters payment info
4. Returns to app → now has premium badge
5. Next voice request uses ElevenLabs

### Downgrade Flow
1. Premium user clicks "Manage Subscription"
2. Opens Stripe Customer Portal
3. Clicks "Cancel subscription"
4. Keeps premium until period ends
5. Then reverts to free tier

## Security

- ✓ Row Level Security on all billing tables
- ✓ Stripe webhook signature verification
- ✓ Server-side usage tracking (can't be manipulated)
- ✓ No PCI compliance needed (Stripe handles payments)
- ✓ Minimal data stored (user_id + Stripe IDs only)

## Revenue Model

**Per Premium User**:
- Revenue: $15.00
- Stripe fee: -$0.74 (2.9% + $0.30)
- **Net**: $14.26/month

**Costs**:
- Free users: Server compute only (~$0.10-0.50/user/month)
- Premium users: ElevenLabs API (~$0.30/month) + compute

**Estimated Margins**: ~85-90%

## Development Phases

1. **Database** (2-3h): Tables, RLS, migrations
2. **Kokoro** (3-4h): Model integration, voice generation
3. **Backend** (4-5h): Stripe API, webhooks, usage tracking
4. **Frontend** (3-4h): Billing page, usage UI, warnings
5. **Testing** (3-4h): End-to-end flows, voice quality

**Total**: 15-20 hours

## What You Need to Do

1. Create Stripe account (~15 min)
2. Create product & price (~5 min)
3. Set up webhook (~5 min)
4. Configure customer portal (~5 min)
5. Copy API keys to `.env.local` (~2 min)
6. Test with test card (~10 min)

**Total**: ~1 hour

See `STRIPE_SETUP_GUIDE.md` for detailed steps.

## Files Being Created

### Backend
- `backend/supabase/migrations/20261112000000_billing.sql` - Database schema
- `backend/src/mew_api/billing/` - Billing logic (models, stores, routes)
- `backend/src/mew_api/tts/kokoro.py` - Kokoro AI integration
- `backend/src/mew_api/middleware/usage.py` - Usage tracking
- `backend/src/mew_api/routes/billing.py` - API endpoints

### Frontend
- `frontend/src/app/(app)/billing/page.tsx` - Billing dashboard
- `frontend/src/features/billing/` - Billing components and logic
- `frontend/src/lib/billing-api.ts` - API client
- `frontend/src/components/UsageWarning.tsx` - Usage alerts

### Shared
- `packages/shared/src/billing.ts` - Shared types and schemas

## Testing Checklist

- [ ] Free user can use Kokoro voices
- [ ] Usage tracking increments correctly
- [ ] Warning shows at 80% usage
- [ ] Blocking message at 100% usage
- [ ] Upgrade flow completes successfully
- [ ] Premium user gets ElevenLabs voices
- [ ] Customer portal opens correctly
- [ ] Cancellation works properly
- [ ] Webhook events process correctly
- [ ] Usage resets on 1st of month

## Launch Checklist

- [ ] Switch Stripe to live mode
- [ ] Update environment variables with live keys
- [ ] Test one real transaction
- [ ] Update Terms of Service
- [ ] Update Privacy Policy
- [ ] Add refund policy
- [ ] Set up monitoring/alerts
- [ ] Test webhook with live endpoint
- [ ] Announce to users

## Future Enhancements

- Annual plan ($150/year, save $30)
- Student discount (50% off)
- Team plans (5+ users)
- Promo codes
- Usage analytics dashboard
- Custom voice training (enterprise)
- API access tier
