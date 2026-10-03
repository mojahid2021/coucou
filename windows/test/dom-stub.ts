// Headless DOM + canvas stub for the island tests.
//
// The island is a plain browser app, so exercising its frame loop needs a
// document and a 2D context. This is the smallest thing that satisfies the
// code paths the island actually takes: build the views, drive the geometry
// springs, draw Mochi. Nothing here asserts anything — it only has to not throw,
// so a real failure in the island is a real failure and not a shim artefact.
//
// Two escape hatches exist for the tests themselves:
//   * `ctx.__failNext` / `ctx.failEvery` force `drawBot` to throw, to prove the
//     loop survives it (see test/run.mjs).
//   * `clock` is a manual `performance.now()` so frame timestamps are exact.

let clock = 0;
/** Advances the fake clock. Returns the new time. */
export const advanceClock = (ms: number) => (clock += ms);
export const setClock = (ms: number) => (clock += ms - clock);
/** The current fake time — what `performance.now()` reports. */
export const clockNow = () => clock;

/**
 * Advances the fake clock by `ms` without running a frame.
 *
 * Needed because a wall-clock deadline (sleep after 10 min, absence after 3)
 * cannot be reached by pumping 60 Hz frames 40 000 times. The frame loop reads
 * `performance.now()`, so moving this clock is what makes those deadlines elapse.
 */
export const tickClock = (ms: number) => (clock += ms);

// ── Canvas ───────────────────────────────────────────────────────────────────

/** Every 2D method the island calls. Path-building ones record nothing. */
const CTX_METHODS = [
  "save", "restore", "scale", "rotate", "translate", "setTransform",
  "transform", "resetTransform", "beginPath", "closePath", "moveTo", "lineTo",
  "arc", "arcTo", "ellipse", "rect", "roundRect", "quadraticCurveTo",
  "bezierCurveTo", "clip", "fill", "stroke", "fillRect", "strokeRect",
  "clearRect", "fillText", "strokeText", "setLineDash", "drawImage",
  "putImageData", "getImageData", "measureText",
] as const;

const makeGradient = () => ({ addColorStop() {} });

function makeContext2D() {
  const ctx: any = {
    canvas: null as unknown,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    shadowBlur: 0,
    shadowColor: "",
    // Test hooks: force the next draw to throw.
    __failEvery: 0,
    __fails: 0,
  };
  for (const m of CTX_METHODS) ctx[m] = () => {};
  ctx.createLinearGradient = makeGradient;
  ctx.createRadialGradient = makeGradient;
  ctx.createPattern = () => null;
  ctx.measureText = (t: string) => ({ width: (t?.length ?? 0) * 6 });

  // Consumed before each real draw: the tests use it to inject a throw.
  ctx.__guard = () => {
    if (ctx.__failEvery > 0 && ++ctx.__fails % ctx.__failEvery === 0) {
      throw new Error("injected canvas failure");
    }
  };
  return ctx;
}

class Path2DStub {
  constructor(_path?: string | Path2DStub) {}
  addPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  arc() {}
  arcTo() {}
  ellipse() {}
  rect() {}
  roundRect() {}
}

// ── Elements ─────────────────────────────────────────────────────────────────

const listenersOf = (el: FakeElement) => {
  const map = new Map<string, Set<Function>>();
  return {
    addEventListener(type: string, fn: Function) {
      const s = map.get(type) ?? new Set();
      s.add(fn);
      map.set(type, s);
      el.__listeners = map;
    },
    removeEventListener(type: string, fn: Function) {
      map.get(type)?.delete(fn);
    },
    dispatch(type: string, event: any = {}) {
      for (const fn of [...(map.get(type) ?? [])]) fn({ type, ...event });
    },
  };
};

