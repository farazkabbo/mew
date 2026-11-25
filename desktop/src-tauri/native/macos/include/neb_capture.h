#ifndef NEB_CAPTURE_H
#define NEB_CAPTURE_H
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
/* macOS 14+, synchronous WORKER-THREAD ONLY. No permission request, disk or network IO.
 * Return values: 0 OK, 1 invalid arguments, 2 permission denied, 3 target changed/unsafe,
 * 4 native failure, 5 timed out, 6 cancelled, 7 unsupported OS, 8 busy/main thread,
 * 9 bounded output exceeded. No platform error descriptions or captured content in errors.
 * All pointers are borrowed until the call returns. Functions never retain caller pointers.
 * Callbacks execute synchronously on the calling worker, never after return. Copy needed
 * bytes into zeroizing storage INSIDE the callback; do not retain their pointers.
 * Native owned mutable pixel/output buffers are explicitly zeroed after callbacks.
 * Apple framework internal CGImage/Vision/String storage cannot be explicitly wiped.
 */
enum neb_capture_status { NEB_OK=0, NEB_INVALID=1, NEB_PERMISSION=2,
  NEB_TARGET=3, NEB_NATIVE=4, NEB_TIMEOUT=5, NEB_CANCELLED=6,
  NEB_UNSUPPORTED=7, NEB_BUSY=8, NEB_TOO_LARGE=9 };
typedef int32_t (*neb_capture_guard)(void *context);
typedef void (*neb_capture_bytes)(void *context, const uint8_t *bytes, size_t length,
                                  uint32_t width, uint32_t height, uint32_t channels);
/* Capture kind: 1 exact window ID with positive expected owner PID; 2 exact display ID,
 * expected_pid must be 0. Rect is the target's global CoreGraphics bounds in points.
 * Captures all of that single target, at its backing scale; cursor/audio excluded.
 * Display filter excludes this process's app/windows. Window capture refuses this PID.
 * Caller MUST bind explicit intent, exact process launch identity and metadata policy,
 * prove indicator presented, privacy allowed and session generation current in guard.
 * guard must return exactly 1; called before metadata, immediately before pixels,
 * after screenshot completion and before delivery. Unknown state must return 0.
 * This bridge does not claim to detect private browsing, calls or external screen shares.
 * Permission must already be granted; this never opens a consent dialog.
 * At most one native metadata/screenshot request may be outstanding. Native requests
 * cannot be cancelled, but timeout discards late completion without caller callbacks.
 */
int32_t neb_capture_once(uint32_t kind, uint32_t target_id, int32_t expected_pid,
                        double x, double y, double width, double height,
                        neb_capture_guard guard, void *guard_context,
                        neb_capture_bytes output, void *output_context);
/* Read-only preflight: 1 granted, 0 denied. Never requests permission. */
int32_t neb_capture_permission(void);
/* Vision local OCR, max side 2560, tightly packed gray8 (1) or BGRA8 (4).
 * Emits bounded UTF-8 JSON {"lines":[{"words":[{"text":...,"x":...,"y":...,
 * "width":...,"height":...}]}]}. Each recognized line is one conservative word box,
 * top-left pixel coordinates. No partial callback on recognition/serialization failure.
 * Caller owns its input; it must wipe it. Output JSON is wiped after callback.
 */
int32_t neb_ocr_read(const uint8_t *bytes, size_t length, uint32_t width,
                     uint32_t height, uint32_t channels,
                     neb_capture_bytes output, void *output_context);
/* In-memory JPEG from tightly packed BGR8 (3) or BGRA8 (4), quality [0,1].
 * Caller MUST provide already redacted input and revalidate session/target after OCR
 * and before encoding or sending. Encoded bytes never cross JS IPC in this bridge.
 */
int32_t neb_jpeg_encode(const uint8_t *bytes, size_t length, uint32_t width,
                        uint32_t height, uint32_t channels, double quality,
                        neb_capture_bytes output, void *output_context);
#ifdef __cplusplus
}
#endif
#endif
