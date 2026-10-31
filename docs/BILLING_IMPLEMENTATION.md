# Billing & TTS Integration Implementation

## Overview

Implementing a two-tier system:
- **Free Tier**: 5 hours/month with Kokoro AI (open-source TTS)
- **Premium Tier**: Unlimited usage with ElevenLabs voices ($15/month)

## Tier Features

### Free Tier
- ✓ **5-hour session limit** (like Claude)
  - Get 5 hours of usage
  - Once limit hit, wait 5 hours for full reset
  - Simple cooldown system
  - Clear and predictable
- ✓ Kokoro AI voice synthesis (82M parameter open-source model)
- ✓ All core tutoring features
- ✓ Course creation
- ✓ Notebook features

### Premium Tier ($15/month)
- ✓ Unlimited usage (no time restrictions)
- ✓ ElevenLabs premium voices
- ✓ All features
- ✓ Priority support (future)

## Implementation Plan

### Phase 1: Database Schema (2-3 hours)

**New Migration**: `20261112000000_billing.sql`

Tables to create:
1. `subscriptions` - User subscription data
2. `usage_sessions` - Track session usage and cooldowns
3. `stripe_events` - Webhook event log

All with proper RLS policies.

### Phase 2: Kokoro AI Integration (3-4 hours)

**Backend Kokoro Module**: `backend/src/mew_api/tts/kokoro.py`
- Initialize Kokoro model on server startup
- Generate speech with `pykokoro` library
- Return PCM audio (same format as ElevenLabs)
- Cache model in memory for fast generation

**New Backend Route**: `POST /v1/tts/generate`
- Check user subscription status
- Route to Kokoro (free) or ElevenLabs (premium)
- Return PCM audio stream

**Update Frontend `/api/tts`**:
- Proxy to backend `/v1/tts/generate`
- Pass user token for subscription check
- Maintain same API interface for compatibility

### Phase 3: Backend Billing API (4-5 hours)

**New Routes**:
- `GET /v1/billing/status` - Get subscription & usage
- `POST /v1/billing/create-checkout-session` - Start upgrade
- `POST /v1/billing/create-portal-session` - Manage subscription
- `POST /v1/billing/webhook` - Handle Stripe events

**Usage Tracking Middleware**:
- Track time on tutor endpoints
- Check limits before allowing requests
- Return 429 with upgrade prompt when limit exceeded

### Phase 4: Frontend Billing UI (3-4 hours)

**New Pages**:
1. `/billing` - Main billing dashboard
   - Current plan display
   - Usage meter (free users)
   - Upgrade/manage buttons
   
**New Components**:
1. `UsageWarningBanner` - Shows at 80%, 90%, 100% usage
2. `PlanBadge` - Shows "Free" or "Premium" in UI
3. `BillingSection` - Settings page section

### Phase 5: Integration & Testing (3-4 hours)

- Test Kokoro voice quality
- Test Stripe checkout flow
- Test usage tracking accuracy
- Test voice switching (free ↔ premium)
- Test webhook events

## Technical Details

### Kokoro AI Integration

**Using pykokoro Package (Recommended)**
```python
# backend/src/mew_api/tts/kokoro.py
from pykokoro import Kokoro

# Initialize once on server startup
kokoro = Kokoro()

def kokoro_tts(text: str, voice: str = "af_sarah") -> bytes:
    """Generate speech using Kokoro model (runs on CPU)
    
    Returns PCM audio at 24kHz, mono
    """
    audio = kokoro.create(text, voice=voice)
    return audio  # Already in PCM format compatible with existing player
```

**Model Details**:
- Size: ~340MB (auto-downloads from Hugging Face on first use)
- Runtime: CPU only (no GPU needed)
- Latency: ~100-200ms per sentence on modern CPU
- Quality: Comparable to larger models
- License: Apache 2.0 (fully open)

**Kokoro Voices Available**:
- `af_sarah` - Female American English (default)
- `af_nicole` - Female American English (alternative)
- `am_adam` - Male American English
- `am_michael` - Male American English
- `bf_emma` - Female British English
- `bf_isabella` - Female British English
- `bm_george` - Male British English
- `bm_lewis` - Male British English

**Integration Strategy**:
1. Initialize Kokoro model on server startup (adds ~2-3 seconds to boot)
2. Keep model in memory (uses ~500MB RAM)
3. Generate audio on-demand for free users
4. Return in same PCM format as ElevenLabs for compatibility

### Voice Selection Logic

```typescript
// frontend/src/features/tutor/voice-router.ts
async function getTTS(text: string) {
  const status = await getBillingStatus();
  
  // Backend handles routing based on subscription
  // Frontend always calls same endpoint
  return fetch('/api/tts', { 
    method: 'POST',
    body: JSON.stringify({ 
      text,
      voiceId: status.subscription.is_premium ? userVoice : undefined
    })
  });
}
```

