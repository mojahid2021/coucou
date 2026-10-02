// Bundle entry for the headless tests (test/run.mjs).
//
// Re-exports rather than importing the modules separately: esbuild produces one
// bundle, so `State` here is the very same instance the Island mutates. Two
// separate bundles would give two copies and every assertion would be vacuous.
//
// Outside `src`, so `tsc --noEmit` (include: ["src"]) does not type-check it —
// this is a harness for esbuild, which only transpiles.

export { Island } from "../src/island/island";
export { IslandStateMachine } from "../src/island/fsm";
export { State } from "../src/core/state";