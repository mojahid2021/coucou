// Island open/close FSM — port of IslandStateMachine.swift.
// No DOM, no Tauri: it only reports transitions.

export type FsmState = "hidden" | "petit" | "home" | "coucou";

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /** home → petit delay, seconds. */
  homeToPetitDelay = 15;
  /** petit → hidden delay, seconds. */
  petitToHiddenDelay = 60;
  /** coucou → petit once the greeting animation ends (no hover). */
  greetAutoCollapseDelay = 0.6;
  /** coucou → petit while the mouse hovers the greeting. */
  greetHoverCollapseDelay = 10;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;
  /** True while at least one agent is working. While this holds, the island
   *  auto-expands and no auto-close timer runs: an island showing live work
   *  must not fold under the user. */
  isBusy: () => boolean = () => false;
  /** hidden → home after this long hovering the notch. */
  peekExpandDelay = 0.65;
  /** petit → home after this long hovering the compact island. */
  compactExpandDelay = 0.2;
  /** Hard ceiling on how long live work may hold the island open, in ms. A
   *  `Stop` that never arrives would otherwise keep the card expanded for good. */
  busyMaxHold = 600_000;

  private petitHide: number | null = null;
  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;
  private dwellExpand: number | null = null;
  private busySince: number | null = null;

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("coucou");
  }

  mouseEntered() {
    switch (this.state) {
      case "hidden":
        if (this.isBusy()) {
          // Work in progress: straight to the expanded card, no peek.
          this.cancelTimers();
          this.transition("home");
        } else {
          this.cancelTimers();
          this.transition("petit");
          this.scheduleDwellExpand(this.peekExpandDelay);
        }
        break;
      case "petit":
        this.clear("petitHide");
        // Hovering the compact island opens it.
        if (!this.pinned) this.scheduleDwellExpand(this.compactExpandDelay);
        break;
      case "home":
        // Interaction resets the auto-close clock.
        this.resetActivity();
        break;
      case "coucou":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  mouseLeft() {
    this.clear("dwellExpand");
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.schedulePetitHide();
        break;
      case "home":
        // Leaving does not close the island, but the auto-close clock keeps
        // running: it was armed when `home` was entered, not here.
        this.scheduleHomeCollapse();
        break;
      case "coucou":
        this.clear("greetCollapse");
        this.transition("petit");
        break;
    }
  }

  /** Any interaction with the open island: mouse move, click or keypress. */
  resetActivity() {
    if (this.state !== "home") return;
    this.scheduleHomeCollapse();
  }

  /** Starts (or restarts) the auto-close clock for the expanded island. */
  armAutoCollapse() {
    if (this.state !== "home") return;
    this.scheduleHomeCollapse();
  }

  /** Work state changed (an agent started or went idle). */
  busyStateChanged() {
    if (this.isBusy()) {
      // Stamped on the busy edge only: a task churning between `working` and
      // `thinking` must not keep resetting the ceiling.
      if (this.busySince == null) this.busySince = performance.now();
      if (this.state !== "hidden" && this.state !== "petit") {
        this.scheduleHomeCollapse();   // re-arm the bounded busy hold
        return;
      }
      this.cancelTimers();
      this.transition("home");
    } else {
      this.busySince = null;
      if (this.state === "home") this.scheduleHomeCollapse();
    }
  }

  /**
   * Compact island clicked.
   *
   * Also accepts `hidden`: after an alert the island can be on screen while the
   * FSM never saw the mouse enter, and the click must still open it. Matches
   * `IslandStateMachine.click()`.
   */
  click() {
    if (this.state !== "petit" && this.state !== "hidden") return;
    this.cancelTimers();
    // `transition` arms the auto-close clock on entry to `home`.
    this.transition("home");
  }

  /** Greeting animation finished (T.end). Doesn't override a running hover timer. */
  greetComplete() {
    if (this.state !== "coucou") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    // Work in progress deserves the full card, not the compact strip.
    if (this.isBusy()) {
      this.transition("home");
    } else {
      this.transition("petit");
      this.schedulePetitHide();
    }
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.transition("home");
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.cancelTimers();
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private schedulePetitHide() {
    this.clear("petitHide");
    this.petitHide = window.setTimeout(() => {
      this.petitHide = null;
      if (this.state === "petit") this.transition("hidden");
    }, this.petitToHiddenDelay * 1000);
  }

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    // A pinned alert holds the island open unconditionally.
    if (this.pinned) return;

    let delay: number;
    if (this.isBusy()) {
      // Live work holds it too, but only up to busyMaxHold: a `Stop` that never
      // arrives would otherwise keep the card expanded for good.
      const held = this.busySince == null ? 0 : performance.now() - this.busySince;
      delay = Math.max(0, this.busyMaxHold - held);
      if (delay <= 0) return;
    } else {
      delay = this.homeToPetitDelay * 1000;
    }

    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      if (this.state !== "home" || this.pinned) return;
      // The busy hold expires on wall-clock, not on "the callback happened to be
      // early": a timer that fires a millisecond early must re-arm for the
      // remainder instead of returning and leaving the island open forever.
      if (this.isBusy()) {
        const left = this.busyMaxHold - (performance.now() - (this.busySince ?? performance.now()));
        if (left > 0) { this.scheduleHomeCollapse(); return; }
      }
      this.transition("petit");
    }, delay);
  }

  /** Hover long enough on the peek or the compact island and it expands by itself. */
  private scheduleDwellExpand(delay: number) {
    this.clear("dwellExpand");
    const from = this.state;
    this.dwellExpand = window.setTimeout(() => {
      this.dwellExpand = null;
      if (this.state !== from) return;
      if (this.pinned) return;
      this.cancelTimers();
      this.transition("home");
    }, delay * 1000);
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    this.greetCollapse = window.setTimeout(() => {
      this.greetCollapse = null;
      if (this.state === "coucou") this.transition("petit");
    }, delay * 1000);
  }

  private clear(which: "petitHide" | "homeCollapse" | "greetCollapse" | "dwellExpand") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
  }

  cancelTimers() {
    this.clear("petitHide");
    this.clear("homeCollapse");
    this.clear("greetCollapse");
    this.clear("dwellExpand");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
    // Entering the expanded state always (re)starts the auto-close clock, so no
    // route into `home` can leave the island open forever. `onTransition` runs
    // first: it is what actually puts the island on screen, and arming must be
    // the last thing that happens.
    if (next === "home") this.scheduleHomeCollapse();
  }
}