**Backend automatically routes**:
- Free users → Kokoro AI (voice selected by backend)
- Premium users → ElevenLabs (with user's chosen voice)

### Usage Tracking (Session Limit)

Track time spent on these endpoints:
- `/api/tutor` - Main tutoring
- `/api/mew` - Gate decisions  
- `/api/tts` - Voice (routes to Kokoro or ElevenLabs)
- `/api/recognize` - Handwriting
- Course-related AI endpoints

**Tracking Mechanism**:
```python
# Check current session
session = get_current_session(user_id)

# If in cooldown
if session.in_cooldown and now() < session.cooldown_ends_at:
    time_left = session.cooldown_ends_at - now()
    raise 429 with time_left

# If cooldown expired, reset session
if session.in_cooldown and now() >= session.cooldown_ends_at:
    reset_session(user_id)
    session = get_current_session(user_id)

# Check if session has capacity
if session.seconds_used >= (5 * 3600):
    # Start cooldown
    start_cooldown(user_id, cooldown_hours=5)
    raise 429 with cooldown_time

# Track usage
track_request_time(user_id, duration_seconds)
```

**Key Benefits**:
- Simple and predictable
- Clear "you have X hours left"
- Easy to explain to users
- Matches Claude's pattern

### Database Schema

```sql
-- subscriptions table
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles (id) on delete cascade,
  stripe_customer_id text unique not null,
  stripe_subscription_id text unique,
  status text not null check (status in ('active', 'canceled', 'past_due', 'trialing')),
  current_period_end timestamptz not null,
  created_at timestamptz not null default now(),
  
  unique (id, user_id)
);

-- usage_sessions table (session limit with cooldown)
create table public.usage_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles (id) on delete cascade,
  seconds_used integer not null default 0 check (seconds_used >= 0),
  in_cooldown boolean not null default false,
  cooldown_started_at timestamptz,
  cooldown_ends_at timestamptz,
  session_started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  unique (user_id)
);

create index usage_sessions_user_idx on public.usage_sessions (user_id);
create index usage_sessions_cooldown_idx on public.usage_sessions (in_cooldown, cooldown_ends_at);
```

## Dependencies to Add

### Backend (`backend/pyproject.toml`):
```toml
dependencies = [
    # ... existing
    "stripe>=12.0.0,<13",
    "pykokoro>=0.2.0,<1.0",  # Kokoro TTS with ONNX runtime
]
```

**Note**: `pykokoro` includes `onnxruntime` as a dependency, so no need to add it separately.

### Frontend (`frontend/package.json`):
```json
{
  "dependencies": {
    "@stripe/stripe-js": "^5.5.0"
  }
}
```

## Environment Variables

```bash
# Stripe
STRIPE_API_KEY=sk_test_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...

# Free tier config (session-based)
FREE_TIER_SESSION_HOURS=5
FREE_TIER_COOLDOWN_HOURS=5

# Kokoro AI - No additional config needed!
# Model auto-downloads on first use (~340MB from Hugging Face)
# Set this ONLY if you want to use a custom model path:
# KOKORO_MODEL_DIR=/path/to/models  # optional
```

## UI Consistency

Following existing patterns:
- Use `CourseShell` for billing page layout
- Use `Section` component for groupings
- Use `Toggle` component for settings
- Match typography: `font-serif text-2xl` for headers
- Match colors: `text-ink`, `text-muted`, `bg-paper`
- Use `rounded-full` buttons with `border-line`

## Security Considerations

1. **RLS Policies**: All billing tables have user_id RLS
2. **Webhook Verification**: Verify Stripe signatures
3. **API Key Security**: Never expose Stripe secret to frontend
4. **Usage Tracking**: Server-side only, can't be manipulated
5. **Rate Limiting**: Prevent abuse of free tier

## Testing Strategy

### Unit Tests
- Subscription status calculation
- Usage tracking logic
- Webhook event handling
- Voice routing logic

### Integration Tests
- Complete Stripe checkout (test mode)
- Webhook delivery and processing
- Usage limit enforcement
- Voice switching

### Manual Tests
- Voice quality comparison (Kokoro vs ElevenLabs)
- Upgrade/downgrade flows
- Usage meter accuracy
- Customer portal access

## Migration Path

1. **Existing Users**: 
   - Start on Free tier
   - Show upgrade prompt on first login
   - Grandfather existing heavy users (optional)

2. **New Users**:
   - Start on Free tier
   - Clear explanation of limits
   - Easy upgrade path

## Future Enhancements

- Annual plan ($150/year, save $30)
- Team plans
- Student discounts
- Promo codes
- Usage analytics dashboard
- Voice selection for free users (choose from Kokoro voices)
- Kokoro voice fine-tuning for personal voice
- Enterprise plan with custom voices

## Estimated Timeline

- Phase 1 (Database): 2-3 hours
- Phase 2 (Kokoro): 3-4 hours
- Phase 3 (Backend): 4-5 hours
- Phase 4 (Frontend): 3-4 hours
- Phase 5 (Testing): 3-4 hours

**Total: 15-20 hours of development**

Plus your setup time for Stripe configuration (~1 hour).
