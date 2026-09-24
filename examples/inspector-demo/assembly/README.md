# Recorded assembly examples

These are byte-for-byte copies of two **L3 factual observation captures** from
the local Casys Digital Thread atelier, recorded on 2026-08-26. The source
checkout's `state/local` is gitignored and may change; the copies here freeze
the observations used by the Inspector demo. `manifest.json` records each
repository-relative source reference, size, SHA-256, observation fingerprint,
and the SysML-backed label for each exact `usageElementId`.

| Capture      | Observation                                                               | Exact source STEP                                                         | Recorded facts                                                                                                    |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tps03.json` | `sha256:06c7252971e86e6e73f69429cf5930648cf0bd8a88c37dfd75c4d277a72367c1` | `sha256:c910c9ec5813f00906cfdc0026161f143ce83557fd297455edf9195717c74c68` | StandBase and StandBackrest: contact, minimum distance 0 mm, intersection volume 0 mm³.                           |
| `msm01.json` | `sha256:69f6f6848f35c581d76b4cd94c1c81397f4e4524f6437cfce9d1f811681c6cb8` | `sha256:fed93fd7dcb222e4ec66aa0df14276f13a4f21a391da0df68810cd2a107e22ca` | BasePlate, Riser, SensorCradle: three `no-contact` pairs at 150, 175, and 345 mm; all intersection volumes 0 mm³. |

The STEP and sibling GLB source references in the manifest identify the original
Digital Thread artifacts without embedding a workstation path; those binaries
are not copied into this directory. The GLB belongs to the same recorded
geometry module as its STEP. It is a separate projection artifact and was
**not** emitted by the integrity observer.

Both JSON files retain the recorded Digital Thread
`assembly-integrity-observation-capture/1.0` envelope and nested
`assembly-integrity-observation/1.0` facts. They are **not** direct
`build123d_observe_assembly_integrity` tool results, whose current output schema
is `build123d-assembly-integrity-observation/1.0`. The recorded provider package
version is `0.5.0`. Present them as dated examples, not as a fresh invocation of
the current server.

The adjacent `tps03.observation.json` and `msm01.observation.json` are separate
saved results in the current direct schema (provider version `0.6.3`) for the
same exact STEP identities. The local Inspector example tools load these direct
results. They still perform no new observation when called; the older L3
captures remain provenance rather than being rewritten into the new schema.

The capture's literal `limits.verdict`, `fitness`, `motion`, `strength`, and
`safety` values are all `none`. Contact and zero positive intersection do not
establish a joint, required clearance, load capacity, motion behavior, or
product safety. MSM01's three placements are deliberately separated. Later
Digital Thread evaluation and human closeout are separate records and are not
contained in these L3 fixtures.
