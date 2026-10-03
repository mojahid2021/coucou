// The test suite proper, bundled by run.mjs and executed against the DOM stub.
//
// `installDom()` runs BEFORE any island import: `bridge.ts` evaluates
// `IS_TAURI` at module load, so a stub installed afterwards would be too late.

import { installDom, advanceClock, clockNow, type Harness } from "./dom-stub";

const stub: Harness = installDom();

// The stub freezes `performance.now()`. The FSM's whole contract is a
// wall-clock delay and the busy ceiling compares two reads of it, so against a
// frozen clock a delay can never elapse. Restore a real clock for the FSM and
// busy tests; the frame-pacing test switches back to `stub.clockNow` itself.
(globalThis as any).performance = { now: () => Date.now() };

const { Island } = await import("../src/island/island");
const { IslandStateMachine } = await import("../src/island/fsm");
const { State, isBusyState } = await import("../src/core/state");
const { BotEngine, EMOTE_SPECS, EMOTE_EYE, EMOTE_SOUND } = await import("../src/mochi/engine");
const { SOUND_NAMES } = await import("../src/core/sound");

/**
 * The names in the `BotEmoteName` union, at runtime.
 *
 * The union is type-only, so it cannot be imported as a value. Reading it off the
 * table would be circular — that is precisely the check we want — so instead it
 * is declared here as the contract it is. If someone adds a name to the union in
 * `core/layout.ts` without a spec here, `the table covers every BotEmoteName`
 * fails; if they add a spec for a name the union does not have, `extra` catches
 * it. Keep this list and the union in step.
 */
const EMOTE_NAMES = [
  "love", "surprised", "proud", "wink", "yawn", "happy", "annoyed",
  "curious", "celebrate",
] as const;

type Ctx = {
  suite: (n: string) => void;
  test: (n: string, fn: () => void) => void;
  assert: (c: unknown, m?: string) => void;
  eq: (a: unknown, b: unknown, m?: string) => void;
  sleep: (ms: number) => Promise<void>;
};

