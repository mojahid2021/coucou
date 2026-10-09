// Settings window — the place where anything that writes to disk is confirmed.
// Every harness Coucou can hook (Claude Code, GitHub Copilot) has its own
// section here, built by one shared factory so the confirm-before-writing
// behaviour cannot drift between them.

import "./settings.css";
import { Bridge, onEvent, type HookStatus, type HookTarget } from "../core/bridge";
import {
  AUTO_CLOSE_MAX, AUTO_CLOSE_MIN, DEFAULT_SETTINGS, clampAutoClose,
  normalizeChatProvider, type ChatProviderId, type Settings,
} from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Hook sections (Claude Code, GitHub Copilot) ──────────────────────────────

interface HookSectionOpts {
  target: HookTarget;
  title: string;
  /** Shown when the hooks are not installed yet. */
  intro: string;
  /** Shown when they are. */
  installed: string;
  /** Path label for the file Coucou edits. */
  pathLabel: string;
  /** Noun for the thing being restarted to pick the hooks up. */
  sessionName: string;
}

/**
 * The install/uninstall flow, shared by every harness Coucou can hook.
 *
 * It was written out once for Claude Code and would have been copied verbatim
 * for Copilot; one factory means the safety behaviour — backup, diff, explicit
 * confirmation, fingerprint guard — can never drift between the two.
 */
