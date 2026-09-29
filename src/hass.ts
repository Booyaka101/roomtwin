// The slice of Home Assistant's frontend types this card touches.

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown> & {
    friendly_name?: string;
    unit_of_measurement?: string;
    brightness?: number | null;
    rgb_color?: [number, number, number] | null;
  };
  last_changed: string;
  last_updated: string;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  user?: { is_admin: boolean };
  locale?: unknown;
  panels?: Record<string, { config?: { mode?: string } | null }>;
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
    notifyOnError?: boolean,
  ): Promise<unknown>;
  callWS?<T>(message: Record<string, unknown>): Promise<T>;
  formatEntityState?(stateObj: HassEntity): string;
  formatEntityAttributeValue?(stateObj: HassEntity, attribute: string): string;
}

export function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf("."));
}
