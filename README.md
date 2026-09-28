# RoomTwin

A Home Assistant dashboard card that shows a Gaussian splat of your actual room and puts your devices where they really are. Tap the lamp in the 3D view and the lamp turns on, and that part of the room brightens with it. Sensors float in place with their live readings.

One card shows one room. The idea is one card per Home Assistant area.

## What you need

- Home Assistant 2024.11 or newer.
- A browser with WebGL2: current Chrome, Edge, Firefox or Safari, including the Home Assistant companion apps. A mid-range Android tablet is enough.
- A splat of your room as `.spz` (best) or `.ply`. The next section covers making one.

## 1. Capture the room

### With a phone: Scaniverse (recommended)

[Scaniverse](https://scaniverse.com) is free on iOS and Android and does everything on the phone.

1. Start a new scan in splat mode. Walk slowly around the room holding the phone at chest height, then do a second lap aimed a little lower and a third aimed higher. Take in every wall and keep the lamps and devices you want to control in view for a while. Two to three minutes is plenty for a normal room.
2. Let it process on the phone.
3. Export or share the scan as **SPZ**. You get a single file.

Scaniverse scans are in real metres, so the sizes in the editor mean what they say.

### With a PC and a GPU: Brush

If you'd rather train on your own hardware, `tools/capture/capture.ps1` turns a phone video into a splat with [COLMAP](https://github.com/colmap/colmap) and [Brush](https://github.com/ArthurBrussee/brush). The steps and the shooting tips are in [tools/capture/README.md](tools/capture/README.md). The whole run took 9 minutes for 112 frames on an RTX 4090; expect longer on smaller cards.

COLMAP captures have no real-world scale, so a "metre" in the editor is whatever unit COLMAP picked. That's fine. Size things by eye with the sliders.

### Converting a .ply to .spz

A `.ply` works but is roughly ten times bigger than the same splat as `.spz`, and the card warns about any `.ply` over 150 MB. To convert, from a checkout of this repo:

```sh
npm ci
node tools/capture/ply-to-spz.mjs living.ply
```

That writes `living.spz` next to the input using Spark's own encoder.

## 2. Put the file on Home Assistant

Copy the file to `/config/www/roomtwin/`, for example with the File editor or Samba add-on. Home Assistant serves `/config/www/` at `/local/`, so `/config/www/roomtwin/living.spz` becomes `/local/roomtwin/living.spz`.

If `www` didn't exist before, restart Home Assistant once so it starts serving the folder.

## 3. Install the card

With [HACS](https://hacs.xyz):

1. HACS, then the three-dot menu, then **Custom repositories**.
2. Add `https://github.com/Booyaka101/roomtwin` with type **Dashboard**.
3. Open RoomTwin in HACS and download it. HACS registers the dashboard resource for you. Reload the browser.

Manual install: download `roomtwin-card.js` from the [latest release](https://github.com/Booyaka101/roomtwin/releases/latest), copy it to `/config/www/roomtwin-card.js`, then add `/local/roomtwin-card.js` as a **JavaScript module** under Settings, Dashboards, three-dot menu, Resources.

## 4. Add the card and place your devices

Add a card to a dashboard, pick **Manual**, and start with just the file:

```yaml
type: custom:roomtwin-card
splat: /local/roomtwin/living.spz
```

Drag to orbit, right-drag or two-finger drag to pan, scroll or pinch to zoom. The house button resets the view.

Admins see a pencil button in the corner. It opens edit mode, which works on the live room:

1. **Set floor (tap 3 points)**: tap three spots spread across the floor. The room turns upright with the floor at height 0. It refuses three points in a line.
2. **Tap the room** where a lamp or device is. Type or pick an entity, then choose **Add as light** (lights and switches) or **Add as pin** (anything).
3. For a light, set **Radius**, **Soft edge** and **Brightness when off** with the sliders while you watch the room. Flip the real light to check it.
4. Optionally turn on **Ceiling cut** so you can see into the room from above, and press **Use this view as default** once the camera is where you like it.
5. Press **Copy YAML**, open the card's code editor, replace everything with the clipboard, and save.

Nothing is saved until step 5. The editor says so while you have unsaved changes, and **Discard changes** puts everything back.

## Using the card

- **Tap** a light, switch, cover, fan or input_boolean pin to toggle it. The room region around a bound light follows its state, brightness and colour on the next frame.
- **Long-press** any pin to open the more-info dialog. Tapping a sensor or anything else that can't toggle opens more-info too.
- Sensor pins show the current state with its unit and update live.
- A pin whose entity doesn't exist shows as a grey question mark, so a renamed entity is easy to spot.
- Cards that are scrolled off-screen, or on a hidden tab, stop rendering entirely, so several rooms on one dashboard cost nothing until you look at them.

## Configuration reference

```yaml
type: custom:roomtwin-card
splat: /local/roomtwin/living.spz
up: [0.02, -0.998, 0.05]
floor: -1.42
ceiling_cut: 2.3
camera:
  position: [0.4, 1.6, 3.2]
  target: [0, 0.8, 0]
lights:
  - entity: light.floor_lamp
    anchor: [1.21, -0.35, 0.8]
    radius: 1.2
    soft_edge: 0.6
    off_dim: 0.45
pins:
  - entity: sensor.living_room_temperature
    anchor: [-0.9, -1.1, 2.05]
    name: Temperature
```

| Option | Default | Meaning |
| --- | --- | --- |
| `splat` | required | URL of the capture: `.spz`, `.ply`, `.splat`, `.ksplat`, `.sog` or `.rad`. |
| `up` | `[0, -1, 0]` | Up direction in the capture's own coordinates. Scaniverse and COLMAP files load upside down in three.js, hence the default. Set it with the floor tool rather than by hand. |
| `floor` | `0` | Height of the floor along `up`, in capture coordinates. Written by the floor tool. |
| `ceiling_cut` | off | Hides everything more than this far above the floor, so you can look down into the room. Taps go through the cut part. |
| `camera` | middle of the room | Default view, `position` and `target` in capture coordinates. Written by **Use this view as default**. |
| `aspect_ratio` | `16:9` | Card shape, as `"4:3"` or a number like `1.5`. |
| `lod` | `true` | Spark's level of detail, which keeps large captures smooth. Leave it on unless a capture renders wrongly. |
| `lod_scale` | `1` | How many splats level of detail may draw, from 0.1 to 8. Lower it for a slow tablet, raise it on a strong desktop GPU. |
| `lights[].entity` | required | A `light` or `switch` entity. |
| `lights[].anchor` | required | Centre of the lit region, in capture coordinates. Place it with the editor. |
| `lights[].radius` | `1.0` | Radius of the region the light affects. |
| `lights[].soft_edge` | `0.5` | Width of the fade at the edge of the region. |
| `lights[].off_dim` | `0.45` | How bright the region looks when the light is off, from 0 (black) to 1 (unchanged). |
| `pins[].entity` | required | Any entity. |
| `pins[].anchor` | required | Where the pin sits, in capture coordinates. |
| `pins[].name` | entity name | Label shown on hover and in the editor. |

Anchors and the camera are stored in the capture's own coordinates, so re-running the floor tool never moves your pins.

### How lights change the room

Each light multiplies the colour of the splats inside its soft sphere:

- off, unavailable or missing: `off_dim` on every channel.
- on: `f = off_dim + (1 - off_dim) × brightness / 255`, tinted by `rgb_color` scaled so its brightest channel is 1. With no `rgb_color` the tint is white.

So at the default `off_dim` of 0.45 a light at full brightness leaves its region exactly as captured, and switching it off darkens it to 45%. Capture the room with the lights on for the best result.

Spark has room for 16 light regions at first and doubles that on demand, which costs one short shader rebuild when you add the 17th. 24 lights on one card were tested and render fine. Each light adds a little per-frame work, so keep an eye on tablets if you go well beyond that.

## Troubleshooting

The card explains every failure it knows about:

- **Could not load /local/roomtwin/x.spz (HTTP 404).** The file isn't where the URL says. The message tells you the `/config/www/` path it expected.
- **Could not reach ...** Home Assistant didn't answer. Check the connection and press **Try again**.
- **... is a 329 MB .ply.** It still loads, but convert it to `.spz` for tablets.
- **RoomTwin needs WebGL2 ...** The browser or device has no WebGL2, or hardware acceleration is off.
- **The browser dropped the 3D view to free graphics memory.** Common on phones with many tabs open. Press **Try again**.
- **The room is tilted or upside down.** Use **Set floor (tap 3 points)** in edit mode.
- **Taps land in the wrong place.** Tap on solid, textured surfaces. Blurry or see-through areas of a capture have too little in them to hit.

## Development

```sh
npm ci
npm test          # Vitest unit tests
npm run typecheck
npm run build     # writes dist/roomtwin-card.js
```

The card uses Lit, three.js and [Spark](https://sparkjs.dev) 2.2.0, bundled by Rollup into one file.

To release, tag `v<version>` and attach `dist/roomtwin-card.js` to a GitHub release. HACS installs from the release asset.

## License

MIT
