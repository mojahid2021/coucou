// Overview task ticker — port of TickerView (V2) from IslandViewContent.swift.
//
// Three rows: completed (A), current → completed (B), incoming (C). Every row
// position is recomputed from a single clock in `tick()`, driven by the island's
// frame loop — no CSS transitions and no timers. Chaining CSS transitions with a
// reset timer let two rows land on the same line when steps arrived in bursts,
// and any step that arrived mid-animation was dropped outright. Steps are now
// queued instead, so a burst scrolls past rather than vanishing.
//
// Positions are indices into `steps`, which is uncapped: the 20-entry ring buffer
// it replaced pinned the index at 20 and the ticker froze solid for the rest of
// a long session.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { cubicBezier, clamp, lerp } from "../core/anim";
import { stepsSince, type AgentTask } from "../core/state";

const ROW_H = 22;
/** One step transition, milliseconds. */
const DURATION = 380;
/** Beyond this many queued steps we stop trying to show them all. */
const MAX_QUEUE = 4;
const COMPLETED_SCALE = 11.5 / 13; // 0.885 — the completed font size
const EASE = cubicBezier(0.4, 0, 0.2, 1);

interface Row {
  el: HTMLElement;
  chevron: SVGElement;
  check: SVGElement;
  shimmer: HTMLElement;
  dim: HTMLElement;
  text: string;
}

function makeRow(): Row {
  const chevron = svg(ICONS.chevronRight, 9, { stroke: 2.4 });
  const check = svg(ICONS.check, 8, { stroke: 2.2 });
  check.style.color = "#454850"; // the completed tick is dimmer than the chevron
  check.style.position = "absolute";
  chevron.style.position = "absolute";
  const shimmer = h("span", { class: "tick-text shimmer" });
  const dim = h("span", {
    class: "tick-text",
    style: "position:absolute;left:0;right:0;color:#6b7079",
  });
  const el = h(
    "div",
    { class: "ticker-row" },
    h("span", { class: "tick-icon", style: "position:relative" }, chevron, check),
    h("span", { style: "position:relative;flex:1 1 auto;min-width:0" }, shimmer, dim),
  );
  return { el, chevron, check, shimmer, dim, text: "" };
}

function setText(row: Row, text: string) {
  if (row.text === text) return;
  row.text = text;
  row.shimmer.textContent = text;
  row.dim.textContent = text;
}

/**
 * Places a row. `phase` 0 = current (shimmering, full size), 1 = completed
 * (dim, shifted up-left and scaled down) — same crossfades as the Swift view.
 */
function place(row: Row, y: number, phase: number, opacity: number) {
  const scale = 1 - phase * (1 - COMPLETED_SCALE);
  row.el.style.transform = `translate(${-phase * 10}px, ${y}px) scale(${scale})`;
  row.el.style.opacity = String(opacity);
  row.chevron.style.opacity = String(clamp(1 - phase * 2, 0, 1));
  row.check.style.opacity = String(clamp(phase * 2 - 1, 0, 1));
  row.shimmer.style.opacity = String(clamp(1 - phase * 1.6, 0, 1));
  row.dim.style.opacity = String(clamp(phase * 2 - 0.4, 0, 1));
}

export class Ticker {
  readonly el: HTMLElement;
  private a = makeRow(); // completed
  private b = makeRow(); // current
  private c = makeRow(); // incoming
  private queue: string[] = [];
  private startMs: number | null = null;

  constructor() {
    this.el = h("div", { class: "ticker" }, this.a.el, this.b.el, this.c.el);
    this.rest();
  }

  /** The state between transitions: completed on top, current below. */
  private rest() {
    place(this.a, 0, 1, 1);
    place(this.b, ROW_H, 0, 1);
    place(this.c, ROW_H * 2, 0, 0);
  }

  /**
   * Newest step index it has been shown.
   *
   * This used to be compared against `steps.length`, which only worked while the
   * history was capped — at the cap both stopped moving and the queue loop went
   * empty, so the ticker silently stopped for the rest of the session. The
   * history is uncapped now, so an index is a real position.
   */
  private displayIndex = -1;

  /** Newest step index shown. Exposed for the test suite. */
  get shownStep(): number {
    return this.displayIndex;
  }

  /** Labels still waiting to scroll in. Exposed for the test suite. */
  get pending(): readonly string[] {
    return this.queue;
  }

  /** Label currently on the "current" row. Exposed for the test suite. */
  get currentText(): string {
    return this.b.text;
  }

  get animating(): boolean {
    return this.startMs != null || this.queue.length > 0;
  }

  /** Places the two resting rows at `idx` without animating. */
  private seed(steps: string[], idx: number) {
    this.displayIndex = idx;
    setText(this.a, idx > 0 ? steps[idx - 1] : "…");
    setText(this.b, steps[Math.max(idx, 0)] ?? "…");
    this.rest();
  }

  sync(task: AgentTask | null) {
    const steps = task && task.steps.length > 0 ? task.steps : ["…"];
    const idx = task ? task.stepIndex : -1;

    // First render: drop straight into place, no animation.
    if (this.displayIndex < 0) {
      this.seed(steps, idx);
      return;
    }

    // The session restarted (steps were cleared): re-seed rather than scroll
    // through a history that no longer exists.
    if (idx < this.displayIndex) {
      this.queue = [];
      this.startMs = null;
      this.seed(steps, idx);
      return;
    }

    if (task === null || idx === this.displayIndex) return;

    // A burst scrolls past rather than trying to replay all of it: `stepsSince`
    // keeps the newest MAX_QUEUE of them.
    this.queue.push(...stepsSince(task, this.displayIndex, MAX_QUEUE));
    this.displayIndex = idx;
  }

  /** Called every frame by the island while the overview is on screen. */
  tick(nowMs: number) {
    if (this.startMs == null) {
      if (this.queue.length === 0) return;
      setText(this.c, this.queue[0]);
      place(this.c, ROW_H * 2, 0, 0);
      this.startMs = nowMs;
    }

    const p = clamp((nowMs - this.startMs) / DURATION, 0, 1);
    const e = EASE(p);

    // A leaves upwards and fades a little faster than it moves, as on macOS.
    place(this.a, lerp(0, -ROW_H, e), 1, clamp(1 - p * 1.35, 0, 1));
    place(this.b, lerp(ROW_H, 0, e), e, 1);
    place(this.c, lerp(ROW_H * 2, ROW_H, e), 0, e);

    if (p < 1) return;

    // Commit: the current row becomes the completed one, the incoming row the
    // current one. Texts move, elements stay put — no reordering, no overlap.
    setText(this.a, this.b.text);
    setText(this.b, this.c.text);
    this.queue.shift();
    this.startMs = null;
    this.rest();
  }
}
