# Your To-Do List for Stripe Integration

## ✅ What I'm Doing (AI)

- Creating database migrations (session limit tracking)
- Integrating Kokoro AI for free tier voice  
- Building billing API endpoints
- Creating billing dashboard UI
- Implementing 5-hour session limit (like Claude)
- Adding Stripe webhook handler
- Creating upgrade/downgrade flows
- Building usage visualization with cooldown timer

## 📋 What You Need to Do

### Step 1: Create Stripe Account (15 min)
- [ ] Go to https://stripe.com
- [ ] Sign up for an account
- [ ] Verify your email
- [ ] Complete business profile (can do this in test mode first)

### Step 2: Create Product & Price (5 min)
- [ ] Dashboard → Products → Add Product
- [ ] Name: "Neb Premium"
- [ ] Description: "Unlimited AI tutoring with premium ElevenLabs voices"
- [ ] Price: $15.00/month (recurring)
- [ ] Save and copy the **Price ID** (starts with `price_`)

### Step 3: Set Up Webhook (5 min)
- [ ] Dashboard → Developers → Webhooks
- [ ] Add endpoint URL: `https://your-api-url.com/v1/billing/webhook`
- [ ] Select these events:
  - [ ] `checkout.session.completed`
  - [ ] `customer.subscription.created`
  - [ ] `customer.subscription.updated`
  - [ ] `customer.subscription.deleted`
  - [ ] `invoice.payment_succeeded`
  - [ ] `invoice.payment_failed`
- [ ] Save and copy the **Signing Secret** (starts with `whsec_`)

### Step 4: Get API Keys (2 min)
- [ ] Dashboard → Developers → API Keys
- [ ] Copy **Publishable Key** (starts with `pk_test_`)
- [ ] Copy **Secret Key** (starts with `sk_test_`)

### Step 5: Configure Customer Portal (5 min)
- [ ] Dashboard → Settings → Customer Portal
- [ ] Click "Activate test link"
- [ ] Enable: Cancel subscription, Update payment method, View invoices
- [ ] Add business information
- [ ] Save

### Step 6: Add to .env.local (2 min)
Add these lines to your `.env.local` file:
```bash
# Stripe Configuration
STRIPE_API_KEY=sk_test_...  # Your secret key
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...  # Your publishable key
STRIPE_WEBHOOK_SECRET=whsec_...  # Your webhook secret
STRIPE_PRICE_ID=price_...  # Your $15/month price ID

# Free Tier Settings (5-hour session limit like Claude)
FREE_TIER_SESSION_HOURS=5
FREE_TIER_COOLDOWN_HOURS=5
```

### Step 7: Test Everything (10 min)
- [ ] Run the app in development mode
- [ ] Create a test account
- [ ] Verify Kokoro voice works (free tier)
- [ ] Click "Upgrade to Premium"
- [ ] Use test card: `4242 4242 4242 4242`
- [ ] Complete checkout
- [ ] Verify ElevenLabs voice works (premium)
- [ ] Open "Manage Subscription"
- [ ] Verify Customer Portal opens

### Step 8: Before Production
- [ ] Update Terms of Service (mention subscription)
- [ ] Update Privacy Policy (mention Stripe)
- [ ] Add refund policy
- [ ] Switch Stripe to Live Mode
- [ ] Update .env.local with live keys (`pk_live_`, `sk_live_`)
- [ ] Test with real card (can cancel immediately)

## 📚 Documentation

- **Setup Guide**: `STRIPE_SETUP_GUIDE.md` - Detailed step-by-step instructions
- **Implementation**: `docs/BILLING_IMPLEMENTATION.md` - Technical details
- **Summary**: `docs/BILLING_SUMMARY.md` - Overview and architecture

## 🎯 Test Cards (Test Mode Only)

- **Success**: 4242 4242 4242 4242
- **Decline**: 4000 0000 0000 0002
- **Requires Auth**: 4000 0025 0000 3155
- **Expiry**: Any future date (12/34)
- **CVC**: Any 3 digits (123)
- **ZIP**: Any 5 digits (12345)

## 💰 Expected Costs

### Development (Test Mode)
- **Cost**: $0 (completely free)

### Production
- **Per Premium User**: $15/month
- **Stripe Fee**: 2.9% + $0.30 = ~$0.74
- **You Keep**: ~$14.26/month per user
- **Free Users**: Server costs only (~$0.10-0.50/user/month)

## ⏱️ Time Estimate

- **Your Time**: ~1 hour (all the steps above)
- **AI Development Time**: ~15-20 hours
- **Total Calendar Time**: 1-2 days

## 🆘 Need Help?

- **Stripe Docs**: https://stripe.com/docs
- **Stripe Support**: https://support.stripe.com
- **Test Cards**: https://stripe.com/docs/testing
- **Webhooks Guide**: https://stripe.com/docs/webhooks

## 📝 Notes

- Start with **Test Mode** first (keys have `_test_` in them)
- Keep your secret key safe (never commit to git)
- Webhook secret is different for test vs live
- Stripe Customer Portal handles most UI for you
- You can test unlimited times with test cards
- No real charges in test mode

---

**Ready?** Complete steps 1-6, then let me know and I'll start the implementation!


## 📚 Additional Documentation Created

- **`docs/SESSION_LIMIT_EXPLAINED.md`** - Deep dive into how the 5-hour session limit works
- **`docs/FREE_VS_PREMIUM.md`** - User-facing comparison and value proposition
- **`docs/BILLING_IMPLEMENTATION.md`** - Technical implementation details
- **`docs/BILLING_SUMMARY.md`** - Architecture & business overview

All docs are designed to help you understand and explain the system to users!


## 🎯 How the Session Limit Works (Simple!)

1. **Start**: You get 5 hours
2. **Use**: Each tutoring session counts toward your 5 hours
3. **Limit**: When you use all 5 hours → 5-hour cooldown starts
4. **Reset**: After 5 hours → You get your 5 hours back!

**Example**: Use all 5 hours at 2pm → Wait until 7pm → Get 5 hours back

See `docs/SESSION_LIMIT_EXPLAINED.md` for full details.
