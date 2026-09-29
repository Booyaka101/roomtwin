# Live demo

A static page that runs the real card on a scanned room, with a simulated home in the browser instead of Home Assistant. Visitors can switch lights, open the door sensor, recolour a lamp and try the editor. Nothing they do is saved or sent anywhere.

It ships with the Playroom from the Deep Blending dataset and some made-up devices pinned on it. To show your own room, replace two files:

- `demo/room.spz`: the scan. Any format the card reads works (`room.ply`, `room.sog` and so on), but keep it under 100 MB, which is GitHub's limit for one file. Above 50 MB the build warns, because phone visitors will wait for it.
- `demo/room.yaml`: the card config. Place your lights and pins on your own dashboard, press **Copy YAML** in the editor and paste it in. The `splat` URL in it doesn't matter, the build points it at the scan.

The scan becomes public the moment you push it, and anyone can download the file. Look around it for photos, post, screens or anything else you wouldn't put online.

## Simulated devices

Every entity in the config gets a believable state from its id: `light.*`, `switch.*`, `fan.*` and `input_boolean.*` toggle, covers open and close, locks lock, scenes and scripts run, buttons press, media players play and pause, and a `climate.*` thermostat heats to a target you can raise and lower. The side panel has a button or two for each of these. A `tap_action` that calls a service works as long as it's one of those, including `homeassistant.turn_on` and friends and a script called by its own name, like `script.goodnight`. Sensors are guessed from words in the id (`temperature` or `temp`, `humidity`, `power`, `energy`, `illuminance` or `lux`, `battery`, `co2`). Temperature, humidity, power, light level and CO2 drift a little every few seconds; energy and battery hold still. Binary sensors named with `door`, `window`, `garage`, `gate`, `motion`, `occupancy`, `moisture` or `smoke` get that device class, so a door pin turns red when it's opened from the side panel. Covers named with `blind`, `curtain` or `shade` get that class and its icon too. Motion and occupancy sensors see someone every minute or so and clear 20 seconds later.

An `icon` the page can't draw (anything that isn't `mdi:`, or a name missing from `@mdi/js`) gets a warning at build time, and its pin shows the entity's usual icon instead. The page also shows `room.yaml` under the room as you wrote it, entity ids, comments and all, so treat everything in it as public.

To change a name or a starting state, edit `demo/states.yaml`. An entity listed there but not in the card still shows up in the side panel, which is handy for a scene or script that a pin's `tap_action` runs:

```yaml
light.ceiling_lights:
  attributes: { friendly_name: Big light }
binary_sensor.balcony_door:
  state: "on"
sensor.living_temperature:
  state: "19.5"
  attributes: { friendly_name: Living room }
```

## Try it locally

```sh
npm ci
npm run demo -- --serve
```

That builds the card and the page into `site/` and serves it at http://localhost:4173. `--port 8080` picks another port, `--config`, `--splat` and `--states` point at files somewhere else, and `--out` builds into another folder inside the repo.

## Publish on GitHub Pages

1. In the repo's **Settings > Pages**, set **Source** to **GitHub Actions**.
2. Commit `demo/room.spz` and `demo/room.yaml` (and `demo/states.yaml` if you changed it) and push to `main`. A scan kept in Git LFS works too, the workflow fetches LFS files.
3. The **Demo** workflow builds the page and deploys it to `https://<your user>.github.io/roomtwin/`. It runs again whenever the card or the demo changes, and it skips itself while `demo/room.yaml` is missing. Forks build the page but don't deploy it.

The main README links to it near the top, so change that link in a fork.
