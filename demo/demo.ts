import { html, nothing, render, svg } from "lit";
import { domainOf, type HassEntity, type HomeAssistant } from "../src/hass";
import { activeColor, pinState } from "../src/pins";
import { SimHome, formatState, type StateOverrides } from "./home";
import { defaultIcon } from "./icons";

interface Binding {
  entity: string;
  icon?: string;
}

interface DemoFile {
  config: { lights?: Binding[]; pins?: Binding[] } & Record<string, unknown>;
  states: StateOverrides;
  yaml: string;
}

interface ActionConfig {
  action: string;
  entity?: string;
  perform_action?: string;
  service?: string;
  data?: Record<string, unknown>;
  service_data?: Record<string, unknown>;
  target?: Record<string, unknown>;
}

interface RoomTwinCardElement extends HTMLElement {
  setConfig(config: unknown): void;
  hass: HomeAssistant;
}

let icons: Record<string, string> = {};

function iconSvg(name: string) {
  return svg`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${icons[name]}></path></svg>`;
}

/** The binding's icon when the page packed it, otherwise the one HA would pick for the entity. */
function iconFor(stateObj: HassEntity, icon: string | undefined): string {
  return icon && icons[icon] ? icon : defaultIcon(stateObj);
}

// Stand-ins for the three Home Assistant elements the card renders. Everything else is the shipped card.
class DemoStateIcon extends HTMLElement {
  private _stateObj?: HassEntity;
  private _icon?: string;
  hass?: HomeAssistant;
  set stateObj(value: HassEntity) {
    this._stateObj = value;
    this.draw();
  }
  set icon(value: string | undefined) {
    this._icon = value;
    this.draw();
  }
  private draw(): void {
    if (!this._stateObj) return;
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    render(
      html`<style>
          svg { display: block; width: var(--mdc-icon-size, 24px); height: var(--mdc-icon-size, 24px); fill: currentColor; }
        </style>
        ${iconSvg(iconFor(this._stateObj, this._icon))}`,
      root,
    );
  }
}

/** An element that is just a styled box around its children, which is all ha-card and ha-alert need to be here. */
function box(style: (host: HTMLElement) => string): CustomElementConstructor {
  return class extends HTMLElement {
    connectedCallback(): void {
      if (this.shadowRoot) return;
      this.attachShadow({ mode: "open" }).innerHTML = `<style>:host { display: block; ${style(this)} }</style><slot></slot>`;
    }
  };
}

const DemoCard = box(() => "background: var(--card-background-color); border-radius: 12px;");

const DemoAlert = box((host) => {
  const warning = host.getAttribute("alert-type") === "warning";
  const [edge, fill] = warning ? ["#ffa600", "rgba(255, 166, 0, 0.12)"] : ["var(--error-color)", "rgba(219, 68, 55, 0.15)"];
  return `padding: 10px 14px; border-radius: 8px; text-align: left; border-left: 4px solid ${edge}; background: ${fill};`;
});