class FakeElement {
  tagName: string;
  style: any;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attrs: Record<string, string> = {};
  textContent = "";
  innerHTML = "";
  className = "";
  value = "";
  checked = false;
  disabled = false;
  __listeners?: Map<string, Set<Function>>;
  private __ctx: any = null;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    // A plain object: the island assigns to it directly (`style.width = …`)
    // and also uses `setProperty` (`--wash`).
    this.style = new Proxy({ setProperty: () => {} }, {
      set: (t, k, v) => ((t as any)[k] = String(v), true),
      get: (t, k) => (t as any)[k] ?? "",
    });
  }

  get classList() {
    const self = this;
    const has = (c: string) => self.className.split(/\s+/).includes(c);
    return {
      add: (...cs: string[]) => {
        for (const c of cs) if (!has(c)) self.className = `${self.className} ${c}`.trim();
      },
      remove: (...cs: string[]) => {
        self.className = self.className.split(/\s+/).filter((c) => c && !cs.includes(c)).join(" ");
      },
      toggle: (c: string, on?: boolean) => {
        const want = on === undefined ? !has(c) : on;
        if (want) this.classList.add(c);
        else this.classList.remove(c);
        return want;
      },
      contains: has,
    };
  }

  get isConnected(): boolean {
    let n: FakeElement | null = this;
    while (n?.parent) n = n.parent;
    // An element whose root is the document is connected.
    return n !== null && (n as any).__isDocument === true;
  }

  get firstChild() { return this.children[0] ?? null; }

  get clientWidth() { return 720; }
  get clientHeight() { return 320; }
  get offsetWidth() { return 720; }
  get offsetHeight() { return 320; }
  private __scrollTop = 0;
  private __scrollLeft = 0;
  get scrollHeight() { return 320; }
  // Writable: the chat view assigns `scrollTop` to follow the newest message,
  // and a getter-only stub throws where a real element would not.
  get scrollTop() { return this.__scrollTop; }
  set scrollTop(v: number) { this.__scrollTop = v; }
  get scrollLeft() { return this.__scrollLeft; }
  set scrollLeft(v: number) { this.__scrollLeft = v; }
  get scrollWidth() { return 720; }

  append(...nodes: any[]) {
    for (const n of nodes) {
      if (typeof n === "string") continue;
      if (n instanceof FakeElement) {
        n.parent = this;
        this.children.push(n);
      }
    }
  }
  appendChild(n: any) { this.append(n); return n; }
  removeChild(n: any) {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
    if ((n as any)?.parent === this) (n as any).parent = null;
    return n;
  }
  replaceChildren(...nodes: any[]) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() { this.parent?.removeChild(this); }

  setAttribute(k: string, v: any) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  hasAttribute(k: string) { return k in this.attrs; }

  querySelector(sel: string): any { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): any[] {
    const want = sel.replace(/^\./, "");
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const c of el.children) {
        if (c.className.split(/\s+/).includes(want)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  addEventListener(type: string, fn: Function) { listenersOf(this).addEventListener(type, fn); }
  removeEventListener(type: string, fn: Function) { listenersOf(this).removeEventListener(type, fn); }
  dispatchEvent(e: any) { listenersOf(this).dispatch(e.type ?? "event", e); return true; }
  /** Fires the listeners for a real DOM event type (mouseenter etc.). */
  fire(type: string, event: any = {}) { listenersOf(this).dispatch(type, event); }

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 720, bottom: 320, width: 720, height: 320 };
  }
  focus() {}
  blur() {}
  click() { this.fire("click"); }
  scrollIntoView() {}
  insertAdjacentHTML() {}
  cloneNode() { return new FakeElement(this.tagName); }

  getContext(kind: string): any {
    if (kind !== "2d") return null;
    if (!this.__ctx) {
      this.__ctx = makeContext2D();
      this.__ctx.canvas = this;
    }
    return this.__ctx;
  }

  /** Test helper: the 2D context of a canvas element. */
  get ctx2d() { return this.getContext("2d"); }
}

/** The document root is marked so `isConnected` works from any depth. */
class FakeDocument extends FakeElement {
  body: FakeElement;
  documentElement: FakeElement;
  __isDocument = true;
  constructor() {
    super("html");
    this.documentElement = this;
    this.body = new FakeElement("body");
    this.body.parent = this;
    this.children.push(this.body);
  }

  createElement(tag: string) { return new FakeElement(tag); }
  createElementNS(_ns: string, tag: string) { return new FakeElement(tag); }
  createTextNode(text: string) {
    const n = new FakeElement("#text");
    n.textContent = text;
    return n;
  }
  getElementById(_id: string) { return null; }
  querySelector(sel: string): any { return this.querySelectorAll(sel)[0] ?? null; }
}

