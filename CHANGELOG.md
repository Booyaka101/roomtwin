# Changelog

## 0.1.0

First release.

- Renders a Gaussian splat of one room (`.spz`, `.ply`, `.splat`, `.ksplat`, `.sog`, `.rad`) with Spark 2.2.0, with orbit, pan and zoom by mouse or touch.
- Pins for any entity, projected from their place in the room. Tap toggles lights, switches, covers, fans and input_booleans; long-press opens more-info; sensors show their live state and unit; missing entities show as a grey pin.
- Light bindings darken or tint a soft sphere of the room to follow each light's state, brightness and colour.
- Optional ceiling cut to look into the room from above.
- Edit mode for admins: tap the room to place lights and pins, tune them with sliders, set the floor from three taps, save the current view as the default, and copy the result as YAML.
- Clear messages for a missing file, an unreachable server, an oversized `.ply`, no WebGL2 and a lost graphics context.
- Cards stop rendering while off-screen or on a hidden tab.
- `tools/capture/capture.ps1` turns a video or photos into a splat with ffmpeg, COLMAP and Brush, and `tools/capture/ply-to-spz.mjs` converts `.ply` to `.spz`.
