import { html, nothing, render, svg } from "lit";
import { domainOf, type HassEntity, type HomeAssistant } from "../src/hass";
import { SimHome, formatState, type StateOverrides } from "./home";
import { defaultIcon } from "./icons";

interface Binding {
  entity: string;
  icon?: string;
}

interface DemoFile {
  config: { lights?: Binding[]; pins?: Binding[] } & Record<string, unknown>;
  states: StateOverrides;
}

interface RoomTwinCardElement extends HTMLElement {
  setConfig(config: unknown): void;
  hass: HomeAssistant;
}

let icons: Record<string, string> = {};

function iconSvg(name: string) {
  return svg`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${icons[name] ?? icons["mdi:bookmark"]}></path></svg>`;
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
        ${iconSvg(this._icon ?? defaultIcon(this._stateObj))}`,
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
    if (stateObj.state === "opening" || stateObj.state === "closing") {
      return html`<button @click=${() => call("cover", "stop_cover")}>Stop</button>`;
    }
    const open = stateObj.state === "open";
    return html`<button @click=${() => call("cover", open ? "close_cover" : "open_cover")}>${open ? "Close" : "Open"}</button>`;
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
  if (domain === "scene" || domain === "script") return html`<button @click=${() => call(domain, "turn_on")}>Run</button>`;
  if (domain === "button" || domain === "input_button") return html`<button @click=${() => call(domain, "press")}>Press</button>`;
  return nothing;
}

const ACTIVE = new Set(["on", "open", "opening", "closing", "unlocked", "playing"]);

function row(home: SimHome, stateObj: HassEntity, icon: string) {
  return html`<li>
    <span class="icon ${ACTIVE.has(stateObj.state) ? "active" : ""}">${iconSvg(icon)}</span>
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
  toastTimer = setTimeout(() => el.classList.remove("shown"), 4000);
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

function start({ config, states }: DemoFile, slot: HTMLElement): void {
  const card = document.createElement("roomtwin-card") as RoomTwinCardElement;
  const panel = document.getElementById("home-list")!;
  const dialog = document.getElementById("more-info") as HTMLDialogElement;
  let moreInfo = "";

  const bindings = [...(config.lights ?? []), ...(config.pins ?? [])];
  const iconOf = (stateObj: HassEntity) => bindings.find((b) => b.entity === stateObj.entity_id)?.icon ?? defaultIcon(stateObj);
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
          <span class="icon">${iconSvg(iconOf(stateObj))}</span>
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
    const { action: kind, entity = pin.entity } = pin[`${action}_action`] as { action: string; entity?: string };
    if (kind === "more-info") openMoreInfo(entity);
    else if (kind === "toggle") home.callService(domainOf(entity), "toggle", { entity_id: entity }).catch((err: Error) => toast(err.message));
    else if (kind !== "none") toast(`${kind} works in Home Assistant, not in this demo`);
  });
  card.addEventListener("hass-notification", (e) => toast((e as CustomEvent<{ message: string }>).detail.message));
  dialog.addEventListener("close", () => (moreInfo = ""));
  // A click on the dimmed page around the dialog lands on the dialog element itself, outside its box.
  dialog.addEventListener("click", (e) => {
    const box = dialog.getBoundingClientRect();
    const outside = e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
    if (e.target === dialog && outside) dialog.close();
  });
  slot.replaceChildren(card);
  draw();
  setInterval(() => home.drift(), 5000);
}

main();
