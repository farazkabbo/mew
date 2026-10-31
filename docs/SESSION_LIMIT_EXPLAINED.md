# 5-Hour Session Limit Explained

## How It Works (Simple!)

Free users get **5 hours of usage**. When you use all 5 hours, you wait 5 hours to get them all back.

```
Start: 5:00 hours available
         ↓
Use:   Use 2 hours
         ↓
Have:  3:00 hours left
         ↓
Use:   Use 3 more hours
         ↓
Limit: 0:00 hours left (LIMIT HIT!)
         ↓
Wait:  5 hours cooldown starts
         ↓
Reset: 5:00 hours available again!
```

## Example: A Typical Day

**Monday 2:00 PM** - User starts studying
- Available: 5:00 hours
- Uses 2 hours of tutoring
- Remaining: 3:00 hours

**Monday 5:00 PM** - Back to studying  
- Available: 3:00 hours
- Uses another 2 hours
- Remaining: 1:00 hour
- ⚠️ Warning: "You have 1 hour left"

**Monday 8:00 PM** - Final session
- Available: 1:00 hour
- Uses 1 hour
- Remaining: 0:00 hours
- 🛑 **Limit hit!** Cooldown starts

**Monday 8:00 PM → Tuesday 1:00 AM**
- Status: In cooldown
- Message: "You've used your 5 free hours. Reset in 4:23:15"
- Options: Wait or upgrade to Premium

**Tuesday 1:00 AM** - Cooldown ends
- Available: 5:00 hours (full reset!)
- User can use Neb again

## State Machine

```
┌─────────────┐
│   ACTIVE    │ Tracking usage, counting down from 5 hours
│  (0-5 hrs)  │
└──────┬──────┘
       │ Hit 5 hours
       ↓
┌─────────────┐
│  COOLDOWN   │ Waiting 5 hours for reset
│  (blocked)  │
└──────┬──────┘
       │ 5 hours pass
       ↓
┌─────────────┐
│   RESET     │ Back to 5 hours, start over
│  (5 hours)  │
└─────────────┘
```

## Database: Simple Session Tracking

```sql
create table usage_sessions (
  user_id text primary key,
  seconds_used integer default 0,        -- 0 to 18000 (5 hours)
  in_cooldown boolean default false,
  cooldown_started_at timestamptz,
  cooldown_ends_at timestamptz,          -- when user gets reset
  session_started_at timestamptz,        -- when current session began
  last_activity_at timestamptz
);
```

### Example Records:

**Active user (has 3 hours left):**
```json
{
  "user_id": "user_abc",
  "seconds_used": 7200,           // 2 hours used
  "in_cooldown": false,
  "cooldown_started_at": null,
  "cooldown_ends_at": null,
  "session_started_at": "2026-10-30T14:00:00Z",
  "last_activity_at": "2026-10-30T16:00:00Z"
}
```

**User in cooldown:**
```json
{
  "user_id": "user_xyz",
  "seconds_used": 18000,          // 5 hours used (limit)
  "in_cooldown": true,
  "cooldown_started_at": "2026-10-30T20:00:00Z",
  "cooldown_ends_at": "2026-10-31T01:00:00Z",  // 5 hours later
  "session_started_at": "2026-10-30T14:00:00Z",
  "last_activity_at": "2026-10-30T20:00:00Z"
}
```

## Logic Flow

### On Each Request:

```python
def check_and_track_usage(user_id: str, duration_seconds: int):
    session = get_session(user_id)
    
    # Check if in cooldown
    if session.in_cooldown:
        if now() < session.cooldown_ends_at:
            # Still in cooldown
            time_left = session.cooldown_ends_at - now()
            raise LimitError(f"Reset in {format_time(time_left)}")
        else:
            # Cooldown expired, reset session
            reset_session(user_id)
            session = get_session(user_id)
    
    # Check if this request would exceed limit
    if session.seconds_used + duration_seconds > 18000:  # 5 hours
        # Start cooldown
        start_cooldown(user_id, hours=5)
        raise LimitError("Limit hit. Reset in 5 hours.")
    
    # Track usage
    session.seconds_used += duration_seconds
    session.last_activity_at = now()
    save_session(session)
```

### Helper Functions:

```python
def reset_session(user_id: str):
    """Reset user back to 5 hours available"""
    update_session(
        user_id,
        seconds_used=0,
        in_cooldown=False,
        cooldown_started_at=None,
        cooldown_ends_at=None,
        session_started_at=now()
    )

def start_cooldown(user_id: str, hours: int):
    """Start X-hour cooldown"""
    update_session(
        user_id,
        in_cooldown=True,
        cooldown_started_at=now(),
        cooldown_ends_at=now() + timedelta(hours=hours)
    )

def get_time_remaining(user_id: str) -> dict:
    """Get user's current status"""
    session = get_session(user_id)
    
    if session.in_cooldown:
        if now() >= session.cooldown_ends_at:
            reset_session(user_id)
            return {"available": 18000, "status": "active"}
        
        return {
            "available": 0,
            "status": "cooldown",
            "resets_in": (session.cooldown_ends_at - now()).total_seconds()
        }
    
    return {
        "available": 18000 - session.seconds_used,
        "status": "active",
        "percentage_used": (session.seconds_used / 18000) * 100
    }
```

## User Experience

### Usage Display (Active)
```
Your session: [████████──] 78% used

3:54:32 remaining of 5:00:00
```

### Warning at 80% (1 hour left)
```
⚠️ Running low on free hours

You have 1 hour left in this session.
Want unlimited? Upgrade to Premium for $15/month.

[Upgrade] [Continue (1h left)]
```

### Limit Hit (Cooldown)
```
🕐 Session limit reached

You've used your 5 free hours. Your session resets in:
4:23:15

Want to keep going? Upgrade to Premium for unlimited access.

[Upgrade to Premium] [Wait for Reset]
```

### After Reset
```
✨ Session reset!

You have 5 fresh hours to use. Happy studying!

[Start Learning]
```

## Why This System?

### Pros:
✅ **Simple** - Easy to understand
✅ **Predictable** - Know exactly when you get hours back
✅ **Fair** - Everyone gets same 5 hours
✅ **Clear upgrade path** - Obvious benefit to Premium
✅ **Like Claude** - Familiar pattern users know

### Cons (addressed):
❌ "All or nothing" - True, but simpler than complex tracking
❌ "Must wait full 5 hours" - Yes, but clear and predictable
❌ "No partial replenishment" - Keeps it simple

## Edge Cases

### Long Session (>5 hours)
- User starts session with 3 hours available
- Session would take 4 hours
- After 3 hours, limit hits mid-session
- User sees warning at 80% (2.4 hours used)
- Can save work and come back after cooldown

### Multiple Devices
- Session is per-user (not per-device)
- Using phone counts toward same 5 hours as laptop
- Cooldown applies across all devices

### Partial Usage
- Use 2 hours, stop for a day
- Come back: still have 3 hours left
- No time-based expiry until limit is hit

### Premium Downgrade
- Premium user cancels subscription
- At end of billing period, gets fresh 5-hour session
- Can continue using immediately (not in cooldown)

## Comparison to Other Systems

| System | Our Approach | Alternative |
|--------|--------------|-------------|
| **Monthly cap** | ❌ Arbitrary calendar reset | ✅ Natural cooldown |
| **Rolling window** | ❌ Complex calculation | ✅ Simple counter |
| **Request count** | ❌ Unfair (small vs large) | ✅ Time-based |
| **Credits** | ❌ Confusing units | ✅ Hours (clear) |

## Implementation Checklist

- [ ] Create `usage_sessions` table
- [ ] Session tracking middleware
- [ ] Cooldown check before each request
- [ ] Auto-reset after cooldown expires
- [ ] Usage display UI (hours:minutes:seconds)
- [ ] Warning at 80%
- [ ] Block at 100% with countdown
- [ ] Upgrade prompt in both warnings
- [ ] Reset notification (optional)
- [ ] Test edge cases

## Metrics to Track

- **Hit rate**: % of users who hit limit
- **Upgrade rate**: % who hit limit then upgrade
- **Avg usage**: Mean hours per session
- **Time to limit**: How fast users hit 5 hours
- **Cooldown churn**: % who quit during cooldown

## Summary

**Simple 5-hour session limit:**
- Get 5 hours → Use them → Hit limit → Wait 5 hours → Get 5 hours back
- Clear, predictable, fair
- Easy to implement and explain
- Natural upgrade incentive