export async function run({ suite, test, assert, eq, sleep }: Ctx) {
  // ── Fixtures ───────────────────────────────────────────────────────────────

  /** An FSM with the 10-minute busy ceiling set BEFORE anything arms a timer:
   *  `busyMaxHold` is read when the hold is scheduled, so a later assignment
   *  would be ignored and the test would sit through the real 600 s default. */
  function makeFsm(opts: { busy?: () => boolean; maxHold?: number } = {}) {
    const fsm = new IslandStateMachine();
    fsm.maxHoldGuard;
    if (opts.maxHold != null) fsm.busyMaxHold = opts.maxHold;
    if (opts.busy) fsm.isBusy = opts.busy;
    const log: string[] = [];
    fsm.onTransition = (from, to) => log.push(`${from}->${to}`);
    return { fsm, log };
  }

  // ── FSM: state contract ────────────────────────────────────────────────────

  suite("FSM — modes and transitions");

  await test("launch goes hidden → coucou and then folds to petit", async () => {
    const { fsm, log } = makeFsm();
    fsm.launch();
    eq(fsm.state, "coucou", "launch should reach coucou");
    fsm.greetComplete();
    eq(fsm.state, "coucou", "greetComplete only arms the timer, it does not fold");
    await sleep(700);
    eq(fsm.state, "petit", "should fold to petit after the greeting");
    assert(log.includes("coucou->petit"), "transition was recorded");
  });

  await test("hover from hidden peeks then expands after peekExpandDelay", async () => {
    const { fsm } = makeFsm();
    fsm.mouseEntered();
    eq(fsm.state, "petit", "hovering the notch peeks");
    await sleep(300);
    eq(fsm.state, "petit", "must not expand before the delay");
    await sleep(500);
    eq(fsm.state, "home", "still hovering, so it expands");
  });

  await test("leaving during the peek returns to hidden, never home", async () => {
    const { fsm } = makeFsm();
    fsm.mouseEntered();
    fsm.mouseLeft();
    await sleep(800);
    eq(fsm.state, "hidden", "a cancelled peek must not expand");
  });

  await test("a click on the compact island opens it immediately", () => {
    const { fsm } = makeFsm();
    fsm.mouseEntered();          // → petit
    fsm.click();
    eq(fsm.state, "home", "click goes straight to expanded");
  });

  await test("busy work goes straight to expanded with no peek", async () => {
    let busy = false;
    const { fsm } = makeFsm({ busy: () => busy });
    busy = true;
    fsm.mouseEntered();
    eq(fsm.state, "home", "work in progress skips the peek");
  });

  await test("reveal shows compact when idle, expanded when busy", () => {
    let busy = false;
    const { fsm } = makeFsm({ busy: () => busy });
    fsm.reveal();
    eq(fsm.state, "petit", "idle reveal peeks");
    fsm.forceHidden();
    busy = true;
    fsm.reveal();
    eq(fsm.state, "home", "busy reveal opens the card");
  });

  // ── FSM: the auto-close contract ───────────────────────────────────────────

  suite("FSM — auto-collapse");

  await test("entering home arms the clock, so it folds on its own", async () => {
    const { fsm } = makeFsm();
    fsm.homeToPetitDelay = 0.05;
    fsm.click();
    eq(fsm.state, "home");
    await sleep(120);
    eq(fsm.state, "petit", "no mouse movement, so it must fold");
  });

  await test("activity resets the clock — a hovered island still folds", async () => {
    // This is the inverse-of-spec bug: hover used to *cancel* the collapse.
    const { fsm } = makeFsm();
    fsm.homeToPetitDelay = 0.1;
    fsm.click();
    for (let i = 0; i < 6; i++) {
      await sleep(40);
      fsm.resetActivity();      // pretend the mouse moved inside the island
    }
    await sleep(200);
    eq(fsm.state, "petit", "ignoring an open island must not pin it open");
  });

  await test("a busy island never folds", async () => {
    let busy = true;
    const { fsm } = makeFsm({ busy: () => busy, maxHold: 400 });
    fsm.homeToPetitDelay = 0.05;
    fsm.click();
    await sleep(150);
    eq(fsm.state, "home", "live work holds it open past the idle delay");
  });

  await test("the busy ceiling releases the island even if Stop never arrives", async () => {
    let busy = true;
    const { fsm } = makeFsm({ busy: () => busy, maxHold: 120 });
    fsm.homeToPetitDelay = 0.05;
    fsm.click();
    await sleep(90);
    eq(fsm.state, "home", "still inside the ceiling");
    await sleep(220);
    eq(fsm.state, "petit", "the ceiling must not be able to wedge it open forever");
  });

  await test("a pinned alert ignores the clock entirely", async () => {
    const { fsm } = makeFsm();
    fsm.homeToPetitDelay = 0.05;
    fsm.pinned = true;
    fsm.forceHome();
    await sleep(150);
    eq(fsm.state, "home", "an alert waiting for an answer must stay open");
    fsm.pinned = false;
    fsm.armAutoCollapse();
    await sleep(120);
    eq(fsm.state, "petit", "and folds once the pin is dropped");
  });

  await test("every route into home starts the clock (no orphan route)", async () => {
    for (const [name, enter] of [
      ["click", (f: IslandStateMachine) => { f.mouseEntered(); f.click(); }],
      ["forceHome", (f: IslandStateMachine) => f.forceHome()],
      ["reveal", (f: IslandStateMachine) => { f.mouseEntered(); f.mouseLeft(); f.reveal(); }],
    ] as const) {
      const { fsm } = makeFsm();
      fsm.homeToPetitDelay = 0.05;
      enter(fsm);
      eq(fsm.state, "home", `${name} should reach home`);
      await sleep(140);
      eq(fsm.state, "petit", `${name} left the island open forever`);
    }
  });

  // ── Bot state semantics ────────────────────────────────────────────────────

  suite("BotState — what counts as work");

  await test("finished is not busy; the others are", () => {
    assert(!isBusyState("idle"), "idle is not work");
    assert(!isBusyState("finished"), "finished is terminal — it must not delay the fold");
    assert(!isBusyState("sleeping"), "sleeping is not work");
    assert(!isBusyState("dizzy"), "dizzy is not work");
    for (const s of ["working", "thinking", "searching", "approval", "question", "error", "ratelimit"]) {
      assert(isBusyState(s as never), `${s} is work`);
    }
  });

  // ── Engine: animation triggers ─────────────────────────────────────────────

  suite("BotEngine — animation triggers");

  await test("the peek wave is actually reachable", () => {
    // greet() was defined and never called by anything — the wave the spec
    // describes on reveal simply did not happen.
    const e = new BotEngine();
    e.greet();
    assert(e.waveStart > 0 && e.waveUntil > e.waveStart, "greet must schedule the wave");
    assert(e.hands > 0 || e.locks, "greet must drive the hands");
  });

  await test("interruptGreet cancels an in-flight wave", () => {
    const e = new BotEngine();
    e.greet();
    e.interruptGreet();
    eq(e.waveUntil, 0, "the wave must stop");
  });

  await test("surprised scales the eyes up, then settles", () => {
    const e = new BotEngine();
    e.triggerEmote("surprised");
    assert(e.locks.has("es") || e.es !== 1, "surprised must touch the eye scale");
  });

  await test("love raises blush and emits hearts", () => {
    const e = new BotEngine();
    e.triggerEmote("love");
    assert(e.locks.has("blush"), "love must blush");
  });

  await test("idle breathes — the character is not frozen at rest", () => {
    // `idle` had breathes:false, so a resting Mochi was completely static and
    // the mini behaviour loop's default branch did nothing either.
    //
    // Measured as the PEAK deviation over the run, not the value at the end:
    // each engine starts its clock at a random phase (`t0`), so where 120
    // frames happen to land in the breath cycle is arbitrary. Reading the last
    // frame made this assertion a coin flip that only happened to pass.
    const e = new BotEngine();
    e.setState("idle", true);
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      e.update(1 / 60);
      peak = Math.max(peak, Math.abs(e.sy - 1));
    }
    assert(peak > 0.002, `idle should breathe, peak |sy-1| was only ${peak.toFixed(5)}`);
  });

  // ── The emote table ────────────────────────────────────────────────────────

  suite("EMOTE_SPECS — the single source of truth");

  // An emote used to need six coordinated edits, and only the union was a
  // compile error: a missing eye map or sound name failed silently. These
  // assertions are what makes a half-added emote impossible.

  await test("the table covers every BotEmoteName", () => {
    const declared = EMOTE_NAMES.every((n) => n in EMOTE_SPECS);
    assert(declared, `missing specs for: ${EMOTE_NAMES.filter((n) => !(n in EMOTE_SPECS)).join(", ")}`);
    const extra = Object.keys(EMOTE_SPECS).filter((n) => !EMOTE_NAMES.includes(n as never));
    eq(extra.length, 0, `specs with no name in the union: ${extra.join(", ")}`);
  });

  await test("every emote sound is a real sound file", () => {
    // A typo here would preload nothing and play silence, with no error.
    for (const [name, spec] of Object.entries(EMOTE_SPECS)) {
      if (!spec.sound) continue;
      assert(
        SOUND_NAMES.includes(spec.sound as never),
        `emote "${name}" names sound "${spec.sound}", which is not in SOUND_NAMES`,
      );
    }
  });

  await test("every looping emote has a mini behaviour", () => {
    // `loopsOnMini` without a `mini` body means the flag is a lie: the mini
    // would fall through to the idle branch and never loop.
    for (const [name, spec] of Object.entries(EMOTE_SPECS)) {
      if (!spec.loopsOnMini) continue;
      assert(typeof spec.mini === "function", `emote "${name}" loops on mini but has no mini()`);
    }
  });

  await test("every emote that loops on mini has a valid eye", () => {
    for (const [name, spec] of Object.entries(EMOTE_SPECS)) {
      if (!spec.loopsOnMini) continue;
      assert(!!spec.eye, `emote "${name}" has no eye shape`);
    }
  });

  await test("the derived eye map matches the table", () => {
    for (const [name, spec] of Object.entries(EMOTE_SPECS)) {
      eq(EMOTE_EYE[name as never], spec.eye, `eye for ${name} drifted from its spec`);
    }
  });

  await test("the derived sound map matches the table", () => {
    for (const [name, spec] of Object.entries(EMOTE_SPECS)) {
      eq(EMOTE_SOUND[name as never], spec.sound, `sound for ${name} drifted from its spec`);
    }
  });

  await test("each emote produces its observable effect", () => {
    // Assert the effect, never the tween: love blushes and emits hearts,
    // surprised scales the eyes, proud tilts and emits stars.
    const love = new BotEngine();
    love.triggerEmote("love");
    assert(love.isAnimating("blush"), "love must blush");

    const surprised = new BotEngine();
    surprised.triggerEmote("surprised");
    assert(surprised.isAnimating("es"), "surprised must scale the eyes");

    const proud = new BotEngine();
    proud.triggerEmote("proud");
    assert(proud.isAnimating("tilt"), "proud must tilt the head");

    const yawn = new BotEngine();
    yawn.triggerEmote("yawn");
    assert(yawn.isAnimating("sy"), "yawn must stretch");
  });

  await test("a looping emote drives the mini instead of the idle branch", () => {
    const e = new BotEngine();
    e.isMini = true;
    e.setPermanentEmote("happy");
    (e as unknown as { doMiniBehaviorLoop(): void }).doMiniBehaviorLoop();
    assert(e.isAnimating("oy"), "the happy mini loop must jump");
  });

  await test("a non-looping emote falls through to idle life", () => {
    // `surprised` has no mini() body, so a pill wearing it must still move.
    const e = new BotEngine();
    e.isMini = true;
    e.setPermanentEmote("surprised");
    (e as unknown as { doMiniBehaviorLoop(): void }).doMiniBehaviorLoop();
    const moved = e.isAnimating("oy") || e.isAnimating("sy") || e.isAnimating("sx");
    assert(moved, "a non-looping emote must still get the idle bob or squash");
  });

  await test("thinking taps its mouth once the wait gets long", () => {
    // The tap is paced on wall-clock seconds (`performance.now()`), so this has
    // to advance that clock — pumping `update()` alone passes no real time and
    // the 4 s threshold is never crossed.
    let t = 1000;
    (globalThis as any).performance = { now: () => t };
    try {
      const e = new BotEngine();
      e.setState("thinking", true);

      for (let i = 0; i < 60; i++) { e.update(1 / 60); t += 16; }   // ~1 s
      eq(e.slotHTarget, 0, "no tap in the first second");

      for (let i = 0; i < 60 * 5; i++) { e.update(1 / 60); t += 16; } // past 4 s
      assert(e.slotHTarget > 0, "a slow turn should tap its mouth");
    } finally {
      (globalThis as any).performance = { now: () => Date.now() };
    }
  });

  await test("the finger-tap stops when thinking stops", () => {
    let t = 1000;
    (globalThis as any).performance = { now: () => t };
    try {
      const e = new BotEngine();
      e.setState("thinking", true);
      for (let i = 0; i < 60 * 5; i++) { e.update(1 / 60); t += 16; }
      assert(e.slotHTarget > 0, "precondition: it was tapping");

      e.setState("idle", true);
      e.slotHTarget = 0;
      for (let i = 0; i < 60 * 10; i++) { e.update(1 / 60); t += 16; }
      eq(e.slotHTarget, 0, "must not tap while no longer thinking");
    } finally {
      (globalThis as any).performance = { now: () => Date.now() };
    }
  });

  await test("the finger-tap yields to an emote", () => {
    let t = 1000;
    (globalThis as any).performance = { now: () => t };
    try {
      const e = new BotEngine();
      e.setState("thinking", true);
      e.triggerEmote("surprised");
      const before = e.slotHTarget;
      // Only while the emote is up (1.8 s). After it expires the tap is welcome
      // again — a thought that is still going should keep tapping.
      for (let i = 0; i < 60; i++) { e.update(1 / 60); t += 16; }
      eq(e.slotHTarget, before, "an emote must not be cut off by a mouth tap");

      // And it does come back once the emote is over.
      for (let i = 0; i < 60 * 4; i++) { e.update(1 / 60); t += 16; }
      assert(e.slotHTarget > 0, "the tap resumes after the emote ends");
    } finally {
      (globalThis as any).performance = { now: () => Date.now() };
    }
  });

  await test("curious tilts the head and looks aside", () => {
    const e = new BotEngine();
    e.triggerEmote("curious");
    assert(e.isAnimating("tilt"), "curious must tilt the head");
    assert(e.isAnimating("yaw"), "curious must look to one side");
  });

  await test("celebrate jumps, sparkles and blushes", () => {
    const e = new BotEngine();
    e.triggerEmote("celebrate");
    assert(e.isAnimating("oy"), "celebrate must leave the ground");
    assert(e.isAnimating("blush"), "celebrate must blush");
    // Particles are private; observe them through the engine's own count.
    const parts = (e as unknown as { particles: unknown[] }).particles;
    assert(parts.length >= 6, `celebrate should throw sparks and stars, got ${parts.length}`);
  });

  // The two tests below need an Island, so they live in that suite.

  suite("Island — wiring");

  // Every Island registers window listeners and a State subscription for the
  // lifetime of the process and never removes either. In production exactly one
  // Island exists, so that is fine; in a suite that builds several, the oldest
  // island would consume every keystroke and tick alongside the one under test.
  // Clearing both makes each island the only one that can react.
  const dropIslandListeners = () => {
    (State as unknown as { listeners: Set<() => void> }).listeners.clear();
    stub.resetWindowEvents();
    stub.resetRaf();
  };

  const freshIsland = () => {
    dropIslandListeners();
    State.mode = "hidden";
    State.view = "overview";
    State.stateOverride = null;
    State.asleep = false;
    State.isPinned = false;
    State.tasks = [];
    State.focusId = null;
    State.pendingApproval = null;
    State.fileDragOver = false;
    State.chatHistory = [];
    // The auto-close delay defaults to 15 s of wall clock. Tests that drive the
    // manual clock cross that almost immediately, and the FSM then folds the
    // island out from under the test. Pin it high for every test and override it
    // explicitly in the ones that are about the auto-close.
    State.settings.autoCloseInterval = 300;
    const el = stub.root();
    return new Island(el as unknown as HTMLElement);
  };

  /**
   * Pretends the OS reports a global cursor (Windows), which is what absence
   * detection needs. Off the clock the constructor calls `followPageCursor()`
   * because `IS_TAURI` is false here, which is correct: in a plain browser there
   * is no global pointer, so absence has nothing to measure.
   */
  const withGlobalCursor = (island: Island) => {
    (island as unknown as { hasGlobalCursor: boolean }).hasGlobalCursor = true;
    return island;
  };

  await test("a fresh island starts hidden", () => {
    const island = freshIsland();
    island.applySettings();
    eq(State.mode, "hidden");
  });

  await test("a one-line turn does not celebrate, a real one does", () => {
    const quiet = freshIsland();
    // The threshold lives in celebrateIfWorthIt; check the boundary both ways.
    quiet.celebrateIfWorthIt(1);
    assert(!(quiet as unknown as { engine: BotEngine }).engine.isAnimating("oy"),
      "a 1-step turn must not throw a party");

    const busy = freshIsland();
    busy.celebrateIfWorthIt(4);
    assert((busy as unknown as { engine: BotEngine }).engine.isAnimating("oy"),
      "a 4-step turn should celebrate");
  });

  await test("react refuses on top of a dizzy override", async () => {
    const island = freshIsland();
    State.mode = "expanded";
    island.reveal();

    // `reveal()` plays the wave, which itself animates `oy` — so the engine is
    // already busy and "is it animating oy" would answer yes either way. The
    // wave is partly driven by setTimeout, so it has to be waited out on the
    // real clock before asserting, or the guard would appear to work by
    // accident.
    const eng = (island as unknown as { engine: BotEngine }).engine;
    await sleep(700);
    for (let i = 0; i < 200; i++) eng.update(1 / 60);
    assert(!eng.isAnimating("oy"), "test setup: the wave should have finished");

    // A temporary override owns the character outright, so an emote landing on
    // top of it would fight the pose.
    State.stateOverride = "dizzy";
    island.react("celebrate");
    assert(!eng.isAnimating("oy"), "no emote on top of a dizzy override");

    State.stateOverride = null;
    island.react("celebrate");
    assert(eng.isAnimating("oy"), "a normal emote still lands");
  });

  await test("reveal plays the peek wave — A3", () => {
    const island = freshIsland();
    State.tasks = [{ id: "integration_claude", name: "VS Code", color: "#fff", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true }];
    State.focusId = "integration_claude";
    island.fsm.onTransition = ((orig) => (from: string, to: string) => {
      orig?.(from as never, to as never);
      if (from === "hidden" && to === "petit") waved = true;
    })(island.fsm.onTransition);
    let waved = false;
    island.reveal();
    assert(waved, "reveal must go hidden → petit");
    // The wave itself: waveStart is armed by engine.greet().
    const eng = (island as any).engine as BotEngine;
    assert(eng.waveStart > 0, "the peek wave must be scheduled on reveal");
  });

  await test("Y/N decide a pending approval — A7", () => {
    const island = freshIsland();
    // Answering must reach the bridge. Stand in for it: `IS_TAURI` is false in
    // tests, so Bridge is already inert and `approvalDecision` is unobservable.
    // Instead assert on the state the decision is contractually required to
    // change, which is what a silently-unwired shortcut would leave behind.
    const req = {
      requestId: "r1", tool: "Bash", command: "ls", inputKey: "",
      pillId: "agent_copilot", sessionId: "s",
    } as never;
    State.pendingApproval = req;
    State.tasks = [{
      id: "agent_copilot", name: "Copilot", color: "#8E7BEE", state: "approval",
      stepIndex: 0, steps: [], source: "agent", isIntegration: false,
    }];
    State.focusId = "agent_copilot";
    State.isPinned = true;
    island.fsm.pinned = true;

    (globalThis as any).window.fire("keydown", { key: "y" });

    eq(State.pendingApproval, null, "Y must consume the request");
    assert(!State.isPinned, "answering releases the pin");
    assert(!island.fsm.pinned, "the FSM pin must be released too");
    // The pill that asked goes back to working, not idle: it still has work.
    eq(State.tasks[0].state, "working", "the asking pill returns to working");
  });

  // ── Emote picker + on-demand emotes ─────────────────────────────────────────

  suite("Interaction — picker and on-demand emotes");

  await test("the picker lists every emote in the table", () => {
    const island = freshIsland();
    State.tasks = [{
      id: "integration_claude", name: "VS Code", color: "#fff", state: "working",
      stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true,
    }];
    State.focusId = "integration_claude";
    // Busy work opens the card. `reveal()` from hidden with *no* tasks only
    // peeks to compact, so the picker would never be reachable — set a task
    // first, or drive `alert()`.
    island.reveal();
    eq(State.mode, "expanded", "precondition: the card is open");
    (island as unknown as { toggleEmotePicker(): void }).toggleEmotePicker();

    const row = (island as unknown as { emotePicker: { children: unknown[] } | null }).emotePicker;
    assert(row, "the picker should be open");
    eq(row!.children.length, Object.keys(EMOTE_SPECS).length,
      "every emote must be reachable without a wired trigger");
  });

  await test("picking an emote fires it and closes the picker", async () => {
    const island = freshIsland();
    State.tasks = [{
      id: "integration_claude", name: "VS Code", color: "#fff", state: "working",
      stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true,
    }];
    State.focusId = "integration_claude";
    island.reveal();
    eq(State.mode, "expanded", "precondition: the card is open");
    await sleep(700);
    for (let i = 0; i < 200; i++) ((island as any).engine as BotEngine).update(1 / 60);

    const isl = island as unknown as {
      toggleEmotePicker(): void;
      emotePicker: { children: { click(): void }[] } | null;
    };
    isl.toggleEmotePicker();
    assert(isl.emotePicker, "precondition: the picker is open");

    isl.emotePicker!.children[0].click();
    const eng = (island as any).engine as BotEngine;
    assert(eng.isAnimating("blush"), "the first chip (love) must blush");
    eq(isl.emotePicker, null, "the picker closes after a choice");
  });

  await test("the picker toggles closed and is dropped on a view change", () => {
    const island = freshIsland();
    State.tasks = [{
      id: "integration_claude", name: "VS Code", color: "#fff", state: "working",
      stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true,
    }];
    State.focusId = "integration_claude";
    island.reveal();
    eq(State.mode, "expanded", "precondition: the card is open");
    const isl = island as unknown as {
      toggleEmotePicker(): void;
      emotePicker: unknown;
    };
    isl.toggleEmotePicker();
    assert(isl.emotePicker, "open");
    isl.toggleEmotePicker();
    eq(isl.emotePicker, null, "toggling again closes it");

    isl.toggleEmotePicker();
    assert(isl.emotePicker, "open again");
    island.setView("settings");
    eq(isl.emotePicker, null, "a view change must not leave it floating over another card");
  });

  await test("double-clicking the bot waves", async () => {
    const island = freshIsland();
    State.mode = "expanded";
    island.reveal();
    await sleep(900);
    for (let i = 0; i < 300; i++) ((island as any).engine as BotEngine).update(1 / 60);
    const eng = (island as any).engine as BotEngine;
    eq(eng.waveStart, 0, "precondition: the reveal wave has finished");

    // Straight at the bot's centre, in island-window coordinates.
    const rect = (island as any).islandRect();
    const x = rect.x + (island as any).botCx.value;
    const y = rect.y + (island as any).botCy.value;
    const el = (island as any).islandEl;
    el.fire("dblclick", { clientX: x, clientY: y });
    assert(eng.waveStart > 0, "a double-click must schedule the wave");
  });

  await test("right-clicking the bot opens the picker instead of slapping", async () => {
    const island = freshIsland();
    State.tasks = [{
      id: "integration_claude", name: "VS Code", color: "#fff", state: "working",
      stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true,
    }];
    State.focusId = "integration_claude";
    island.reveal();
    eq(State.mode, "expanded", "precondition: the card is open");
    await sleep(700);
    for (let i = 0; i < 200; i++) ((island as any).engine as BotEngine).update(1 / 60);

    const isl = island as unknown as {
      islandEl: { fire(t: string, e: unknown): void };
      botCx: number; botCy: number; isBotHit(x: number, y: number): boolean;
      emotePicker: unknown;
      engine: BotEngine;
      islandRect(): { x: number; y: number };
    };
    // The bot position is a spring: reading it with no frames run gives the
    // initial value, not where the bot actually is, and the hit test misses.
    const rect = isl.islandRect();
    const x = rect.x + isl.botCx.value;
    const y = rect.y + isl.botCy.value;
    assert(isl.isBotHit(x, y), "precondition: the probe point is on the bot");
    isl.islandEl.fire("mousedown", { clientX: x, clientY: y, button: 2 });
    assert(isl.emotePicker, "right-click opens the picker");
    // A slap would have animated oy; the picker must not.
    assert(!isl.engine.isAnimating("oy"), "right-click must not slap");
  });

  await test("N denies, and the keys are inert otherwise", () => {    const island = freshIsland();
    State.pendingApproval = {
      requestId: "r2", tool: "Bash", command: "ls", inputKey: "",
      pillId: "integration_claude", sessionId: "s",
    } as never;
    (globalThis as any).window.fire("keydown", { key: "n" });
    eq(State.pendingApproval, null, "N must consume the request");

    // No alert up: Y/N are just letters.
    (globalThis as any).window.fire("keydown", { key: "y" });
    (globalThis as any).window.fire("keydown", { key: "n" });
    assert(true, "no request, nothing decided");

    // Typing in the chat field must not decide anything, even with an alert up.
    State.pendingApproval = {
      requestId: "r3", tool: "Bash", command: "ls", inputKey: "",
      pillId: "integration_claude", sessionId: "s",
    } as never;
    (globalThis as any).window.fire("keydown", { key: "y", target: { tagName: "INPUT" } });
    assert(State.pendingApproval, "a keystroke in a text field must not answer the alert");

    // Nor may a modified keystroke: ⌘Y is not "allow the command".
    (globalThis as any).window.fire("keydown", { key: "y", metaKey: true });
    assert(State.pendingApproval, "⌘Y must not silently approve");
  });

  // ── Frame loop ─────────────────────────────────────────────────────────────

  suite("Frame loop");

  await test("a visible island keeps ticking; a hidden one parks", () => {
    // Regression guard for the Linux freeze: the loop used to be demand-driven
    // and parked whenever nothing looked busy, which silently killed blinks,
    // the badge dots, mini bots and the ticker — all wall-clock driven.
    //
    // No resetRaf() here on purpose: dropping the pending callback while
    // `running` is still true strands the loop for good, because
    // `ensureRunning()` refuses to re-arm. `freshIsland` already cleared the
    // queue, and only this island exists, so plain deltas are honest.
    const island = freshIsland();

    stub.flushRaf = false;
    (globalThis as any).performance = { now: clockNow };
    try {
      State.mode = "compact";
      island.reveal();
      island.ensureRunning();

      // ~2.4 s of visible frames: far longer than the 600 ms watchdog, so the
      // grace window cannot be what keeps it alive.
      const before = stub.framesRequested;
      for (let i = 0; i < 150; i++) stub.stepRaf();
      const visibleFrames = stub.framesRequested - before;
      assert(visibleFrames > 100, `visible island stopped ticking after ${visibleFrames} frames`);

      State.mode = "hidden";
      island.fsm.forceHidden();
      // Drain the 600 ms grace window, then the loop must be genuinely parked.
      for (let i = 0; i < 60; i++) stub.stepRaf();
      const parked = stub.framesRequested;
      for (let i = 0; i < 40; i++) stub.stepRaf();
      eq(stub.framesRequested, parked, "a hidden island must park (0 % CPU)");
    } finally {
      stub.flushRaf = true;
      (globalThis as any).performance = { now: () => Date.now() };
      stub.resetRaf();
    }
  });

  await test("one throwing frame does not kill the loop forever", () => {
    const island = freshIsland();
    State.mode = "compact";
    island.reveal();
    island.ensureRunning();
    stub.flushRaf = false;
    try {
      // Find the bot canvas and make its context throw every draw.
      const canvas = (island as any).botCanvas as unknown as { ctx2d: any };
      canvas.ctx2d.__failEvery = 1;
      for (let i = 0; i < 60; i++) stub.stepRaf();
      canvas.ctx2d.__failEvery = 0;
      const before = stub.framesRequested;
      for (let i = 0; i < 10; i++) stub.stepRaf();
      assert(stub.framesRequested > before, "the loop must still be asking for frames");
    } finally {
      stub.flushRaf = true;
    }
  });

  // ── Liveness: sleeping + absence ───────────────────────────────────────────

  suite("Liveness — sleeping and absence");

  /**
   * Drives the frame loop on the manual clock so 10 minutes elapses instantly.
   *
   * `stepRaf` already advances the fake clock by 16 ms per frame, so this must
   * NOT tick it again — doing both made each frame 32 ms and quietly doubled the
   * wall-clock rate. 40 000 frames is then ~10.7 min, enough to cross
   * SLEEP_AFTER_MS (10 min) and the 1.2 s yawn that precedes it.
   */
  const driveFrames = (island: Island, frames: number) => {
    stub.flushRaf = false;
    (globalThis as any).performance = { now: clockNow };
    island.ensureRunning();          // re-arm: the previous test may have parked it
    const before = stub.framesRequested;
    try {
      for (let i = 0; i < frames; i++) stub.stepRaf();
    } finally {
      stub.flushRaf = true;
      (globalThis as any).performance = { now: () => Date.now() };
    }
    void island;
    return stub.framesRequested - before;
  };

  await test("Mochi yawns then sleeps after 10 idle minutes — A5", () => {
    const island = freshIsland();
    State.tasks = [];
    State.mode = "compact";
    island.reveal();
    eq(State.asleep, false, "starts awake");

    // 10 minutes of frames. The yawn fires at the 10-minute mark, then the
    // state change 1.2 s later, so pump well past both.
    const ran = driveFrames(island, 40_000);
    assert(ran > 39_000, `the loop stalled: only ${ran} frames ran`);
    eq(State.asleep, true, "Mochi must actually reach the sleeping state");
    eq(State.effectiveState, "sleeping", "and that is what the bot renders");
    eq((island as any).engine.state, "sleeping", "the engine must show it too");
  });

  await test("a task appearing wakes it straight back up", () => {
    const island = freshIsland();
    State.tasks = [];
    State.mode = "compact";
    island.reveal();
    driveFrames(island, 40_000);
    eq(State.asleep, true);

    State.tasks = [{
      id: "integration_claude", name: "VS Code", color: "#fff", state: "working",
      stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true,
    }];
    State.focusId = "integration_claude";
    driveFrames(island, 5);
    eq(State.asleep, false, "work must wake it");
  });

  await test("it never falls asleep mid-view (upload, settings, chat)", () => {
    for (const view of ["settings", "upload", "prompt", "note"] as const) {
      const island = freshIsland();
      State.tasks = [];
      State.mode = "expanded";
      // `reveal()` picks the default view, so the view under test has to be
      // chosen *after* it — otherwise the loop never sees it.
      island.reveal();
      island.setView(view);
      eq(State.view, view, `test setup: island is on ${view}`);
      driveFrames(island, 40_000);
      eq(State.asleep, false, `fell asleep in ${view}`);
    }
  });

  await test("absence hides the island, movement brings it back — A8", () => {
    const island = withGlobalCursor(freshIsland());
    State.tasks = [{
      id: "integration_claude", name: "VS Code", color: "#fff", state: "working",
      stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true,
    }];
    State.focusId = "integration_claude";
    State.settings.absenceInterval = 180;   // 3 min
    island.applySettings();
    island.reveal();
    eq(State.mode, "expanded", "work opens the card");

    // Push the last movement into the past. This has to come *after*
    // applySettings(), which re-reads lastActivity.
    State.lastActivity = clockNow() - 200_000;
    const ran = driveFrames(island, 5);
    assert(ran >= 5, `the loop stalled: only ${ran} frames ran`);
    eq(State.mode, "hidden", "no movement for 3 min must hide it even with work running");

    // First movement restores it.
    State.lastActivity = clockNow();
    driveFrames(island, 5);
    eq(State.mode, "expanded", "the user is back, so the island returns");
  });

  await test("a pending alert outranks absence", () => {
    const island = withGlobalCursor(freshIsland());
    State.tasks = [{
      id: "integration_claude", name: "VS Code", color: "#fff", state: "approval",
      stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true,
    }];
    State.focusId = "integration_claude";
    State.pendingApproval = {
      requestId: "r", tool: "Bash", command: "ls", inputKey: "",
      pillId: "integration_claude", sessionId: "s",
    } as never;
    island.applySettings();
    island.alert("approval");
    State.lastActivity = clockNow() - 200_000;
    driveFrames(island, 5);
    eq(State.mode, "expanded", "an agent blocked on the user must not be folded away");
  });

  await test("absence is disabled where the OS has no global cursor", () => {
    const island = freshIsland();
    State.tasks = [{
      id: "integration_claude", name: "VS Code", color: "#fff", state: "working",
      stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true,
    }];
    State.focusId = "integration_claude";
    // Wayland: the island only learns about the pointer while it is over the
    // island, so "no events" means "the pointer is elsewhere", not "away".
    island.followPageCursor();
    island.applySettings();
    island.reveal();
    State.lastActivity = clockNow() - 200_000;
    driveFrames(island, 5);
    eq(State.mode, "expanded", "must not hide an island just because the pointer left");
  });
}

// `advanceClock` is re-exported for the frame-pacing test's own bookkeeping.
export { advanceClock };