function controls(home: SimHome, stateObj: HassEntity, detailed: boolean) {
  const id = stateObj.entity_id;
  const domain = domainOf(id);
  const call = (d: string, s: string, data: Record<string, unknown> = {}) =>
    home.callService(d, s, { entity_id: id, ...data }).catch((err: Error) => toast(err.message));
  const on = stateObj.state === "on";
  if (["light", "switch", "fan", "input_boolean"].includes(domain)) {
    const light = detailed && domain === "light" && on;
    return html`<button class=${on ? "on" : ""} @click=${() => call(domain, "toggle")}>${on ? "Turn off" : "Turn on"}</button>
      ${light
        ? html`<label class="slider">Brightness
              <input type="range" min="1" max="255" .value=${String(stateObj.attributes.brightness ?? 255)}
                @input=${(e: Event) => call("light", "turn_on", { brightness: Number((e.target as HTMLInputElement).value) })} />
            </label>
            <div class="swatches" role="group" aria-label="Colour">
              ${[
                ["White", null],
                ["Warm", [255, 180, 110]],
                ["Red", [255, 60, 40]],
                ["Green", [80, 255, 120]],
                ["Blue", [70, 120, 255]],
              ].map(
                ([name, rgb]) => html`<button
                  title=${name as string}
                  aria-label=${name as string}
                  aria-pressed=${String(
                    rgb
                      ? stateObj.attributes.color_mode === "hs" && String(stateObj.attributes.rgb_color) === String(rgb)
                      : stateObj.attributes.color_mode === "color_temp",
                  )}
                  style="background: rgb(${((rgb as number[] | null) ?? [255, 255, 255]).join(",")})"
                  @click=${() => call("light", "turn_on", rgb ? { rgb_color: rgb } : { color_temp_kelvin: 3000 })}
                ></button>`,
              )}
            </div>`
        : nothing}`;
  }
  if (domain === "cover") {
    // One button that changes its label, so keyboard focus stays on it while the cover moves.
    const moving = stateObj.state === "opening" || stateObj.state === "closing";
    const [service, label] = moving ? ["stop_cover", "Stop"] : stateObj.state === "open" ? ["close_cover", "Close"] : ["open_cover", "Open"];
    return html`<button @click=${() => call("cover", service)}>${label}</button>`;
  }
  if (domain === "lock") {
    const locked = stateObj.state === "locked";
    return html`<button @click=${() => call("lock", locked ? "unlock" : "lock")}>${locked ? "Unlock" : "Lock"}</button>`;
  }
  if (domain === "binary_sensor") {
    const opening = ["door", "garage_door", "window", "opening"].includes(String(stateObj.attributes.device_class));
    const label = opening ? (on ? "Close it" : "Open it") : on ? "Clear" : "Trigger";
    return html`<button @click=${() => home.set(id, on ? "off" : "on")}>${label}</button>`;
  }
  if (domain === "media_player") {
    const playing = stateObj.state === "playing";
    return html`<button class=${playing ? "on" : ""} @click=${() => call(domain, "media_play_pause")}>${playing ? "Pause" : "Play"}</button>`;
  }
  if (domain === "climate") {
    const target = Number(stateObj.attributes.temperature);
    const nudge = (step: number) => call(domain, "set_temperature", { temperature: target + step });
    return html`<span class="stepper">
      <button aria-label="Lower the target" @click=${() => nudge(-0.5)}>-</button>
      <span aria-live="polite">${target} °C</span>
      <button aria-label="Raise the target" @click=${() => nudge(0.5)}>+</button>
    </span>`;
  }
  if (domain === "scene" || domain === "script") return html`<button @click=${() => call(domain, "turn_on")}>Run</button>`;
  if (domain === "button" || domain === "input_button") return html`<button @click=${() => call(domain, "press")}>Press</button>`;
  return nothing;
}

/** The entity's icon, coloured the way the card colours its pin. */
function badge(stateObj: HassEntity, icon: string) {
  const state = pinState(stateObj);
  return html`<span class="icon ${state}" style=${state === "active" ? `--c: ${activeColor(stateObj)}` : ""}>${iconSvg(icon)}</span>`;
}

/** What Home Assistant's toggle action calls for an entity. */
function toggleService(stateObj: HassEntity): [string, string] {
  const domain = domainOf(stateObj.entity_id);
  if (domain === "lock") return [domain, stateObj.state === "locked" ? "unlock" : "lock"];
  if (domain === "cover") return [domain, stateObj.state === "closed" ? "open_cover" : "close_cover"];
  if (domain === "scene" || domain === "script") return [domain, "turn_on"];
  if (domain === "button" || domain === "input_button") return [domain, "press"];
  return [domain, "toggle"];
}

function row(home: SimHome, stateObj: HassEntity, icon: string) {
  return html`<li>
    ${badge(stateObj, icon)}
    <span class="name">${stateObj.attributes.friendly_name}<small>${formatState(stateObj)}</small></span>
    <span class="controls" role="group" aria-label=${String(stateObj.attributes.friendly_name)}>${controls(home, stateObj, false)}</span>
  </li>`;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string): void {
  const el = document.getElementById("toast")!;
  el.textContent = message;
  el.classList.add("shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("shown");
    // Emptied once it has slid away, so screen readers don't find a stale message later.
    toastTimer = setTimeout(() => (el.textContent = ""), 300);
  }, 4000);
}

