// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  /** The pill the card belongs to. Copilot has its own, so answering the card
   *  must reset that pill and not always Claude Code's. */
  pillId?: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  // GitHub Copilot — CLI, the VS Code extension and the Local harness. Its own
  // pill so a Copilot session is visible next to a Claude Code one rather than
  // hidden inside it. Colour is Copilot's own, and is unused by every other pill.
  task("agent_copilot", "Copilot", "#8E7BEE", "agent"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** Workspace pills that are always shown and cannot be switched off: the agent
 *  itself is either wired to Coucou (Claude Code) or is one the user installed
 *  hooks for (Copilot). Everything else is opt-in, capped at MAX_ACTIVE. */
export const ALWAYS_ON_PILL_IDS = ["integration_claude", "agent_copilot"];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Copilot CLI / VS Code hooks, written to ~/.copilot/hooks/coucou.json. */
  copilotHooksInstalled?: boolean;
  /** Claude model used by the chat. */
  model: string;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  copilotHooksInstalled: false,
  model: "claude-opus-5",
};

/** Auto-close delays offered in the island settings card, in seconds.
 *  Mirrors `IslandConst.autoCloseChoices` on macOS. */
export const AUTO_CLOSE_CHOICES = [3, 5, 10, 15, 30];
export const AUTO_CLOSE_MIN = 3;
export const AUTO_CLOSE_MAX = 300;

export function clampAutoClose(v: unknown, fallback = 15): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(AUTO_CLOSE_MIN, Math.min(AUTO_CLOSE_MAX, n));
}

/** True while this agent is actually doing something. Mirrors `BotState.isBusy`. */
export function isBusyState(s: BotStateName): boolean {
  switch (s) {
    case "working":
    case "thinking":
    case "searching":
    case "approval":
    case "question":
    case "error":
    case "ratelimit":
      return true;
    default:
      return false;
  }
}

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** True while the island has been showing an idle Mochi for 10 minutes. */
  asleep = false;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    if (this.stateOverride) return this.stateOverride;
    // `sleeping` belongs to the island, not to any task: it means nobody has
    // been around for a long time. It has to come through here, because
    // `syncDom` re-asserts `setState(State.effectiveState)` on every dirty frame
    // and would otherwise pull the bot straight back out of pyjamas.
    if (this.asleep) return "sleeping";
    return this.focusTask?.state ?? "idle";
  }

  /** True while at least one agent is doing something. Drives auto-expand:
   *  the island opens and stays open while work is in progress, and folds
   *  once everything goes idle. Mirrors `AppState.hasActiveWork`. */
  get hasActiveWork(): boolean {
    return this.tasks.some((t) => isBusyState(t.state));
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — workspace pills always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        ALWAYS_ON_PILL_IDS.includes(proto.id) || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude first, then agent_* pills (visible in slice(0,4)),
    // then other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const isAgentA = a.id.startsWith("agent_");
      const isAgentB = b.id.startsWith("agent_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (ALWAYS_ON_PILL_IDS.includes(id)) return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
