# RP2040 motor-controller type reproduction

Source: [imrishabh18/rp2040-motor-controller](https://tscircuit.com/imrishabh18/rp2040-motor-controller), version 1.0.48, `package.json`, `bun.lock`, `tsconfig.json`, and `patches/@tscircuit%2Ffanout-solver@0.0.81.patch`. Its 0.0.78 patch is identical.

The project pins `@tscircuit/capacity-autorouter@0.0.1003`, enables strict TypeScript checking and `skipLibCheck`, and imports the source-distributed fanout package through tscircuit. The newer autorouter's `SimpleRouteBus.allowedLayers` is mutable, whereas `FanoutBusSpec.allowedLayers` is readonly. Merely checking that interface produces TS2430; running the motor router is unnecessary.

Run `bun install`, then `bun test tests/rp2040-motor-controller-types.test.ts`.

This test checks the actual public type source and a minimal consumer against an alias of the project's real autorouter release. It targets those files because other solver implementations still use the repository's pinned 0.0.718 contract. `bun run typecheck` separately checks the complete solver against that pinned contract.

Before the one-line fix:

```text
Interface 'FanoutBusSpec' incorrectly extends interface 'SimpleRouteBus'.
  Types of property 'allowedLayers' are incompatible.
    Type 'readonly string[] | undefined' is not assignable to type 'string[] | undefined'.
```

After the fix, the public interface check passes, and both mutable arrays and readonly tuples are accepted. This is a type-only change; existing bus routing snapshots are unchanged.