async function main(): Promise<void> {
  const slot = document.getElementById("card")!;
  try {
    const [demo, iconFile] = await Promise.all(
      ["config.json", "icons.json"].map(async (file) => {
        const res = await fetch(file);
        if (!res.ok) throw new Error(`Could not load ${file} (HTTP ${res.status}).`);
        return res.json();
      }),
    );
    icons = iconFile;
    customElements.define("ha-state-icon", DemoStateIcon);
    customElements.define("ha-card", DemoCard);
    customElements.define("ha-alert", DemoAlert);
    await import(/* the real card, as HACS installs it */ new URL("roomtwin-card.js", import.meta.url).href);
    start(demo as DemoFile, slot);
  } catch (err) {
    slot.textContent = `The demo could not start: ${(err as Error).message}`;
  }
}

function start({ config, states, yaml }: DemoFile, slot: HTMLElement): void {
  const card = document.createElement("roomtwin-card") as RoomTwinCardElement;
  const panel = document.getElementById("home-list")!;
  const dialog = document.getElementById("more-info") as HTMLDialogElement;
  let moreInfo = "";

  const bindings = [...(config.lights ?? []), ...(config.pins ?? [])];
  const iconOf = (stateObj: HassEntity) => iconFor(stateObj, bindings.find((b) => b.entity === stateObj.entity_id)?.icon);
  const home = new SimHome(bindings.map((b) => b.entity), states, (hass) => {
    card.hass = hass;
    draw();
  });

  function draw(): void {
    render(Object.values(home.states).map((s) => row(home, s, iconOf(s))), panel);
    const stateObj = home.states[moreInfo];
    if (!stateObj) return;
    render(
      html`<header>
          ${badge(stateObj, iconOf(stateObj))}
          <h2 id="more-info-title">${stateObj.attributes.friendly_name}</h2>
          <button class="close" aria-label="Close" @click=${() => dialog.close()}>×</button>
        </header>
        <p class="state">${formatState(stateObj)}</p>
        <div class="controls">${controls(home, stateObj, true)}</div>
        <p class="entity">${stateObj.entity_id}</p>`,
      dialog,
    );
  }

  card.setConfig(config);
  card.hass = home.hass;
  const openMoreInfo = (entityId: string) => {
    moreInfo = entityId;
    if (!home.states[moreInfo]) return toast(`${moreInfo} is not in this demo home`);
    draw();
    if (!dialog.open) dialog.showModal();
  };
  card.addEventListener("hass-more-info", (e) => openMoreInfo((e as CustomEvent<{ entityId: string }>).detail.entityId));
  // A pin's tap_action or hold_action. Home Assistant runs every kind; the demo only has the ones that stay on this page.
  card.addEventListener("hass-action", (e) => {
    const { config: pin, action } = (e as CustomEvent<{ config: Record<string, unknown> & { entity: string }; action: string }>).detail;
    const { action: kind, entity = pin.entity, ...rest } = pin[`${action}_action`] as ActionConfig;
    const perform = rest.perform_action ?? rest.service;
    const call = (domain: string, service: string, data: Record<string, unknown>) =>
      home.callService(domain, service, data).catch((err: Error) => toast(err.message));
    if (kind === "more-info") openMoreInfo(entity);
    else if (kind === "toggle" && home.states[entity]) call(...toggleService(home.states[entity]), { entity_id: entity });
    else if (kind === "toggle") toast(`${entity} is not in this demo home`);
    else if ((kind === "perform-action" || kind === "call-service") && perform?.includes(".")) {
      const [domain, service] = perform.split(".");
      call(domain, service, { ...rest.service_data, ...rest.data, ...rest.target });
    } else if (kind !== "none") toast(`${kind} works in Home Assistant, not in this demo`);
  });
  card.addEventListener("hass-notification", (e) => toast((e as CustomEvent<{ message: string }>).detail.message));
  dialog.addEventListener("close", () => (moreInfo = ""));
  // A click on the dimmed page around the dialog lands on the dialog element itself, outside its box. Both ends
  // of the click have to be out there, or selecting text in the dialog and letting go outside would close it.
  const outside = (e: MouseEvent) => {
    const box = dialog.getBoundingClientRect();
    return e.target === dialog && (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom);
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (e) => (pressedOutside = outside(e)));
  dialog.addEventListener("click", (e) => {
    if (pressedOutside && outside(e)) dialog.close();
  });
  document.getElementById("yaml")!.textContent = yaml;
  slot.replaceChildren(card);
  draw();
  setInterval(() => {
    home.drift();
    home.stir();
  }, 5000);
}

main();
