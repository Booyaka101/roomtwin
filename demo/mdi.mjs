import * as mdi from "@mdi/js";

/** The SVG path of an icon name like mdi:ceiling-light, or undefined if @mdi/js has no such icon. */
export function mdiPath(name) {
  return mdi["mdi" + name.slice(4).replace(/(^|-)([a-z0-9])/g, (_, _dash, c) => c.toUpperCase())];
}
