#ifndef NEB_INDICATOR_H
#define NEB_INDICATOR_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Owned fixed red border only: no user content, capture, permission prompt, focus or IPC.
 * begin: WORKER ONLY. begin returns 0 accepted, not proof of presentation.
 * poll is main-thread safe (direct validation); worker calls wait at most 100ms for main.
 * Token must be nonzero, strictly increasing, never reused during the process lifetime.
 * Rect is a single-display CoreGraphics global rectangle in POINTS, min side 8.
 * At most one lease exists; busy or unknown fails closed. No caller pointers are accepted.
 * poll: 1 means Metal's actual drawable presented handler recorded a valid presentedTime,
 * and a bounded main-thread check confirmed current ownership, visibility, alpha, geometry,
 * display and occlusion state. 0 means pending. Negative means no permission to capture:
 * -1 invalid/cancelled, -3 expired/main queue timed out, -4 busy (or begin called on main).
 * First presentation must complete within 2 seconds; lease hard lifetime is 15 seconds.
 * Every acquisition/completion boundary must poll again, along with independent target,
 * consent/privacy and session-generation checks. This is not permission to acquire pixels.
 * end immediately invalidates proof; AppKit hides on main queue. Drop/end on every path.
 * A late GPU callback cannot revive an invalidated lease. GPU resources remain bounded to
 * one submission, even when a hung GPU prevents releasing it (future begin returns busy).
 */
int32_t neb_indicator_begin(uint64_t token, double x, double y, double width, double height);
int32_t neb_indicator_poll(uint64_t token);
void neb_indicator_end(uint64_t token);
#ifdef __cplusplus
}
#endif
#endif
