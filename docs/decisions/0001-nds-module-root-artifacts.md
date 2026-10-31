---
status: accepted
date: 2026-10-22
adaptation:
  standard: {id: std-0001, version: 3.0.2}
  rules: [R-0018]
  paths: [module.yaml, contracts, standarts.lock, provider.lock.json]
  reason: The NDS system root (ADR 0013, owner direction 2026-10-22) gives every module repository a native module descriptor, a compiled-in runtime contract directory and two locks at the repository root.
  result: module.yaml owns the component version, contracts holds the runtime manifests compiled into the module, standarts.lock pins the NDS standards source and provider.lock.json pins the Chrome for Testing acceptance provider. They stay at the root where the NDS tooling and the browser acceptance scripts read them.
  verification: nddev check reports these four roots as adapted; the NDS root release manifest and the browser acceptance cases consume them unchanged.
---
# Keep NDS module artifacts at the repository root

This decision migrates the four `spec.variations` that the previous
`nddev.ai/v1alpha3` manifest recorded (owner approval 2026-10-22 through the NDS
system root's ADR 0013) into the current ADR-based adaptation form. No path,
purpose or owner choice changes.

`.gds` keeps its separate GDS ownership; the std-0001 boundary rule already
excludes it, so it needs no adaptation here.