function hooksSection(opts: HookSectionOpts, initial: HookStatus): HTMLElement {
  const status: HookStatus = { ...initial };
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const head = h("h2", {}, statusDot(status.installed), h("span", { text: opts.title }));
  const section = h("section", {}, head, body);

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus(opts.target);
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: opts.title }));
  };

  function draw() {
    body.append(
      h("div", { class: "hint", text: status.installed ? opts.installed : opts.intro }),
      h("div", { class: "row" },
        h("label", { text: opts.pathLabel }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => void showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => void showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(opts.target, install);
    } catch (err) {
      // An unreadable or invalid settings file stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? `This is exactly what will change in ${preview.settingsPath}. Your own hooks are left untouched.`
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(opts.target, install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous file saved as ${backup}. Open a new ${opts.sessionName} session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

function claudeSection(status: HookStatus): HTMLElement {
  return hooksSection({
    target: "claude",
    title: "Claude Code",
    intro: "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
    installed: "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.",
    pathLabel: "settings.json",
    sessionName: "Claude Code",
  }, status);
}

function copilotSection(status: HookStatus): HTMLElement {
  return hooksSection({
    target: "copilot",
    title: "GitHub Copilot",
    intro: "Install the hooks to watch Copilot work and answer its permission requests from the island.",
    installed: "Coucou is hooked into Copilot. One file covers the Copilot CLI, the VS Code extension and the editor's own agent — tool calls and permission requests show up in the island, and you can answer them there.",
    pathLabel: "coucou.json",
    sessionName: "Copilot",
  }, status);
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? "Key saved in the Windows Credential Manager." : "No key yet — the chat needs one." });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? "Key saved in the Windows Credential Manager."
      : "No key yet — the chat needs one.";
    field.placeholder = present ? "••••••••••••  (stored)" : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  // A model id typed here that is not a Claude model means the user pointed the
  // chat at their own endpoint and then changed their mind — or edited this by
  // mistake. Say so instead of quietly storing it as a Claude model, which is
  // what produced an "auto/best-chat" Anthropic model and the confusing
  // "API key missing" that followed.
  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  const stored = settings.model;
  if (!MODELS.some(([id]) => id === stored)) {
    model.append(h("option", {
      value: stored,
      text: `${stored}  (not a Claude model — switch the chat to “Custom endpoint” to use it)`,
    }));
  }
  model.value = stored;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void Bridge.chatSet({ model: model.value });
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    feedback,
  );
}

// ── Custom endpoint section ───────────────────────────────────────────────────

/**
 * A provider whose base URL, key and model the user supplies.
 *
 * The key field is genuinely optional — a local Ollama or LM Studio answers with
 * no auth at all — so it is not gated behind a non-empty base URL the way a
 * hosted provider's would be, and leaving it blank must not read as an error.
 */
function customEndpointSection(hasKey: boolean): HTMLElement {
  const baseUrl = h("input", {
    type: "text",
    placeholder: "https://api.openai.com/v1",
    value: settings.customBaseUrl ?? "",
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;

  const key = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••  (stored)" : "optional — leave empty for a local server",
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;

  const model = h("input", {
    type: "text",
    placeholder: "gpt-4o-mini",
    value: settings.customModel ?? "",
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const models = h("datalist", { id: "coucou-custom-models" }) as HTMLDataListElement;

  const keyDot = statusDot(hasKey);
  const feedback = h("div", {});
  const saveKey = h("button", { class: "primary", text: "Save key" });
  const clearKey = h("button", { class: "danger", text: "Remove" });
  const loadModels = h("button", { text: "Load models" });

  // Which provider answers the chat. This lives here as well as in the island's
  // model picker because it is the one setting that decides whether the endpoint
  // below is used at all — configuring a base URL without switching to Custom
  // leaves the chat on Anthropic, with nothing on screen saying so.
  const provider = h("select", { style: "flex:1 1 auto;min-width:0" }) as HTMLSelectElement;
  for (const [id, label] of [["anthropic", "Anthropic"], ["custom", "Custom endpoint"]]) {
    provider.append(h("option", { value: id, text: label }));
  }
  provider.value = normalizeChatProvider(settings.chatProvider);
  provider.addEventListener("change", () => {
    const value = provider.value as ChatProviderId;
    settings.chatProvider = value;
    void Bridge.chatSet({ provider: value });
    syncProviderNote();
  });

  const providerNote = h("div", { class: "hint" });
  function syncProviderNote() {
    const on = normalizeChatProvider(settings.chatProvider) === "custom";
    providerNote.textContent = on
      ? "The chat will use the endpoint below."
      : "The chat is using Anthropic. The endpoint below is saved but not used until you switch to “Custom endpoint” here, or pick Custom in the model menu inside the chat.";
  }

  // The base URL and model are plain settings — no secret, nothing to confirm —
  // so they save on change rather than needing a button each. Routed through
  // chatSet so this window cannot write back a stale copy of `chatProvider` and
  // silently undo a switch made in the island.
  baseUrl.addEventListener("change", () => {
    settings.customBaseUrl = baseUrl.value.trim().replace(/\/+$/, "");
    baseUrl.value = settings.customBaseUrl;
    void Bridge.chatSet({ customBaseUrl: settings.customBaseUrl });
  });
  model.addEventListener("change", () => {
    settings.customModel = model.value.trim();
    model.value = settings.customModel;
    void Bridge.chatSet({ customModel: settings.customModel });
  });

  loadModels.addEventListener("click", async () => {
    // Committed first: chatModels reads the saved settings, so a value still
    // sitting in the field would be fetched against the previous endpoint.
    settings.customBaseUrl = baseUrl.value.trim().replace(/\/+$/, "");
    settings.customModel = model.value.trim();
    baseUrl.value = settings.customBaseUrl;
    model.value = settings.customModel;
    await Bridge.chatSet({
      customBaseUrl: settings.customBaseUrl,
      customModel: settings.customModel,
    });
    clear(feedback);
    loadModels.disabled = true;
    loadModels.textContent = "Loading…";
    try {
      const found = (await Bridge.chatModels()) ?? [];
      clear(models);
      for (const m of found) {
        models.append(h("option", { value: m.id }));
      }
      feedback.append(
        found.length
          ? h("div", { class: "notice ok", text: `${found.length} models available.` })
          : h("div", {
              class: "notice warn",
              text: "That endpoint returned no models. Type the model id yourself — it is not required to be in the list.",
            }),
      );
    } catch (err) {
      feedback.append(h("div", {
        class: "notice err",
        text: `Could not load models: ${String(err).replace(/^Error:\s*/, "")}`,
      }));
    } finally {
      loadModels.disabled = false;
      loadModels.textContent = "Load models";
    }
  });

  saveKey.addEventListener("click", async () => {
    const value = key.value.trim();
    clear(feedback);
    try {
      await Bridge.secretSet("custom-api-key", value);
      key.value = "";
      const present = value.length > 0;
      key.placeholder = present ? "••••••••  (stored)" : "optional — leave empty for a local server";
      keyDot.style.background = present ? "#22c55e" : "#f4505e";
      clearKey.style.display = present ? "" : "none";
      feedback.append(h("div", {
        class: "notice ok",
        text: present ? "Saved. It never touches disk." : "Removed — this endpoint needs no key.",
      }));
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearKey.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("custom-api-key");
      keyDot.style.background = "#f4505e";
      key.placeholder = "optional — leave empty for a local server";
      clearKey.style.display = "none";
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  clearKey.style.display = hasKey ? "" : "none";
  syncProviderNote();

  return h(
    "section",
    {},
    h("h2", {}, keyDot, h("span", { text: "Chat provider" })),
    h("div", { class: "row" },
      h("label", { style: "min-width:104px", text: "Answers with" }),
      provider,
    ),
    providerNote,
    h("h2", {}, keyDot, h("span", { text: "Chat — custom endpoint" })),
    h("div", {
      class: "hint",
      text: "Any OpenAI-compatible server: OpenAI, OpenRouter, Groq, Ollama, LM Studio, vLLM. Coucou asks it nothing until you send a message — and whatever URL you set receives the whole conversation.",
    }),
    h("div", { class: "row" },
      h("label", { style: "min-width:104px", text: "Base URL" }),
      baseUrl,
    ),
    h("div", { class: "row" },
      h("label", { style: "min-width:104px", text: "API key" }),
      key, saveKey, clearKey,
    ),
    h("div", { class: "row" },
      h("label", { style: "min-width:104px", text: "Model" }),
      model, loadModels,
    ),
    models,
    feedback,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: String(AUTO_CLOSE_MIN), max: String(AUTO_CLOSE_MAX), step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = clampAutoClose(autoClose.value);
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const missingStatus: HookStatus = {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };
  // Both statuses are fetched up front so the two sections never show a stale
  // dot while the other one is still loading.
  const [claudeStatus, copilotStatus] = await Promise.all([
    Bridge.hooksStatus("claude"),
    Bridge.hooksStatus("copilot"),
  ]);
  const claude = claudeStatus ?? missingStatus;
  const copilot = copilotStatus ?? missingStatus;

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const hasCustomKey = (await Bridge.secretPresent("custom-api-key")) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(claude),
    copilotSection(copilot),
    apiSection(hasKey),
    customEndpointSection(hasCustomKey),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
