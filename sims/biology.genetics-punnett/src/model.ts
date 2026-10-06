/**
 * The model. Pure, DOM-free, deterministic.  (P12-T2, card 14 `biology.genetics-punnett`)
 *
 * ## THE RATIO IS COUNTED, NEVER AUTHORED
 *
 * The temptation in a genetics model is a lookup table: `Aa × Aa` gives `1:2:1` because that is what the
 * textbook says. A lookup table is a list of the ANSWERS, so a cross the author never thought about returns
 * nothing and a cross they thought about wrongly returns a memorised string. Here the four cells are built
 * from the two gamete sets and the ratio is counted off the cells, so the 1:2:1 and the 1:1:0 fall out of
 * the same four lines of arithmetic and neither is a special case.
 *
 * ## CASE IS A CLAIM, AND THIS IS THE FILE THAT PROVES IT
 *
 * `AA` and `aa` are different genotypes, not two spellings of one. `setMatch` folds case by default
 * (`grading.ts:370`), which means the recessive answer to "which genotypes occur" is graded against the
 * dominant list and comes back CORRECT — a false right answer for the exact misconception the card exists
 * to expose. The card therefore mandates `caseSensitive: true` at the call site, and the genotype strings
 * below are generated rather than typed so they cannot drift in case between the model, the screen and the
 * marking key.
 *
 * ## `A` IS DOMINANT BECAUSE THAT IS A FACT ABOUT THIS GENE, NOT A CHOICE
 *
 * An earlier draft made dominance a parameter, on the reasoning that a student might be given an `R`/`r`
 * problem. That was wrong in the direction the gas-law model warns about (`chem.ideal-gas-law/src/model.ts:6`):
 * a value that is not a choice is not a parameter, and a parameter the answer can be tuned by is a
 * parameter the answer is no longer a function of. The gene is fixed here, the dominance is a declared
 * constant, and the cross is the only thing a teacher varies.
 */

/** One gene, two alleles, capital letter for the dominant one — so the genotype's case IS the dominance. */
export const GENOTYPES = ['AA', 'Aa', 'aa'] as const;

export type Genotype = (typeof GENOTYPES)[number];

/** Declared, not configurable. See the header. */
export const DOMINANT_ALLELE = 'A';

export interface PunnettParams {
  /** The first parent's genotype. */
  readonly parentA: string;
  /** The second parent's genotype. */
  readonly parentB: string;
}

/** The gametes a parent of this genotype can produce, derived rather than tabulated. */
export function gametes(genotype: string): string[] {
  const first = genotype[0] ?? '';
  const second = genotype[1] ?? '';
  if (first === '' || second === '') return [];
  return first === second ? [first] : [first, second];
}

/**
 * A pair of alleles in dominance order, so `aA` and `Aa` are the same genotype.
 *
 * Swapping which ALLELE is written first is a difference of handwriting. Swapping an allele's CASE is the
 * misconception. Those are two different normalisations and this is the first one only — the second is
 * refused, because the second is what the question is about.
 */
export function normaliseGenotype(first: string, second: string): string {
  const recessive = DOMINANT_ALLELE === 'A' ? 'a' : 'A';
  const dominantCount = (first === DOMINANT_ALLELE ? 1 : 0) + (second === DOMINANT_ALLELE ? 1 : 0);
  if (dominantCount === 2) return DOMINANT_ALLELE + DOMINANT_ALLELE;
  if (dominantCount === 0) return recessive + recessive;
  return DOMINANT_ALLELE + recessive;
}

/**
 * The cells, in reading order: the top parent's gametes across, the side parent's down.
 *
 * A child's genotype is a pair of gametes, so a monohybrid cross is 2x2 and a `1:2:1` is four cells with one
 * of them repeated. Keeping the repetition is the point: a student who has drawn three distinct cells has
 * drawn the wrong cross, and `offspring` hands that mistake straight to `setMatch`.
 */
export function cells(params: PunnettParams): readonly string[][] {
  const across = gametes(params.parentA);
  const down = gametes(params.parentB);
  return down.map((side) => across.map((top) => normaliseGenotype(top, side)));
}

/** The flat list of offspring genotypes, with repeats — four entries for a monohybrid cross. */
export function offspring(params: PunnettParams): string[] {
  return cells(params).flat();
}

/**
 * The ratio, counted from the cells and written over ALL THREE genotypes.
 *
 * Every genotype gets a count, including the zeros: `Aa × aa` gives `0:1:1`, not `1:1`. A ratio that drops
 * the zeros reads `1:1`, which is a different claim — and a student told their ratio was `1:1` when the
 * square says two heterozygous to one homozygous recessive has been taught the wrong thing.
 */
export function ratio(params: PunnettParams): string {
  const counts = new Map<string, number>(GENOTYPES.map((genotype) => [genotype, 0]));
  for (const child of offspring(params)) counts.set(child, (counts.get(child) ?? 0) + 1);
  return GENOTYPES.map((genotype) => String(counts.get(genotype) ?? 0)).join(':');
}

/** `AA` and `Aa` show the dominant allele's phenotype; `aa` shows the recessive one. */
export function phenotype(genotype: string): string {
  return genotype.includes(DOMINANT_ALLELE) ? 'dominant' : 'recessive';
}

export const clamp = (raw: Partial<PunnettParams>): PunnettParams => {
  const genotype = (value: unknown, fallback: Genotype): string =>
    GENOTYPES.includes(value as Genotype) ? String(value) : fallback;
  return { parentA: genotype(raw.parentA, 'Aa'), parentB: genotype(raw.parentB, 'Aa') };
};

/**
 * `1 : 2 : 1` AND `1:2:1` ARE THE SAME CLAIM, AND `AA` AND `aa` ARE NOT.
 *
 * ## WHY THE WHITESPACE IS REMOVED BY HAND HERE
 *
 * `setMatch` with `caseSensitive: true` swaps `canonicalText` for the IDENTITY function
 * (`grading.ts:370`), so it stops folding whitespace as well as case. A student who types
 * `AA, Aa, aa, Aa` — with a space after each comma, which is what every keyboard's habit produces — then
 * submits three entries that match nothing, and a correct square is graded as zero genotypes. The SDK
 * cannot be changed from inside a simulation, so the normalisation the flag removed has to be put back for
 * the one axis it was not about: SPACE is the keyboard, CASE is the biology.
 */
export function trimEntries(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;\n]/u)
      : [];
  return raw.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
}

/** Whitespace removed, case preserved, for the same reason as `trimEntries` and not for a different one. */
export const canonicalRatio = (value: string): string => value.replace(/\s+/gu, '');

/**
 * The text alternative, DERIVED from the parameters.
 *
 * A caption hard-coded to `1:2:1` stops being true the moment a teacher sets a different cross, and a
 * screen-reader user has no way to check it. This one counts the cells it is describing.
 */
export function describeCross(params: PunnettParams): string {
  const tally = new Map<string, number>();
  for (const child of offspring(params)) tally.set(child, (tally.get(child) ?? 0) + 1);
  const counts = GENOTYPES.filter((genotype) => (tally.get(genotype) ?? 0) > 0)
    .map((genotype) => `${String(tally.get(genotype))} ${genotype} (${phenotype(genotype)})`)
    .join(', ');
  return (
    `A Punnett square with ${params.parentA} along the top and ${params.parentB} down the side, and ` +
    `${DOMINANT_ALLELE} the dominant allele. The cells hold ${counts}, so the offspring ratio is ` +
    `${ratio(params)}.`
  );
}
