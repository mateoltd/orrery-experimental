# chem.mole-concentration

**Concentration by dilution.** A burette is read in centimetres and the reading is delivered into a
volumetric flask; the student works out the concentration of the diluted solution.

## Why this simulation exists

Every other gold simulation asks the student to read a number off a display or compute one from a
formula. This one gives three inputs and asks for a fourth number that is none of them: the burette
reading must be converted from centimetres to millilitres, the millilitres multiplied by the stock
concentration to get moles, and the moles divided by the flask volume.

`plans/20` gives every chemistry question a simulator. Most of them look like this one, and a platform
that has only ever graded "what the widget says" has not been tested against a student who has to
decide what the widget is asking.

## The reading is not always an integer

A burette is read to the bottom of the meniscus and the convention is to include one decimal place, so
the readings are given to 0.1 mL. The unit conversion happens before the arithmetic, not after it.

## Grading

Four marks, tolerance-based, with a declared band of 6 because dilution answers differ by factors
rather than by rounding.
