# chem.ideal-gas-law

Set the pressure, volume and amount of a gas, then calculate its temperature in kelvin.

## The model

`T = PV / nR`, with `R = 8.314 J/(mol·K)`.

## Why `R` is not a parameter

The gas constant is a fact about the universe, not a choice. Making it configurable would let a teacher
"solve" PV = nRT with a number that is not the gas constant, and the student would learn the *shape* of the
law without the law. The projectile sim keeps `g` out of its parameters for the same reason, and the rule
generalises: **a value that is not a choice is not a parameter.**

## Parameters

| name | label | unit | min | max | default |
|---|---|---|---|---|---|
| `p` | Pressure | kPa | 50 | 300 | 101.3 |
| `v` | Volume | L | 1 | 60 | 22.4 |
| `n` | Amount | mol | 0.1 | 5 | 1 |
| `showFormula` | Show the rearranged law | — | — | — | `true` |

## Answer

`{ kelvin }` — **in kelvin**, which is what the law uses.

## A CELSIUS READING IS A DIFFERENT QUESTION, NOT AN ARITHMETIC ERROR

100 °C is 373 K. A student who types `0` because the gas is at 0 °C has not made a mistake about division;
they have answered in the wrong unit. Two options, and both are wrong:

- mark it 0, which teaches a student the field rejects their unit;
- convert it silently, which teaches them the field ignores it.

So it is graded as the answer it *is* — the Celsius reading is converted, compared, and full credit given —
and the feedback names the conversion: *"You entered a Celsius reading. 0 °C is 273.15 K, and the law needs
kelvin."* The student gets the mark and learns why the unit mattered.

## Why the relative tolerance is 0.5% here and 2% everywhere else

Every other sim uses `relative: 0.02`. On a **temperature near 273 K** that is 5.5 K of slack — and on an
absolute scale, 5 K is not a rounding error, it is a visibly different answer. The relative tolerance is
meant for quantities with a meaningful zero; kelvin has one, but the *scale* of the number makes a
percentage useless as a grade boundary. Tightened to 0.5% (1.4 K at these values) with `absolute: 1`
alongside it.

## The test root

`sims/vitest.config.ts` adds a runner without making `sims/` a pnpm workspace — `RN-07` says a simulation
resolves the SDK and the RNG and nothing more, so the aliases are declared in the vitest config instead.
`_template` and `_fixtures` are excluded: they are scaffolding, and a permanently red test in a suite is
how the real ones stop being read too.