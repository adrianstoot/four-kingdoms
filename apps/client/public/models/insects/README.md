# Original insect unit pack

These five GLB characters were authored specifically for **Imperios del
Enjambre**. They do not contain downloaded meshes, marketplace assets,
third-party animation clips, or output from an online generation service.

The source generator is
`scripts/blender/build_insect_pack.py`. It builds the models from Blender
primitives, constructs each armature, assigns all skin weights, authors the
animation curves, exports the GLBs, re-imports them, and runs a deformation
audit. `provenance.json` records the audited triangle, vertex, bone, and weight
counts shipped with this exact pack.

Each character contains the complete runtime motion set:

- `idle`
- `walk`
- `attack`
- `hit`
- `death`
- `spawn`

The five game archetypes are mapped in `manifest.json`:

- soldier ant
- stinger bee
- hunting mantis
- rhinoceros beetle
- monarch butterfly

To regenerate the complete pack with Blender 4.x or newer:

```powershell
blender --background --python scripts/blender/build_insect_pack.py
```

Only the `team_mark` material is recolored per colony. Species-specific chitin,
wings, eyes, claws, pollen, and markings retain their authored palette.
