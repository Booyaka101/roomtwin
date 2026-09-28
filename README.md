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

Files under `/local/` are served without a login. Anyone who can reach your Home Assistant and guesses the file name can download the scan of your room. If your instance is reachable from the internet and you'd rather keep the scan private, use a file name nobody will guess.

## 3. Install the card

With [HACS](https://hacs.xyz):

1. HACS, then the three-dot menu, then **Custom repositories**.
2. Add `https://github.com/Booyaka101/roomtwin` with type **Dashboard**.
3. Open RoomTwin in HACS and download it. HACS registers the dashboard resource for you. Reload the browser.

Manual install: download `roomtwin-card.js` from the [latest release](https://github.com/Booyaka101/roomtwin/releases/latest) and copy it to `/config/www/roomtwin-card.js`. Then under Settings, Dashboards, three-dot menu, Resources, add `/local/roomtwin-card.js?v=0.1.0` as a **JavaScript module**. The Resources entry only shows with Advanced mode turned on in your user profile. Change the `?v=` part whenever you replace the file, or browsers keep the old one. Any value works, the version number is just easy to remember.

If your dashboards are in YAML mode, add the resource to `configuration.yaml` instead:

```yaml
lovelace:
  resources:
    - url: /hacsfiles/roomtwin/roomtwin-card.js # installed with HACS
      type: module
    # or, installed by hand: /local/roomtwin-card.js?v=0.1.0
```

## 4. Add the card and place your devices

Add a card to a dashboard, pick **Manual**, and start with just the file:

```yaml
type: custom:roomtwin-card
splat: /local/roomtwin/living.spz
```

Drag to orbit, right-drag or two-finger drag to pan, Ctrl+scroll or pinch to zoom. The house button resets the view.

Admins see a pencil button in the corner. It opens edit mode, which works on the live room:

1. **Set floor (tap 3 points)**: tap three spots spread across the floor. The room turns upright with the floor at height 0. It refuses three points in a line.
2. **Tap the room** where a lamp or device is. Type or pick an entity, then choose **Add as light** (lights and switches) or **Add as pin** (anything).
3. For a light, set **Radius (m)**, **Soft edge (m)** and **Brightness when off** with the sliders while you watch the room. Flip the real light to check it. **Label** and **Icon** override the entity's name and icon on the pin, for lights and pins alike. New lights start with a radius and soft edge sized to the room.
   To change one later, tap its pin in the room or its chip under **In this room**. While it's selected, tapping the room moves it there, **Remove** deletes it and **Done** lets go of it.
4. Optionally turn on **Ceiling cut** so you can see into the room from above, and press **Use this view as default** once the camera is where you like it.
5. Press **Save**. The card writes its new config into the dashboard, leaving everything else on it as it was, and Home Assistant redraws the dashboard with it.

Nothing is saved until step 5. The editor says so while you have unsaved changes, and after **Close** the pencil wears a dot until you save or discard them. **Undo** steps back one change at a time (a whole slider drag counts as one, and so does typing in one field), and **Discard changes** puts everything back. Closing and reopening the editor keeps the undo history.

From the keyboard, Esc lets go of the selected light or pin (or cancels placing one), Ctrl+Z undoes, and Delete removes the selected one. Inside a text field those keys do their usual thing.

Save needs a dashboard managed from the UI. A YAML-mode dashboard only changes in its file, so there the editor has **Copy YAML** instead: paste the result over the card's entry in the dashboard's YAML file. If a save fails for another reason, the editor says why, and **Copy YAML** into the card's code editor does the same job. Save is also hidden while the dashboard itself is in edit mode, where the card is only a preview. Home Assistant redraws the dashboard whenever anyone saves it, so changes you haven't saved yet are lost if someone saves the same dashboard from another tab.

The card's visual editor in the dashboard dialog covers the plain options: the splat file, aspect ratio (pick a common one or type your own), detail and ceiling cut height. Changing them there keeps your lights, pins and camera.

## Using the card

- **Tap** a light, switch, cover, fan or input_boolean pin to toggle it. The room region around a bound light follows its state, brightness and colour on the next frame.
- Tapping a scene or script runs it, and tapping a button or input_button presses it.
- Garage doors, gates and doors (covers with those device classes) open more-info on tap instead of moving, so brushing the pin can't open the garage.
- **Long-press** any pin to open the more-info dialog. Tapping a sensor, an unavailable entity or anything else without a tap action opens more-info too.
- A pin or light with its own `tap_action`, `hold_action` or `double_tap_action` does that instead, using the same actions as Home Assistant's own cards: `more-info`, `toggle`, `navigate`, `url`, `perform-action`, `assist` or `none`, with `confirmation` if you want a prompt first. That also overrides the garage door rule above, so a `toggle` tap action on a garage door does move it. Once a pin has a double tap action, a single tap on it waits a quarter of a second to rule out a second one.
- From the keyboard, Tab to a pin, then Enter or Space taps it, and Shift+Enter or the menu key does what a long-press does. Screen readers hear the pin's name and state. Tab to the room itself and the arrow keys move around it, plus and minus zoom, and Home goes back to the saved view.
- Sensor pins show the current state with its unit and update live.
- A pin that is on, open, playing, unlocked, set to heat and so on takes your theme's colour for that state, the way Home Assistant's tiles do, and a coloured light's pin shows the light's colour.
- A pin turns red while it has something to look at: a binary sensor for an open door, window or garage door, or smoke, gas, carbon monoxide, a leak, a safety problem or tampering, and also a jammed lock, a triggered alarm or a vacuum reporting an error.
- A pin whose entity doesn't exist shows as a grey question mark, so a renamed entity is easy to spot.
- Where pins crowd together on screen, the one further back hides its label until you hover it, tab to it or select it in edit mode. Its icon stays where the device is. A pin near the right edge puts its label on the left instead, so it isn't cut off.
- Drag to look around and right-drag to pan. Scrolling over the card scrolls the dashboard as usual, so zoom by holding Ctrl (Cmd on a Mac) while you scroll, or pinch. In edit mode the scroll wheel zooms on its own.
- On a touch screen, swipe sideways to turn the view and pinch to zoom. An up or down swipe scrolls the dashboard.
- A card doesn't download its room until it first scrolls into view, and cards that are off-screen or on a hidden tab stop rendering entirely.

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
    tap_action:
      action: navigate
      navigation_path: /lovelace/climate
```

| Option | Default | Meaning |
| --- | --- | --- |
| `splat` | required | URL of the capture: `.spz`, `.ply`, `.splat`, `.ksplat`, `.sog` or `.rad`. |
| `up` | `[0, -1, 0]` | Up direction in the capture's own coordinates. Scaniverse and COLMAP files load upside down in three.js, hence the default. Set it with the floor tool rather than by hand. |
| `floor` | `0` | Height of the floor along `up`, in capture coordinates. Written by the floor tool. |
| `ceiling_cut` | off | Hides everything more than this far above the floor, so you can look down into the room. Taps go through the cut part. |
| `camera` | middle of the room | Default view, `position` and `target` in capture coordinates. Written by **Use this view as default**. |
| `aspect_ratio` | `16:9` | Card shape, as `"4:3"` or a number like `1.5`. In a YAML-mode dashboard keep the quotes, because Home Assistant reads an unquoted 16:9 there as the number 969. The card says so if that happens. |
| `lod` | `true` | Spark's level of detail, which keeps large captures smooth. Leave it on unless a capture renders wrongly. |
| `lod_scale` | `1` | How many splats level of detail may draw, from 0.1 to 8. Lower it for a slow tablet, raise it on a strong desktop GPU. |
| `lights[].entity` | required | A `light` or `switch` entity. |
| `lights[].anchor` | required | Centre of the lit region, in capture coordinates. Place it with the editor. |
| `lights[].radius` | `1.0` | Radius of the region the light affects. |
| `lights[].soft_edge` | `0.5` | Width of the fade at the edge of the region. |
| `lights[].off_dim` | `0.45` | How bright the region looks when the light is off, from 0 (black) to 1 (unchanged). |
| `lights[].name` | entity name | Label shown on hover, read by screen readers and shown in the editor. |
| `lights[].icon` | entity icon | Pin icon, like `mdi:lamp`. |
| `lights[].tap_action`, `lights[].hold_action`, `lights[].double_tap_action` | toggle, more-info, nothing | Any Home Assistant card action, as on the built-in cards. |
| `pins[].entity` | required | Any entity. |
| `pins[].anchor` | required | Where the pin sits, in capture coordinates. |
| `pins[].name` | entity name | Label shown on hover, read by screen readers and shown in the editor. |
| `pins[].icon` | entity icon | Pin icon, like `mdi:thermometer`. |
| `pins[].tap_action`, `pins[].hold_action`, `pins[].double_tap_action` | depends on the entity, more-info, nothing | Any Home Assistant card action, as on the built-in cards. |

The card rejects options it doesn't know, so a typo like `raduis` is an error instead of being silently ignored. Home Assistant shows a bare "Configuration error" on the dashboard; the message naming the option shows once you edit the dashboard or open the card's editor.

Anchors and the camera are stored in the capture's own coordinates, so re-running the floor tool never moves your pins.

### Styling

A theme can set these, or card-mod on a single card:

| Variable | Default | Meaning |
| --- | --- | --- |
| `--roomtwin-pin-size` | `36px`, `32px` on cards 520px wide or less | Height of a pin. The icon scales with it. |
| `--roomtwin-pin-background` | `rgba(18, 20, 26, 0.75)` | Background of the pin, around its icon. |
| `--roomtwin-pin-text-color` | `#fff` | Label colour, and the icon colour on pins that are off or idle. |
| `--roomtwin-stage-background` | `radial-gradient(120% 100% at 50% 30%, #262a31, #111 70%)` | What shows behind the room while it loads and around its edges. |

Active pins use Home Assistant's own state colours, like `--state-cover-open-color` or `--state-active-color`, so a theme that sets those changes the pins too. In a theme file the names go without the leading dashes:

```yaml
my_theme:
  roomtwin-pin-size: 44px
  roomtwin-pin-background: "rgba(20, 20, 40, 0.7)"
```

With the system's reduce motion setting on, the card skips the camera moves and the pin animations.

### How lights change the room

Each light multiplies the colour of the splats inside its soft sphere:

- off, unavailable or missing: `off_dim` on every channel.
- on: `f = off_dim + (1 - off_dim) × brightness / 255`. A light in a colour mode (`hs`, `xy`, `rgb`, `rgbw`, `rgbww`), or one that reports `rgb_color` without a `color_mode`, is tinted three quarters of the way towards its `rgb_color`, scaled so the brightest channel is 1, so a red bulb still leaves a quarter of the green and blue. Otherwise the tint is white, including white bulbs in `color_temp` mode, since the capture already shows their warmth.

So at the default `off_dim` of 0.45 a light at full brightness leaves its region exactly as captured, and switching it off darkens it to 45%. Capture the room with the lights on for the best result.

Spark has room for 16 edits at first and doubles that on demand, which costs one short shader rebuild when you go past 16. Each light is one edit and the ceiling cut is another. 24 lights on one card were tested and render fine. Each light adds a little per-frame work, so keep an eye on tablets if you go well beyond that.

## Troubleshooting

The card explains every failure it knows about:

- **Could not load /local/roomtwin/x.spz (HTTP 404).** The file isn't where the URL says. The message tells you the `/config/www/` path it expected.
- **Could not reach ...** Home Assistant didn't answer. Check the connection and press **Try again**.
- **Could not read ... as a splat file.** The file downloaded but isn't a scan Spark can read: cut short, saved in another format under this extension, or an HTML error page saved with a `.spz` name.
- **... is a 329 MB .ply.** It still loads, but convert it to `.spz` for tablets.
- **RoomTwin needs WebGL2 ...** The browser or device has no WebGL2, or hardware acceleration is off.
- **The browser dropped the 3D view to free graphics memory.** Common on phones with many tabs open. The card reloads the room by itself the first time; if it happens again within a minute it shows this message and waits for **Try again**.
- **Configuration error** with no details. Edit the dashboard to see the message, for example **Unknown option "lights[0].raduis"**: a typo, or an option this version doesn't have. Check the spelling against the configuration reference.
- **Custom element doesn't exist: roomtwin-card.** The browser hasn't loaded the card. Check the resource is added (step 3), then reload the page. On the companion app, clear the frontend cache from its settings.
- **The room is tilted or upside down.** Use **Set floor (tap 3 points)** in edit mode.
- **Taps land in the wrong place.** Tap on solid, textured surfaces. Blurry or see-through areas of a capture have too little in them to hit.

## Known limits

- A light region is a sphere, so it also brightens whatever else is inside it, like the wall behind the lamp. There is no relighting.
- Where two light spheres overlap their factors multiply, so with both lamps off that spot drops to about 20% rather than 45%. Shrink `radius` or raise `soft_edge` if a corner goes too dark.
- COLMAP captures have no real-world scale, so the "(m)" on the sliders only means metres for Scaniverse captures.
- On a touch screen an up or down swipe scrolls the dashboard, so tilting the view up or down with a finger only works in edit mode. Save the tilt you like with **Use this view as default**.
- While the dashboard's card editor is open, its preview holds a second copy of the room in memory, freed a few seconds after the dialog closes.
- A newly added card starts out pointing at `/local/roomtwin/room.spz`, which won't exist yet, so the editor's preview shows the message explaining where to put the file.

## Development

```sh
npm ci
npm test          # Vitest unit tests
npm run typecheck
npm run build     # writes dist/roomtwin-card.js
```

The card uses Lit, three.js and [Spark](https://sparkjs.dev) 2.2.0, bundled by Rollup into one file.

`npm run demo -- --serve` builds the live demo, the card on a real room with a simulated home around it, and serves it at http://localhost:4173. It needs a scan and the card's YAML in `demo/`; [demo/README.md](demo/README.md) covers that and publishing it on GitHub Pages.

To release, run `npm version <version> --no-git-tag-version` (it updates `package.json` and `package-lock.json`), set the same version in `src/version.ts` (a test keeps them equal), add a `## <version>` section to `CHANGELOG.md`, commit, and push a tag `v<version>`. The release workflow checks the tag matches `package.json`, typechecks, tests and builds the card, creates the GitHub release with those notes and `roomtwin-card.js` attached, then runs the HACS check. HACS installs from the release asset. The HACS check fails unless the README shows at least one image (a screenshot or GIF of the card, not just badges), so add one before the first tag.

## License

MIT
