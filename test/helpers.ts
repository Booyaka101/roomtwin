import type { HassEntity } from "../src/hass";

export function entity(entity_id: string, state: string, attributes: HassEntity["attributes"] = {}): HassEntity {
  return { entity_id, state, attributes, last_changed: "", last_updated: "" };
}
