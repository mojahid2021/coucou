// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift, plus the provider + model capsule that sits between
// the conversation and the input bar on macOS.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ChatContext, type ChatModel } from "../core/bridge";
import { Sound } from "../core/sound";
import {
  State,
  activeChatModel,
  formatTokenCount,
  normalizeChatProvider,
  CHAT_PROVIDER_ACCENT,
  CHAT_PROVIDER_LABEL,
  type ChatMessage,
  type ChatProviderId,
} from "../core/state";
import type { ViewHost } from "./views";

let nextId = 1;

/** Anthropic, then Custom — the order ModelPickerView lists its chips in. */
const PROVIDERS: ChatProviderId[] = ["anthropic", "custom"];

/**
 * The second line under a model id, from whatever the endpoint reported.
 *
 * Returns an empty string for a classic OpenAI response, and the row then shows
 * the id alone — the point of parsing all this optionally is that the common case
 * looks exactly as it did before.
 */
function modelDetail(model: ChatModel): string {
  const parts: string[] = [];

  const context = formatTokenCount(model.contextLength ?? 0);
  if (context) parts.push(`${context} ctx`);

  // Only worth showing when it is not a rounding of the context: every entry of
  // a router family reports the same pair, and repeating it on every row is noise.
  const out = formatTokenCount(model.maxOutputTokens ?? 0);
  if (out && out !== context) parts.push(`${out} out`);

  const modalities = model.inputModalities ?? [];
  if (modalities.length > 0) parts.push(`in: ${modalities.join(" ")}`);

  const caps = model.capabilities;
  if (caps) {
    if (caps.vision) parts.push("vision");
    if (caps.toolCalling) parts.push("tools");
    if (caps.reasoning || caps.thinking) parts.push("reasoning");
  }

  return parts.join(" · ");
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

/**
 * Provider chips and the model list, as they appear in `ModelPickerView`.
 *
 * The list is fetched rather than hardcoded — an endpoint Coucou knows nothing
 * about cannot have its models predicted — and typing a model id stays available
 * whatever the fetch did, because a server exposing no `/models` route is
 * ordinary (Ollama and LM Studio both do).
 */
function modelPicker(onClose: () => void): HTMLElement {
  const chips = h("div", { class: "model-chips" });
  const list = h("div", { class: "model-list" });
  const manual = h("input", {
    class: "model-manual",
    type: "text",
    placeholder: "Model id…",
    spellcheck: "false",
    autocomplete: "off",
  }) as HTMLInputElement;

  let provider = normalizeChatProvider(State.settings.chatProvider);
  let models: ChatModel[] = [];
  let loaded = false;
  let failed = false;

  function setModel(id: string) {
    // Routed through chatSet, not saveSettings: the settings window holds its own
    // copy of every setting and would otherwise write back a stale chatProvider.
    void Bridge.chatSet(provider === "custom" ? { customModel: id } : { model: id });
    if (provider === "custom") State.settings.customModel = id;
    else State.settings.model = id;
    Sound.play("blip");
    onClose();
  }

  function refreshChips() {
    clear(chips);
    for (const id of PROVIDERS) {
      const accent = CHAT_PROVIDER_ACCENT[id];
      const on = id === provider;
      const chip = h(
        "button",
        { class: on ? "model-chip on" : "model-chip", type: "button" },
        h("i", { class: "model-chip-dot", style: `background:${accent}` }),
        h("span", { text: CHAT_PROVIDER_LABEL[id] }),
      );
      chip.addEventListener("click", () => {
        if (id === provider) return;
        provider = id;
        State.settings.chatProvider = id;
        void Bridge.chatSet({ provider: id });
        Sound.play("pop");
        // Models belong to one endpoint: drop the other provider's list rather
        // than offering ids this provider has never heard of.
        models = [];
        loaded = false;
        failed = false;
        refreshChips();
        void loadModels();
      });
      chips.append(chip);
    }
  }

  async function loadModels() {
    if (loaded || failed) return;
    list.replaceChildren(h("div", { class: "model-hint", text: "Loading models…" }));
    try {
      const fetched = await Bridge.chatModels();
      // The provider may have changed while the request was in flight.
      if (provider !== normalizeChatProvider(State.settings.chatProvider)) return;
      models = fetched ?? [];
      loaded = true;
      refreshList();
    } catch (err) {
      if (provider !== normalizeChatProvider(State.settings.chatProvider)) return;
      failed = true;
      list.replaceChildren(
        h("div", { class: "model-hint", text: "Couldn't load the model list." }),
        h("div", { class: "model-hint dim", text: String(err).replace(/^Error:\s*/, "") }),
      );
    }
  }

  function refreshList() {
    clear(list);
    const active = activeChatModel(State.settings);
    for (const model of models) {
      const on = model.id === active;
      const detail = modelDetail(model);
      const label = h("span", { class: "model-row-label", text: model.label });
      const row = h(
        "button",
        { class: on ? "model-row on" : "model-row", type: "button" },
        h("span", { class: "model-row-main" }, label,
          detail ? h("span", { class: "model-row-detail", text: detail }) : null),
        on ? svg(ICONS.check, 11) : null,
      );
      row.addEventListener("click", () => setModel(model.id));
      list.append(row);
    }
    if (!models.some((m) => m.id === active)) {
      list.append(h("div", { class: "model-hint dim", text: "Not in the list? Type the id below." }));
    }
  }

  manual.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") {
      e.preventDefault();
      const value = manual.value.trim();
      if (value) setModel(value);
    }
    e.stopPropagation(); // Escape closes the island, not this field
  });

  const panel = h(
    "div",
    { class: "model-popover" },
    chips,
    list,
    h("div", { class: "model-manual-row" }, manual),
  );
  refreshChips();
  refreshList();
  void loadModels();
  return panel;
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  // ── Provider / model capsule ───────────────────────────────────────────────
  let popover: HTMLElement | null = null;
  const popoverSlot = h("div", { class: "model-popover-slot" });
  const capsuleLabel = h("span", { class: "provider-label" });
  const capsule = h(
    "button",
    { class: "provider-capsule", type: "button", "aria-expanded": "false", title: "Provider and model" },
    h("i", { class: "provider-dot" }),
    capsuleLabel,
    svg(ICONS.chevronUpDown, 9),
  ) as HTMLButtonElement;
  const capsuleRow = h("div", { class: "provider-row" }, capsule, popoverSlot);

  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
    popoverSlot.replaceChildren();
    capsule.setAttribute("aria-expanded", "false");
    onHeightChange();
  }

  capsule.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popover) {
      closePopover();
      return;
    }
    popover = modelPicker(closePopover);
    popoverSlot.append(popover);
    capsule.setAttribute("aria-expanded", "true");
    onHeightChange();
  });

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, capsuleRow, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  // A click elsewhere on the island dismisses the popover; without this it would
  // sit on top of whatever the user opened next.
  el.addEventListener("click", (e) => {
    const target = e.target as Node;
    if (popover && target !== capsule && !popover.contains(target)) closePopover();
  });

  let sending = false;
  let renderedCount = -1;
  let lastCapsule = "";

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    const provider = normalizeChatProvider(State.settings.chatProvider);
    try {
      const reply = await Bridge.chatSend(query, context);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      // "API key missing. Open settings." is just as true of a custom endpoint,
      // so it is replaced with the place the fix actually lives.
      const reason = String(err).replace(/^Error:\s*/, "");
      State.noteMessage =
        provider === "custom" && reason.includes("API key")
          ? "Add a base URL in Settings → Chat — custom endpoint."
          : reason;
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      // The capsule names the provider and the model that will actually be
      // called, so a half-configured custom endpoint shows up before sending
      // rather than as an error afterwards.
      const provider = normalizeChatProvider(State.settings.chatProvider);
      const model =
        activeChatModel(State.settings) || (provider === "custom" ? "no model" : State.settings.model);
      const caption = `${provider}|${model}`;
      if (caption !== lastCapsule) {
        lastCapsule = caption;
        (capsule.querySelector(".provider-dot") as HTMLElement).style.background =
          CHAT_PROVIDER_ACCENT[provider];
        capsuleLabel.textContent = model;
        capsule.title = `${CHAT_PROVIDER_LABEL[provider]} — ${model}`;
      }

      input.placeholder = State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
