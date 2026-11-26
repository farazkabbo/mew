// Public AppKit inventory only. No libproc, AppleEvents, permission requests or content reads.
#import <AppKit/AppKit.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

typedef bool (*NebSignalValid)(void *context);
// 0 = unreadable, 1 = other application, 2 = known call/recorder bundle.
typedef uint8_t (*NebClassifyBundle)(const uint8_t *bytes, size_t length);

// Must run on the main queue after the run loop has processed application changes. AppKit's
// inventory omits non-application helper processes; this is intentionally a limited detector.
// Exceptions never cross Rust's ABI. Only bounded counts/booleans leave this helper.
int32_t neb_call_app_inventory(uint32_t *count, uint32_t *active,
                               NebSignalValid valid, void *context,
                               NebClassifyBundle classify) {
    if (!count || !active || !valid || !classify) return 0;
    *count = 0;
    *active = 0;
    @autoreleasepool {
        @try {
            if (![NSThread isMainThread] || !valid(context)) return 0;
            NSArray<NSRunningApplication *> *apps = NSWorkspace.sharedWorkspace.runningApplications;
            if (!apps || apps.count == 0 || apps.count > 4096 || !valid(context)) return 0;
            uint32_t seen = 0;
            uint32_t found = 0;
            for (NSRunningApplication *app in apps) {
                if (!valid(context) || !app || app.terminated || app.processIdentifier <= 0) return 0;
                NSString *bundle = app.bundleIdentifier;
                if (!bundle || bundle.length == 0 || bundle.length > 512) return 0;
                const char *bytes = bundle.UTF8String;
                if (!bytes) return 0;
                size_t length = strnlen(bytes, 513);
                if (length == 0 || length > 512) return 0;
                uint8_t result = classify((const uint8_t *)bytes, length);
                if (result == 0 || result > 2) return 0;
                found |= result == 2;
                seen++;
                if (!valid(context)) return 0;
            }
            if (seen != apps.count || !valid(context)) return 0;
            *count = seen;
            *active = found;
            return 1;
        } @catch (NSException *exception) {
            // Never log application identifiers, exception descriptions or device names.
            (void)exception;
            return 0;
        }
    }
}