// ── Install ──────────────────────────────────────────────────────────────────

export interface Harness {
  document: FakeDocument;
  window: any;
  /** A fresh `<div>` attached to the document. */
  root(): FakeElement;
  /** How many frames the island has asked for since boot. */
  framesRequested: number;
  /** When false, rAF callbacks only run when `stepRaf` is called. */
  flushRaf: boolean;
  /** Runs one pending rAF callback. Returns whether one ran. */
  stepRaf(): boolean;  /**
   * Drops every pending rAF callback and zeroes the frame counter.
   *
   * The pending queue is global, so an island from an earlier test keeps its own
   * callback sitting in it. Pumping frames then advances loops that are not
   * under test and every frame count is wrong. Call this between islands.
   */
  resetRaf(): void;}

export function installDom(): Harness {
  const doc = new FakeDocument();

  const g: any = globalThis;
  g.document = doc;
  g.Path2D = Path2DStub;
  g.performance = { now: () => clock };
  g.devicePixelRatio = 2;

  const h: Harness = {
    document: doc,
    root: () => doc.body.appendChild(new FakeElement("div")),
    framesRequested: 0,
    flushRaf: true,
  };

  let rafId = 1;
  const pending = new Map<number, FrameRequestCallback>();

  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = rafId++;
    h.framesRequested++;
    pending.set(id, cb);
    // Drive frames from a timer so the loop advances in real time. Tests that
    // want determinism set `flushRaf = false` and pump manually.
    if (h.flushRaf) {
      const t = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clock += 16;
        cb(clock);
      }, 1);
      if (typeof t === "object" && t && "unref" in t) (t as any).unref();
    }
    return id;
  };
  g.cancelAnimationFrame = (id: number) => pending.delete(id);

  /** Runs one pending rAF callback, if any. Returns whether one ran. */
  h.stepRaf = () => {
    const first = pending.entries().next();
    if (first.done) return false;
    const [id, cb] = first.value;
    pending.delete(id);
    clock += 16;
    cb(clock);
    return true;
  };

  h.resetRaf = () => {
    pending.clear();
    h.framesRequested = 0;
  };

  // `window` doubles as an event target: the island registers keydown/mousemove
  // on it (wireInput, followPageCursor), so it needs the listener API too.
  g.window = {
    setTimeout: setTimeout.bind(globalThis),
    clearTimeout: clearTimeout.bind(globalThis),
    setInterval: setInterval.bind(globalThis),
    clearInterval: clearInterval.bind(globalThis),
    devicePixelRatio: 2,
    AudioContext: undefined, // no audio in tests
    fetch: async () => ({ ok: false, status: 404 }),
    addEventListener: (t: string, fn: Function) => g.addEventListener?.(t, fn),
    removeEventListener: (t: string, fn: Function) => g.removeEventListener?.(t, fn),
    dispatchEvent: (e: any) => g.dispatchEvent?.(e),
  };
  // The island calls `window.addEventListener`; route it to a real recorder so
  // `island.onCursor()` can be driven without a real browser.
  const winEvents = new Map<string, Set<Function>>();
  g.window.addEventListener = (t: string, fn: Function) => {
    const s = winEvents.get(t) ?? new Set();
    s.add(fn);
    winEvents.set(t, s);
  };
  g.window.removeEventListener = (t: string, fn: Function) => winEvents.get(t)?.delete(fn);
  h.resetWindowEvents = () => {
    winEvents.clear();
  };
  /** Fires a window-level event, e.g. "mousemove". */
  g.window.fire = (t: string, event: any = {}) => {
    // Real DOM events carry these; island code calls preventDefault on keys.
    const ev = { type: t, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of [...(winEvents.get(t) ?? [])]) fn(ev);
  };

  g.setTimeout = g.window.setTimeout;
  g.clearTimeout = g.window.clearTimeout;

  g.fetch = g.window.fetch;
  g.HTMLElement = FakeElement;
  g.Element = FakeElement;
  g.Node = FakeElement;

  return h;
}

export { FakeElement, FakeDocument };