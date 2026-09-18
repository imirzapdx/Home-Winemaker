# Build notes — corrected co-inoculation protocols (2026 revision)

**226 tests passing** (209 before). Run with:

```
python3 build_harness.py && node test_app.js
```

---

## Two protocols where there was one

The shipped `red-coinoc-ml` was wrong in ways that only show up in the cellar:
the ML culture was never in the addition schedule at all — only Acti-ML was,
filed under the yeast pitch — and the crush SO₂ was held to 30 ppm on a strain
that tolerates 60. There was no way to plan an ML Prime lot, and nothing in the
app knew that acidifying at crush is what kills a high-pH co-inoculation.

**Red — co-inoculated MLF (VP41)** replaces `red-coinoc-ml`, keeping the id.
Every grape, co-ferment and saved profile already pointing at it carries over.
Crush SO₂ is 38 ppm, tartaric is allowed at crush with a headroom target of
pH 3.3, the culture goes in at the ML stage at 1 g/hL with Acti-ML, and step 9
is the sequential fallback if the co-inoc hasn't moved by day 14.

**Red — co-inoculated MLF (ML Prime)** is new, as `red-coinoc-mlprime`.
L. plantarum, 30 ppm at crush, a pH ≥3.4 gate at 12–24 h, and no acid of any
kind until malic reads below 0.03 g/L.

A `protocolEdits` override saved against the old base would have silently
reinstated the old schedule on load. `migrateState()` retires that one override
once, guarded by a `protoRev` marker that survives a profile round-trip — an
edit made after this build is left alone.

## ML cultures became products

`VP41` and `ML Prime` are catalogued under a new **ML Culture** category, with
real pack sizes: 2.5 g and 25 g, both one pack per 66 gal. The culture appears
in the addition schedule where you read it — stage, rate, rehydration note —
but the shopping list still bills it once, as sachets by volume treated, not
again by weight.

Renaming the JSON's "ML Prime Malolactic Bacteria" to plain `ML Prime` was
necessary: the shopping list keys the culture off the `mlf.culture` string, and
the two have to match or the same pack lands on the list twice.

## A real bug, found on the way

`calcProtocolBiologicals()` sized every ML culture off **post-press** volume.
That is right for a consecutive MLF and wrong for co-inoculation, where the
bacteria go into the fermenter and have to treat the whole must. Co-inoculated
protocols now dose off must volume. On the default cellar that is 59.1 gal of
ML Prime rather than about 50 — still one pack, but it would have under-dosed a
bigger season, and ML Prime cannot multiply in wine to make up the difference.

## Bench trials

A zero-rate addition used to fall off the shopping list entirely, so the
tartaric you have to own on crush day simply wasn't there. Additions now take a
`benchTrial` flag, with a checkbox column in the addition editor. A flagged row
stays on the list showing *bench trial* and a suggested smallest pack instead
of a fabricated quantity, and reads the same way in Tracking and the CSV.
Unflagged zero-rate rows still drop, as before.

## The checker learned strain limits

`MLB_STRAINS` holds VP41 and ML Prime only — phMin, so2Max, alcMax, temp band,
and whether the strain can restart a stalled MLF. Anything else falls back to
the old generic thresholds rather than carrying numbers nobody checked.

- **SO₂** now warns at 75% of the strain's ceiling and errors above it. 38 ppm
  passes clean on VP41 and would warn on ML Prime.
- **pH and alcohol** warnings use the strain's own floor and tolerance, under
  the existing `MLF_LOW_PH` and `MLF_HIGH_ALC` codes.
- **`MLB_PH_GATE`** states the 3.4 floor on the protocol card, because the gate
  is the design of the protocol rather than a footnote.
- **`MLB_NO_RESTART`** says ML Prime has no fallback to itself once the wine is
  dry; **`MLB_NOT_SEQUENTIAL`** is a hard conflict if it's set to consecutive.
- **`ACID_BEFORE_MLF`** errors when acid is scheduled before malic is gone on a
  high-floor strain, and gives VP41 the headroom note instead.

Every preset ships clean — no error-level issues on any of the eleven.

## Test coverage added

17 new tests: both protocols' shape and secondary derivation, culture rates
against pack sizing, no uncatalogued products, single billing, must-versus-
post-press volume in both MLF modes, bench-trial rows surviving into the list
and the CSV, unflagged zero rates still dropping, each new compatibility rule
in both the firing and non-firing direction, the stale-override retirement
leaving a fresh edit alone, and the revision marker surviving a profile
round-trip.

---

Rates and constants are still planning figures. Bench trial anything going into
a batch you care about, and check the current product label before crush.
