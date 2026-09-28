# Changelog

## 0.1.0

First release.

- Renders a Gaussian splat of one room (`.spz`, `.ply`, `.splat`, `.ksplat`, `.sog`, `.rad`) with Spark 2.2.0, with orbit, pan and zoom by mouse or touch. Scrolling and vertical swipes over the card scroll the dashboard; Ctrl+scroll or a pinch zooms.
- Pins for any entity, projected from their place in the room. Tap toggles lights, switches, covers, fans and input_booleans, runs scenes and scripts, and presses buttons. Garage, gate and door covers open more-info instead of moving. Long-press opens more-info; sensors show their live state and unit; an open door or window, smoke or a leak turns its pin red; missing entities show as a grey pin.
- Pins work from the keyboard: Enter or Space taps, Shift+Enter or the menu key opens more-info, and screen readers hear the name and state.
- Optional `name` and `icon` on every light and pin, editable in edit mode.
- Light bindings darken or tint a soft sphere of the room to follow each light's state, brightness and colour.
- Optional ceiling cut to look into the room from above.
- `tap_action` and `hold_action` on any light or pin, with the same actions as Home Assistant's built-in cards.
- Edit mode for admins: tap the room to place lights and pins, tune them with sliders, set the floor from three taps, save the current view as the default, undo step by step, and save straight into the dashboard. On a YAML-mode dashboard, where the card can't save, it copies the result as YAML instead.
- A visual editor in the dashboard's card dialog for the splat file, aspect ratio (with common presets), detail and ceiling cut.
- Clear messages for a missing file, an unreachable server, an oversized `.ply`, no WebGL2 and a lost graphics context. A lost context reloads the room by itself once a minute at most. Unknown options are rejected by name, so typos don't go unnoticed.
- Cards load their room when first scrolled into view, and stop rendering while off-screen or on a hidden tab.
- A live demo (`npm run demo`) that runs the card on a real room with a simulated home, ready to publish on GitHub Pages.
- `tools/capture/capture.ps1` turns a video or photos into a splat with ffmpeg, COLMAP and Brush, and `tools/capture/ply-to-spz.mjs` converts `.ply` to `.spz`.
