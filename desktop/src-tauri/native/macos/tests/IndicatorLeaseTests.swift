// Synthetic guard tests: no NSApplication, windows, GPU, capture or permissions are used.
import Foundation

@main
struct IndicatorLeaseTests {
    static func main() {
        let pending = IndicatorLease(token: 1, now: 100)
        precondition(pending.status(now: 100.2) == 0)
        pending.markPresented(token: 2, time: 100.1, now: 100.2)
        precondition(pending.status(now: 100.2) == 0, "stale generation must not prove a new lease")
        for invalid in [0.0, -1.0, .nan, .infinity, 99.0, 101.0] {
            pending.markPresented(token: 1, time: invalid, now: 100.2)
            precondition(pending.status(now: 100.2) == 0)
        }
        pending.markPresented(token: 1, time: 100.1, now: 100.2)
        precondition(pending.status(now: 100.3) == 1)
        precondition(pending.status(now: 114.9) == 1, "presentation wait is not lease lifetime")
        pending.invalidate()
        pending.markPresented(token: 1, time: 100.1, now: 100.3)
        precondition(pending.status(now: 100.3) < 0, "late callback must not resurrect cancellation")

        let expired = IndicatorLease(token: 2, now: 100)
        precondition(expired.status(now: 102) == -3)
        expired.markPresented(token: 2, time: 101, now: 101.5)
        precondition(expired.status(now: 101.5) < 0, "timeout is terminal even for a late callback")
        let lifetime = IndicatorLease(token: 3, now: 100)
        lifetime.markPresented(token: 3, time: 100.1, now: 100.2)
        precondition(lifetime.status(now: 115) == -3)
        let late = IndicatorLease(token: 4, now: 100)
        late.markPresented(token: 4, time: 102.1, now: 102.2)
        precondition(late.status(now: 102.2) < 0)

        let pool = IndicatorPool()
        let first = pool.acquire(1)!
        precondition(pool.acquire(2) == nil, "pool must not allocate two active leases")
        first.invalidate()
        precondition(pool.acquire(2) == nil, "cancel must wait for owned UI/GPU cleanup")
        pool.release(first)
        precondition(pool.acquire(1) == nil, "nonce reuse forbidden")
        let second = pool.acquire(2)!
        pool.release(first)
        precondition(pool.find(2) === second, "stale cleanup must not release the current lease")
        precondition(first.startValidation() == false)
        precondition(second.startValidation())
        precondition(!second.startValidation(), "only one main-queue validation may be outstanding")
        second.endValidation()
        precondition(second.startValidation())
        let raced = IndicatorLease(token: 5, now: 100)
        raced.invalidate()
        DispatchQueue.concurrentPerform(iterations: 128) { _ in
            raced.markPresented(token: 5, time: 100.1, now: 100.2)
            precondition(raced.status(now: 100.2) < 0)
        }
        print("Indicator lease synthetic tests passed")
    }
}
