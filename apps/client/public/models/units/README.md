# Rigged unit assets

The renderer keeps the procedural characters as a zero-network fallback. To
enable a rigged GLB, add it beside this file and declare it in `manifest.json`:

```json
{
  "version": 1,
  "units": {
    "guard": {
      "url": "guard.glb",
      "forwardAxis": "+z",
      "clips": {
        "idle": "Idle",
        "walk": "Walk",
        "attack": "Attack",
        "hit": "Hit",
        "death": "Death",
        "spawn": "Spawn"
      },
      "sampleFrames": {
        "idle": 4,
        "walk": 6,
        "attack": 6,
        "hit": 4,
        "death": 6,
        "spawn": 6
      },
      "tintMaterials": ["team", "faction", "accent"]
    }
  }
}
```

`animationUrls` can point at separate animation-only GLBs when the rig exporter
does not package all clips in the base file. The clip tracks must target the
same bone names. Supported archetypes are `guard`, `archer`, `knight`,
`giant` and `commander`.

## Mounted knight: separate horse and rider

The mounted knight should remain two independently rigged assets. This avoids
the unreliable six-limb skeleton produced by treating horse and human as one
character. Use a `mounted` entry:

```json
{
  "version": 1,
  "units": {
    "knight": {
      "type": "mounted",
      "horse": {
        "url": "knight-horse.glb",
        "forwardAxis": "+z",
        "clips": {
          "idle": "Horse_Idle",
          "walk": "Horse_Walk",
          "attack": "Horse_Attack",
          "hit": "Horse_Hit",
          "death": "Horse_Death",
          "spawn": "Horse_Spawn"
        }
      },
      "rider": {
        "url": "knight-rider.glb",
        "forwardAxis": "+z",
        "clips": {
          "idle": "Rider_Idle",
          "walk": "Rider_Walk",
          "attack": "Rider_Axe_Attack",
          "hit": "Rider_Hit",
          "death": "Rider_Death",
          "spawn": "Rider_Mount"
        }
      },
      "riderSocket": {
        "bone": ["Saddle", "saddle_socket"],
        "position": [0, 0.04, 0],
        "rotationDegrees": [0, 0, 0],
        "scale": 1
      },
      "sampleFrames": {
        "idle": 4,
        "walk": 6,
        "attack": 6,
        "hit": 4,
        "death": 6,
        "spawn": 6
      },
      "tintMaterials": ["team", "faction", "accent", "caparison"]
    }
  }
}
```

Horse and rider clips are sampled at the same normalized phase, even when their
source durations differ. The rider follows the named horse socket while its own
rig animates independently. If no socket name is supplied the loader searches
for `saddle`, `seat` or `rider socket`; otherwise the rider offset is relative
to the horse root. An explicitly named socket that cannot be found is an error,
so a visually broken composite is never installed.

`horse.scale`, `rider.scale` and `riderSocket.scale` accept either one positive
number or `[x, y, z]`. Use them only to reconcile exporter units. The complete
horse-and-rider silhouette is grounded, centred and normalized to exactly
2.20 m after both rigs have been evaluated. Any download, socket, clip-baking or
geometry failure leaves the procedural knight active.

Every character is automatically grounded, centred and normalized to its game
height (1.70 m guard, 1.70 m archer, 2.20 m mounted knight, 2.50 m giant and
1.90 m commander). Complete `AnimationClip` objects remain available to close
LODs and galleries; the mass battlefield renderer samples several frames from
each clip and keeps one instanced draw batch per occupied frame.