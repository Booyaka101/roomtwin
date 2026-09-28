# Live demo

A static page that runs the real card on a scan of your room, with a simulated home in the browser instead of Home Assistant. Visitors can switch lights, open the door sensor, recolour a lamp and try the editor. Nothing they do is saved or sent anywhere.

It needs two files that aren't in the repo until you add them:

- `demo/room.spz`: your scan. Any format the card reads works (`room.ply`, `room.sog` and so on), but keep it under 100 MB, which is GitHub's limit for one file. Above 50 MB the build warns, because phone visitors will wait for it.
- `demo/room.yaml`: the card config. Place your lights and pins on your own dashboard, press **Copy YAML** in the editor and paste it in. The `splat` URL in it doesn't matter, the build points it at the scan.

The scan becomes public the moment you push it, and anyone can download the file. Look around it for photos, post, screens or anything else you wouldn't put online.

## Simulated devices

Every entity in the config gets a believable state from its id: `light.*`, `switch.*`, `fan.*` and `input_boolean.*` toggle, covers open and close, locks lock, scenes and scripts run, buttons press. Sensors are guessed from words in the id (`temperature` or `temp`, `humidity`, `power`, `energy`, `illuminance` or `lux`, `battery`, `co2`) and drift a little every few seconds. Binary sensors named with `door`, `window`, `garage`, `gate`, `motion`, `occupancy`, `moisture` or `smoke` get that device class, so a door pin turns red when it's opened from the side panel.

To change a name or a starting state, add `demo/states.yaml`:

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

That builds the card and the page into `site/` and serves it at http://localhost:4173. `--port 8080` picks another port, and `--config`, `--splat` and `--states` point at files somewhere else.

## Publish on GitHub Pages

1. In the repo's **Settings > Pages**, set **Source** to **GitHub Actions**.
2. Commit `demo/room.spz` and `demo/room.yaml` (and `demo/states.yaml` if you made one) and push to `main`.
3. The **Demo** workflow builds the page and deploys it to `https://<your user>.github.io/roomtwin/`. It runs again whenever the card or the demo changes, and it skips itself while `demo/room.yaml` is missing, so forks without a scan don't fail.

Then add the link near the top of the main README, for example `**[Try the live demo](https://<your user>.github.io/roomtwin/)**`.
