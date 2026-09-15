# Conflict-directed routing

## Change

The adaptive via-winding search now learns which earlier, uncommitted traces rejected clearance checks for a blocked connection. It adds one retry that moves the blocked connection immediately before the earliest observed blocking trace, preserving the unrelated prefix. The existing move-to-front and geometric fallback orders remain available within the original attempt budget.

It also caches successful searches with the same terminal, lane bias, and exact preceding copper. This lets preserved prefixes reuse their paths. The cache is local to one routing invocation and retains at most 64 paths / 16,384 points. Failed-search cache entries retain conflict ownership, so reused failures can still guide a retry.

The first routing order, fixed obstacles, committed buses, via reservations, clearance checks, and atomic bus commit remain unchanged. This applies to the existing `adaptiveRouteOrder` path; it is not a global fewest-crossings sort.

## Focused improvement

The five-connection `conflict-directed-winding.test.ts` fixture fails with the original implementation at an 18-attempt limit. The new implementation solves it on attempt 17. The successful retry preserves N1 before N3/N4/N0/N2 and reuses the first two successful searches. All five traces and vias pass copper DRC, and a visual SVG snapshot records the resulting nested routing.

The old behavior was checked by disabling both additions during development; the test failed because it returned no complete bus. The temporary development switches have been removed.

## Budget refinement

An unrestricted version that kept adding learned orders solved 11/12 AM62L directional cases; left-center timed out at 120 seconds. Restricting the search to one learned order per routing invocation fixed that regression while retaining the five-connection improvement. Each lane-bias attempt still counts toward the caller's existing maximum.

This limit matters: measured collisions identify plausible blockers, not a proof that a particular order is optimal. Moving a connection can still create a different conflict.

## Benchmark and checks

- Final AM62L directional benchmark: **12/12 solved**, 135/135 validated connections per case, no timeouts. The original also solved 12/12. See [benchmark.json](benchmark.json).
- Eleven output SVGs are byte-identical to the baseline. Left-center shifts one diagonal bend by 0.0625 mm without changing total wire length or via count.
- Sequential left-center spot checks confirmed the same 365.908 mm wire length and 135 vias. Other validation jobs overlapped timing measurements, so no general speed improvement is claimed.
- New visual regression: passed. Original behavior: fails the same fixture under the same 18-attempt budget.
- Focused checks for failed-prefix caching, boundary exits and reserved narrow channels passed.
- The existing AM62L left-exit snapshot was reviewed and updated for the shifted bend (and an omitted zero-length segment); all its 135-connection validation assertions passed before the update, and a normal rerun passed afterward.

- Typecheck: passed (`bun run typecheck`). Formatting and `git diff --check`: passed.
- All **263 test files** were covered: 124 completed files in the initial serial run, then 140 files across four processes (including one repeated snapshot test). The interrupted file was included in the remaining batches.
- The reviewed AM62L snapshot mismatch passed after updating the snapshot and rerunning without update mode.
- One parallel test exceeded its default 5-second limit (`reserved-narrow-interior-edge-gap`, 5.68 s). It passed alone in 1.88 s without changing code or its timeout.
- After those targeted reruns, every test file had a passing result. This was a serial-plus-parallel coverage run, not a single uninterrupted green `bun test` invocation.

## PR preparation

The change was rebased onto main at `97118aa`. Typecheck and the four focused tests (new conflict fixture, AM62L left-exit snapshot, failed-prefix cache, and reserved narrow gap) passed again. The 12-case benchmark and complete test-file coverage above were recorded before that rebase.

## Reproduce

From the repository root:

```sh
bun test tests/conflict-directed-winding.test.ts
bun test tests/fanout31-am62l-left-solved.test.ts
bun run typecheck
bun run benchmark --limit 12 --output-directory /tmp/fanout-conflict-directed
```

The first test is a small, deterministic regression for the new behavior; the benchmark checks the 12 AM62L directions rather than all 72 dataset31 cases.
