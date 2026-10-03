// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName, type BotEmoteName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State, clampAutoClose } from "../core/state";
import { BotEngine, EMOTE_SPECS, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The slap flash, per SPEC §7 and the prototype's `--g:#A855F7 --go:.7`. */
const ANNOYED_GLOW = "#A855F7";
const ANNOYED_GLOW_OPACITY = 0.7;
/** How long the slap flash lasts. The prototype holds it for 900 ms. */
const ANNOYED_GLOW_MS = 900;

/** SPEC §7: `sleeping` = no task for this long while the island is open. */
const SLEEP_AFTER_MS = 10 * 60 * 1000;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Views that are a moment rather than a resting place: the bot must not fall
 *  asleep while one of them is up (SPEC §7 says "opened manually", not "mid
 *  upload" or "reading settings"). */
const TEMPORARY_VIEWS: ReadonlySet<IslandViewName> = new Set([
  "upload", "uploading", "choose", "prompt", "searching", "result",
  "mail", "note", "settings", "greeting", "confused",
]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  /**
   * Keep ticking until this timestamp even when nothing looks busy.
   *
   * `requestAnimationFrame` is not guaranteed to be delivered while the window is
   * unmapped, so a wake-up can hand out a frame that never arrives. Two windows
   * guard against that: a short grace period after every wake-up, and a longer
   * one after a frame has thrown. See `stepFrameLoop`.
   */
  private watchdogUntil = 0;
  /** Counts frame failures, purely so the log cannot be flooded by a per-frame throw. */
  private frameErrors = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;
  /** Last cursor position over the island, used to turn per-frame cursor samples
   *  into discrete "the user moved" activity events. */
  private lastActivityPt = { x: 0, y: 0 };
  /** Throttle for the auto-close restart on the 60 Hz cursor poll. */
  private lastActivityReset = 0;
  /** Cached `State.hasActiveWork` so a 60 Hz cursor poll only reacts to real edges. */
  private lastBusy = false;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;
  /** Until when the halo shows the slap's violet flash. */
  private annoyedUntil = 0;
  /** The emote chip row, while it is open. */
  private emotePicker: HTMLElement | null = null;
  /** Since when there has been no task at all. Drives the `sleeping` state. */
  private idleSince = 0;
  /** Set while the yawn that precedes sleep is playing, so it cannot repeat. */
  private sleepYawnAt = 0;
  /** False where the OS has no global cursor, which absence detection needs. */
  private hasGlobalCursor = true;
  /** True while absence (SPEC §3 rule 6) is what has the island folded. */
  private awayHidden = false;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
      },
      openTerminal: () => {
        const cwd = State.focusTask?.sessionCwd ?? null;
        void Bridge.openInVSCode(cwd);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === "integration_claude") void Bridge.openInVSCode(task.sessionCwd ?? null);
        else if (task.id === "agent_copilot") void Bridge.openCopilotCLI(task.sessionCwd ?? null);
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => this.decide(d),
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = clampAutoClose(s);
        this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
        this.armCollapseCountdown();
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.isBusy = () => State.hasActiveWork;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden") {
            Sound.play("peek");
            // Mochi comes out of the notch saying hello. `greet()` was written
            // and never called by anything, so the peek was a silent appearance.
            // Not on the launch greeting, which draws its own wave on canvas.
            this.engine.greet();
          }
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          // Arm the auto-close clock unconditionally. `mouseLeft()` only
          // cancelled it when the cursor was away, which left a hovered island
          // open forever — the delay has to be an inactivity timer.
          this.fsm.armAutoCollapse();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  /**
   * Answers the pending permission request. Shared by the card's buttons and the
   * Y/N shortcuts, so there is exactly one definition of what deciding does.
   *
   * A request that is not there is not an error: the buttons and the keys can
   * both outlive the card (an alert can be withdrawn from the relay between the
   * click and the handler), and answering nothing is the safe outcome.
   */
  private decide(decision: "allow" | "deny") {
    const req = State.pendingApproval;
    void Bridge.log(`decide ${decision} req=${req?.requestId ?? "none"}`);
    if (!req) return;
    Sound.play(decision === "deny" ? "blip" : "approve");
    void Bridge.approvalDecision(req.requestId, decision);
    State.pendingApproval = null;
    State.isPinned = false;
    this.fsm.pinned = false;
    // The card can belong to any agent pill, so reset the one that asked rather
    // than assuming Claude Code — otherwise a Copilot request leaves its own
    // pill stuck on "approval" while an idle Claude pill flickers to "working".
    const pillId = req.pillId ?? "integration_claude";
    State.updateTask(pillId, "working");
    State.setPillBadge(pillId, null);
    this.setView(State.defaultView());
  }

  /** True when a keystroke belongs to a text field rather than to the island. */
  private typingInField(target: EventTarget | null): boolean {
    const el = target as { tagName?: string; isContentEditable?: boolean } | null;
    if (!el) return false;
    const tag = (el.tagName ?? "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
  }

  launch() {
    this.fsm.launch();
  }

  /**
   * React to something happening, in a way the caller does not have to know the
   * details of. Hooks stay declarative: they report *what* happened, and the
   * island decides whether the character is even on screen and whether the
   * reaction would interrupt something.
   *
   * Every emote goes through here rather than straight to `engine.triggerEmote`,
   * so a hidden island does not accumulate emotes that fire into the void when
   * it next appears, and so one place can refuse an emote during a dizzy or an
   * upload.
   */
  react(emote: BotEmoteName, duration?: number) {
    // A temporary override (dizzy/confused) and the drop sequence both own the
    // character outright; an emote on top of either would fight the pose.
    if (State.stateOverride != null) return;
    if (this.uploadActive) return;
    if (State.view === "greeting") return;
    this.engine.triggerEmote(emote, duration);
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /**
   * A task finished. A task that actually did something gets a celebration; a
   * one-line edit does not, because throwing a party for "fixed a typo" would
   * train the user to ignore it.
   */
  celebrateIfWorthIt(steps: number) {
    if (steps >= 3) this.react("celebrate");
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") {
      Sound.play("open");
      // SPEC §4: "Au passage en `expanded`, le bonhomme cligne des yeux."
      // The greeting draws its own Mochi on its own canvas, so blinking the
      // engine's bot there would be invisible — and would fight its pose.
      if (State.view !== "greeting") this.engine.blink();
    }
    if (prev === "expanded") {
      Sound.play("close");
      // A pending alert owns its pin. Clearing it here meant any transition out
      // of expanded could strip a live approval of its no-auto-close guarantee.
      if (!State.pendingApproval) {
        State.isPinned = false;
        this.fsm.pinned = false;
      }
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    // Seed the movement tracker, otherwise the first frame after opening reads as
    // a large jump and counts as activity before the user moved.
    this.lastActivityPt = { x: State.mouse.x, y: State.mouse.y };
    this.armCollapseCountdown();
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    // A picker left open across a view change would float over an unrelated
    // card, and it holds no state worth carrying over.
    this.closeEmotePicker();
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.armCollapseCountdown();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  /**
   * The cursor left the island: end the hover and start the collapse clock.
   *
   * Shared by the DOM hover listeners and the cursor poll so there is exactly one
   * definition of "the mouse is no longer over the island". On Linux there is no
   * global cursor (see platform::CURSOR_POLL), so the DOM listeners are the only
   * thing that can report a leave at all.
   *
   * `wasInIsland` is cleared here because `onTransition` reads it: a reveal that
   * happens while the pointer is genuinely elsewhere has to keep its own collapse
   * timer, or it would be torn down the instant it opened.
   */
  private markMouseOutside() {
    if (State.mode === "hidden") return;
    const wasInside = this.wasInIsland;
    this.wasInIsland = false;
    this.fsm.mouseLeft();
    if (wasInside) this.armCollapseCountdown();
  }

  /**
   * Starts (or restarts) the auto-close clock: the FSM timeout that folds the
   * island, and `homeCollapseAt` that drives the countdown bar.
   *
   * The two used to be armed from different places — the FSM from `mouseLeft()`
   * and the bar from `expand()` — which is how a hovered island ended up with a
   * bar that never emptied. One entry point keeps them in step.
   */
  private armCollapseCountdown() {
    if (this.fsm.state !== "home" || State.isPinned || State.hasActiveWork) {
      this.homeCollapseAt = null;
      return;
    }
    this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
    this.fsm.armAutoCollapse();
  }

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") {
        this.watchdogUntil = performance.now() + 600;
        this.fsm.mouseEntered();
      }
    });
    this.wakeStrip.addEventListener("mouseleave", () => {
      // Crossing the top of the screen without opening is not a hover end, and
      // reporting one here would collapse an island the cursor never reached.
      if (State.mode === "hidden") return;
      this.markMouseOutside();
    });

    // Once the island is on screen it is far bigger than the 6 px strip, so it
    // owns the hover: the cursor sits over #island, not over #wake-strip, and a
    // strip-only listener never sees the edge being crossed. `mouseenter` and
    // `mouseleave` do not bubble, so this is the only place that crossing is seen.
    //
    // On Windows the cursor poll reports the same thing a few milliseconds
    // either side, and `mouseEntered` is idempotent per state, so the overlap is
    // harmless — `wasInIsland` is set here to keep the poll from re-firing it.
    this.islandEl.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") return;
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.wasInIsland = true;
      this.watchdogUntil = performance.now() + 600;
      this.fsm.mouseEntered();
      this.armCollapseCountdown();
    });
    this.islandEl.addEventListener("mouseleave", () => this.markMouseOutside());

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      // A click is activity: restart the auto-close countdown.
      this.armCollapseCountdown();
      if (this.isBotHit(e.clientX, e.clientY)) {
        // Right-click opens the emote picker instead of slapping: slapping is
        // destructive enough (three of them and Mochi is dizzy) that it should
        // not be the thing a mis-aimed right-click triggers.
        if (e.button === 2) {
          this.toggleEmotePicker();
          return;
        }
        this.onBotClick();
      } else if (e.button === 2) {
        this.toggleEmotePicker();
      }
    });

    // The native menu would swallow the right-click before the island ever sees
    // it, and a menu item per emote is slower than a small in-island popover.
    this.islandEl.addEventListener("contextmenu", (e) => e.preventDefault());

    // Double-click the bot for the wave. `greet()` used to be unreachable; it
    // fires on reveal now, but there was still no way to ask for it on demand.
    this.islandEl.addEventListener("dblclick", (e) => {
      if (State.mode !== "expanded" || !this.isBotHit(e.clientX, e.clientY)) return;
      this.cancelBotHover();
      this.engine.greet();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
      // Typing is activity: the island must not fold mid-sentence.
      if (e.key !== "Escape") this.armCollapseCountdown();

      // Y/N answer the permission card. The card advertises both keys in its
      // buttons, so they have to work — and they were never wired, which made
      // the hints a lie. Gated three ways: an alert must be up, the user must
      // not be typing in the chat or mail field, and the key must not carry a
      // modifier (⌘Y / Ctrl+Y must not silently allow a command).
      if (State.pendingApproval && !e.metaKey && !e.ctrlKey && !e.altKey && !this.typingInField(e.target)) {
        const key = e.key.toLowerCase();
        if (key === "y") { e.preventDefault(); this.decide("allow"); return; }
        if (key === "n") { e.preventDefault(); this.decide("deny"); return; }
      }
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    // Where the OS cannot report a global pointer, absence detection has nothing
    // to measure: the events only fire while the pointer is over the island, so
    // "no events" means "the pointer is elsewhere", not "the user is away".
    // Firing anyway would hide the island the moment the pointer left it.
    this.hasGlobalCursor = false;
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    // Any pointer movement anywhere is "the user is here". Absence detection
    // (SPEC §3 rule 6) watches this, and it is driven by the global cursor poll
    // on Windows — so this has to be stamped before the `inIsland` tests below,
    // which only cover the island itself. Restoring an island that absence
    // folded depends on it.
    if (this.hasGlobalCursor) {
      const moved = Math.hypot(x - State.mouse.x, y - State.mouse.y) > 1;
      if (moved) State.lastActivity = performance.now();
    }
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
      this.armCollapseCountdown();
    }
    if (!inIsland && this.wasInIsland) this.markMouseOutside();
    this.wasInIsland = inIsland;

    // Moving the mouse over the open island counts as activity, so the delay is
    // measured from the last movement rather than from when the island opened.
    if (inIsland && State.mode === "expanded" && !State.hasActiveWork) {
      const moved = Math.hypot(x - this.lastActivityPt.x, y - this.lastActivityPt.y) > 1;
      if (moved) {
        this.lastActivityPt = { x, y };
        State.lastActivity = performance.now();
        // Restart the timer at most a few times a second: on the 60 Hz cursor
        // poll a moving mouse would otherwise re-arm it every frame, for no
        // benefit, since the shortest delay is 3 s.
        if (performance.now() - this.lastActivityReset > 400) {
          this.lastActivityReset = performance.now();
          this.armCollapseCountdown();
        }
      }
    }

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  /** A left-click on the bot: a slap, with the violet flash that goes with it. */
  private onBotClick() {
    this.engine.slap();
    // Flash the halo violet, unless this was the third slap — that one hands
    // over to `dizzy`, which drives its own colour and shows the confused view,
    // so a violet flash under it would just be noise.
    if (State.stateOverride !== "dizzy") this.annoyedUntil = performance.now() + ANNOYED_GLOW_MS;
  }

  // ── Emote picker ────────────────────────────────────────────────────────────

  /**
   * A small row of chips over the island, one per emote.
   *
   * This is the piece that makes emotes worth adding: without it every new emote
   * needs its own trigger wired somewhere, and an emote with no trigger is
   * exactly how `greet()` and `sleeping` were found dead in this codebase. With
   * it, an emote added to `EMOTE_SPECS` is reachable by the user immediately.
   * It also doubles as the demo surface the SPEC's Debug menu implies.
   *
   * A row rather than a radial on purpose: a radial needs hit-testing against a
   * moving, scaling island and would collide with the 42 pt right-hand column
   * the spec reserves for secondary agents.
   */
  private toggleEmotePicker() {
    if (State.mode !== "expanded") return;
    if (this.emotePicker) {
      this.closeEmotePicker();
      return;
    }

    const row = h("div", { id: "emote-picker" });
    for (const name of Object.keys(EMOTE_SPECS) as BotEmoteName[]) {
      const chip = h("button", { class: "emote-chip", type: "button" }, name);
      chip.addEventListener("click", () => {
        this.react(name);
        this.closeEmotePicker();
      });
      row.append(chip);
    }

    this.root.append(row);
    // Positioned from the bot, so it follows whichever view is up.
    const rect = this.islandRect();
    row.style.left = `${rect.x + this.botCx.value}px`;
    row.style.top = `${rect.y + this.botCy.value + this.botSize.value / 2 + 10}px`;
    this.emotePicker = row;
  }

  private closeEmotePicker() {
    this.emotePicker?.remove();
    this.emotePicker = null;
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    // Every wake-up gets a grace window: a hover can open and close the island
    // inside one frame, and without this the loop can park with the peek
    // half-finished and no outstanding animation to keep it awake.
    this.watchdogUntil = Math.max(this.watchdogUntil, this.lastFrame + 600);
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    try {
      this.stepFrame(nowMs);
    } catch (err) {
      // One throw used to kill every animation for the rest of the session: the
      // frame that threw never reached its own `requestAnimationFrame`, and
      // `running` stayed true, so `ensureRunning` refused to restart it either.
      // Mochi simply froze until the app was relaunched.
      this.reportFrameError(err);
      // Ask for the next frame before anything else. A canvas whose 2D context
      // was lost, a stale mini-bot, a view torn down mid-frame — any of these
      // can throw once, and the island must survive it rather than die.
      this.running = true;
      requestAnimationFrame(this.frame);
      return;
    }

    if (this.stepFrameLoop(nowMs)) {
      this.running = true;
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      this.watchdogUntil = 0;
      // A running AudioContext keeps its audio thread and render quantum alive
      // even with nothing playing. The loop now parks only once the island is
      // hidden, which is exactly when that state is worth entering.
      Sound.idle();
    }
  };

  /**
   * Whether another frame is needed, and the park decision itself.
   *
   * A visible island ticks at display refresh, always — the same contract as
   * `TimelineView(.animation(paused: state.mode == .hidden))` on macOS
   * (BotCanvasView.swift). It used to be a demand-driven loop that parked itself
   * whenever nothing looked busy, which was wrong: Mochi's blinks, the badge
   * dots pulse, the mini bots and the step ticker are all driven by wall-clock
   * time rather than by a tween, so none of them were ever "busy" and the island
   * froze the moment the pointer left. On Windows the 60 Hz cursor poll kept
   * `ensureRunning` called and hid the flaw; on Linux there is no global cursor
   * (`platform::CURSOR_POLL` is false), so the freeze was permanent until the
   * pointer came back onto the notch.
   *
   * Only a hidden island parks, which is what keeps the promise in CLAUDE.md of
   * no CPU at all while the island is not on screen.
   */
  private stepFrameLoop(nowMs: number): boolean {
    if (State.mode !== "hidden") {
      // Re-arm the grace window on every frame. rAF is not guaranteed while the
      // window is unmapped, and a wake-up whose frame never arrives must not be
      // able to strand the island mid-open.
      this.watchdogUntil = Math.max(this.watchdogUntil, nowMs + 600);
      return true;
    }

    // Hidden: nothing is drawn, so park as soon as the retract finishes. The
    // grace window still applies, because the collapse can begin on a hover
    // that never got a frame.
    return this.settling || this.watchdogUntil > nowMs;
  }

  /**
   * Two timers the frame loop owns, both of which were spec'd but never wired.
   *
   * - `sleeping` (SPEC §7): no task at all for 10 minutes, while the island is
   *   open and not in a temporary view. Mochi yawns first, then sleeps. Without
   *   this the state was unreachable, which also made the `yawn` emote dead.
   * - Absence (SPEC §3 rule 6): no pointer movement for the configured interval
   *   hides the island even with work running; the first movement brings it back.
   *
   * Absence needs a global cursor to tell "the user has not moved" from "the OS
   * cannot tell us where the pointer is". Where there is none, the check is
   * skipped rather than firing on every frame — on Wayland it would hide the
   * island the moment the pointer left it.
   */
  private updateLiveness(nowMs: number) {
    this.updateAbsence(nowMs);

    if (State.stateOverride != null) {
      State.asleep = false;
      return;                                  // dizzy / confused owns the bot
    }

    const idle = !State.hasActiveWork && State.tasks.length === 0;
    if (!idle) {
      this.idleSince = 0;
      this.sleepYawnAt = 0;
      if (State.asleep) {
        State.asleep = false;
        State.notify();
      }
      return;
    }

    if (this.idleSince === 0) this.idleSince = nowMs;

    // Safe to nod off only when the island is *resting*: compact, or expanded
    // on a view that is not a moment. Upload, settings, chat and the rest are
    // all "the user is here doing something", so falling asleep in them would
    // look like a bug rather than a joke.
    const resting = State.mode === "compact" ||
      (State.mode === "expanded" && !TEMPORARY_VIEWS.has(State.view));

    if (State.asleep) {
      // Wake on anything that looks like the user coming back.
      if (!resting) {
        State.asleep = false;
        State.notify();
      }
    } else if (resting && nowMs - this.idleSince >= SLEEP_AFTER_MS) {
      if (this.sleepYawnAt === 0) {
        this.sleepYawnAt = nowMs;
        this.engine.triggerEmote("yawn");
        Sound.play("yawn");
      } else if (nowMs - this.sleepYawnAt >= 1200) {
        this.sleepYawnAt = 0;
        State.asleep = true;
        // Nothing observes `asleep`, so the DOM sync (which is what pushes a
        // state into the engine) would not run. Mark it dirty by hand.
        State.notify();
      }
    }
  }

  /** SPEC §3 rule 6 — hide the island when the user has gone away. */
  private updateAbsence(nowMs: number) {
    if (!this.hasGlobalCursor || State.paused) return;
    const limit = State.settings.absenceInterval * 1000;
    if (limit <= 0) return;

    const away = nowMs - State.lastActivity;
    if (away < limit) {
      // Back within reach: if absence had folded the island, bring it back.
      if (this.awayHidden) {
        this.awayHidden = false;
        this.idleSince = 0;
        if (State.tasks.length > 0) this.fsm.reveal();
      }
      return;
    }

    if (this.awayHidden || State.mode === "hidden") return;
    // An alert waiting for an answer outranks absence (SPEC §3 rule 7): the
    // agent is blocked on the user, so folding would be a lost request.
    if (State.pendingApproval) return;
    this.awayHidden = true;
    this.fsm.forceHidden();
  }

  /** Geometry springs still moving. */
  private get settling(): boolean {
    return this.width.animating || this.height.animating || this.radius.animating;
  }

  /**
   * One frame's work. Split out of `frame` so the try/catch around it cannot
   * accidentally swallow the re-request that keeps the loop alive.
   */
  private stepFrame(nowMs: number) {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.syncBusy();
    this.updateCountdown(nowMs);
    // Absence runs last on purpose. `syncBusy` expands the island whenever work
    // starts, so running absence before it meant a hidden-by-absence island was
    // re-expanded on the very same frame and the rule never took effect.
    this.updateLiveness(nowMs);
  }

  /**
   * An agent starting or going idle is what decides expand vs. fold.
   * Compared against a cached value so a 60 Hz frame does not call it 60×/s.
   */
  private syncBusy() {
    const busy = State.hasActiveWork;
    if (busy === this.lastBusy) return;
    this.lastBusy = busy;
    // The countdown bar starts when work stops, not from whenever the user last
    // happened to move the mouse.
    if (!busy) State.lastActivity = performance.now();
    this.fsm.busyStateChanged();
    this.armCollapseCountdown();
  }

  /** One line in the log, at most a few times, so a per-frame throw cannot flood it. */
  private reportFrameError(err: unknown) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (this.frameErrors++ < 5) {
      console.error("[coucou] island frame failed", err);
      void Bridge.log(`island frame failed — ${message}`);
    }
    // Whatever went wrong, keep ticking for a while: if it was transient the
    // island heals on its own, and if it was not we still stop rather than
    // spinning at 60 Hz forever.
    this.watchdogUntil = performance.now() + 2000;
  }

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      const d = p.diameter;
      // A slap flashes the halo violet for 900 ms (SPEC §7, and the prototype's
      // `--g:#A855F7 --go:.7`). The glow is otherwise driven by the bot state, so
      // the override has to be a timed value read here rather than a second
      // element that would need its own positioning.
      const annoyed = this.annoyedUntil > performance.now();
      const color = annoyed ? ANNOYED_GLOW : botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(annoyed ? ANNOYED_GLOW_OPACITY : botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    this.engine.bodyColor = focus?.isIntegration ? hexToRGB(focus.color) : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    // No bar while an alert is pinned or work is running: the FSM holds the
    // island open in both cases, so a draining bar would be a lie.
    if (State.mode !== "expanded" || State.isPinned || State.hasActiveWork
        || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt";
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    // Compact mini grid
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    // `asleep` is not a State field anything subscribes to, so a bot that falls
    // asleep or wakes up would never be pushed into the engine: `syncDom` only
    // runs when `dirty`, and nothing marks it here. Compare against what the
    // engine already shows and re-assert on a real change.
    const want = State.effectiveState;
    if (this.engine.state !== want) this.engine.setState(want);
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    // Re-arm so a delay shortened mid-countdown takes effect at once instead of
    // after the previous, longer wait.
    this.armCollapseCountdown();
    // A shortened absence window must be able to fire immediately, and a
    // lengthened one must stop hiding an island that is already folded — the
    // in-flight check keys off `lastActivity`, so just clearing the latch is
    // enough for the next frame to re-decide.
    if (State.lastActivity < performance.now() - State.settings.absenceInterval * 1000) {
      this.awayHidden = false;
    }
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
