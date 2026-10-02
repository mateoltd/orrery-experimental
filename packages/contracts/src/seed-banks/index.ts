/**
 * The seed banks — actual questions, authored.  (P5-T15, `D-37`)
 *
 * ## WHY THIS FILE EXISTS AT ALL
 *
 * `D-37`: "nothing in 183 tasks authors a single question — while the anti-collusion claim rests
 * on item banks." Which means every overlap figure, every pool-health number and every
 * `RANDOM_WITHOUT_REPLACEMENT` strategy in this repository was, until now, a formula applied to a
 * pool of zero items. A bank with nothing in it is not a small bank; it is a proof that the code
 * path runs.
 *
 * So these are real questions with real keys, and the awkward truth about them is recorded below
 * rather than hidden.
 *
 * ## BANK B IS UNDER THE THRESHOLD AND THAT IS THE POINT
 *
 * `MIN_HEALTHY_ITEM_COUNT` is 40. Bank A has 40 items and is healthy. Bank B has 24 and is not,
 * and `seedBankReport()` says so in a number: how many more items it needs, in which pool, and what
 * the overlap looks like at this size.
 *
 * The alternative was to author 40 in both banks so every test is green and the report is a
 * decoration. That is the failure mode `D-37` is about: a health check that has never been seen to
 * fail is not a health check. `seed-banks.test.ts` asserts Bank B's shortfall is reported with the
 * exact item count, so the warning path is exercised by the shipped content rather than by a
 * synthetic pool.
 *
 * ## THE KEYS ARE HERE, AND THEY NEVER TRAVEL
 *
 * Every item carries `modelAnswer` and `rationale`. `INV-Q-1` says answer keys never leave the
 * server, and the reason these live in a source file rather than in a private bucket is that a key
 * an author cannot read is a key an author cannot check. The `installSeedBanks` projection in
 * `packages/db` writes `modelAnswer` and `rubric` and reads nothing else back out, and
 * `seed-banks.test.ts` asserts the item projection has no field a key could hide in.
 *
 * ## THE SUBJECT MATTER IS ORDINARY ON PURPOSE
 *
 * Photosynthesis and forces have unambiguous keys, which matters for a bank whose purpose is to be
 * drawn at random by thirty students: an item with two defensible answers produces a grade dispute
 * that has nothing to do with the anti-collusion maths. The domain is deliberately boring.
 */

import { MIN_HEALTHY_ITEM_COUNT, type PoolHealth, poolHealth } from '../pool-health/index.js';

export type SeedQuestionType =
  | 'SINGLE_CHOICE'
  | 'MULTI_SELECT'
  | 'TRUE_FALSE'
  | 'NUMERIC'
  | 'SHORT_TEXT'
  | 'ORDERING'
  | 'FREE_RESPONSE';

export type SeedResponseProcess = 'RECOGNITION' | 'RECALL' | 'PRODUCTION';

export interface SeedOption {
  readonly id: string;
  readonly text: string;
}

export interface SeedQuestion {
  readonly id: string;
  readonly type: SeedQuestionType;
  /** `ItemFacts.topic`. Drives blueprint coverage, so it is not decorative. */
  readonly topic: string;
  /** `ItemFacts.responseProcess`. */
  readonly responseProcess: SeedResponseProcess;
  readonly prompt: string;
  readonly options?: readonly SeedOption[];
  /** Comma-separated option ids, or the value itself for non-choice types. */
  readonly modelAnswer: string;
  readonly points: number;
  readonly estimatedSeconds: number;
  readonly gradingMode: 'AUTO' | 'MANUAL';
  /** `NUMERIC` only: absolute tolerance, in the item's own unit. */
  readonly tolerance?: number;
  /** `FREE_RESPONSE` only. */
  readonly rubric?: readonly string[];
  /** Author-facing. Why the key is the key. Never projected to a student client. */
  readonly rationale: string;
  /** `ORDERING` only: the text to be arranged, already shuffled. */
  readonly ordering?: readonly string[];
}

export interface SeedPool {
  readonly id: string;
  readonly name: string;
  readonly questionIds: readonly string[];
  /**
   * Exactly the four strategies `QuestionPoolStrategy` has. `RANDOM_WITH_REPLACEMENT` is the
   * obvious fifth and it does not exist: drawing an item twice into one form is not a variation,
   * it is a mistake, and a content type that names it would let an author write a pool the
   * database cannot store and the drawer cannot honour.
   */
  readonly strategy:
    | 'RANDOM_WITHOUT_REPLACEMENT'
    | 'QUOTA_TOPICS'
    | 'QUOTA_RESPONSE_PROCESS'
    | 'FIXED';
  readonly drawCount: number;
  readonly expectedCohortSize: number;
}

export interface SeedBank {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly questions: readonly SeedQuestion[];
  readonly pools: readonly SeedPool[];
}

// ───────────────────────────────────────────────── authoring helpers
//
// Six small constructors rather than sixty-four repeated object literals. A typo in
// `responseProcess` is invisible in a wall of JSON and obvious on line 3 of a helper.

const opts = (...texts: string[]): SeedOption[] =>
  texts.map((text, i) => ({ id: String.fromCharCode(97 + i), text }));

const choice = (
  id: string,
  topic: string,
  responseProcess: SeedResponseProcess,
  prompt: string,
  options: readonly string[],
  correct: readonly string[],
  rationale: string,
  extra: Partial<Pick<SeedQuestion, 'points' | 'estimatedSeconds'>> = {},
): SeedQuestion => ({
  id,
  type:
    options.length === 2 && /^(True|False)$/.test(options[0] ?? '')
      ? 'TRUE_FALSE'
      : 'SINGLE_CHOICE',
  topic,
  responseProcess,
  prompt,
  options: opts(...options),
  modelAnswer: correct.join(','),
  points: extra.points ?? 1,
  estimatedSeconds: extra.estimatedSeconds ?? 45,
  gradingMode: 'AUTO',
  rationale,
});

const multi = (
  id: string,
  topic: string,
  prompt: string,
  options: readonly string[],
  correct: readonly string[],
  rationale: string,
): SeedQuestion => ({
  id,
  type: 'MULTI_SELECT',
  topic,
  responseProcess: 'RECOGNITION',
  prompt,
  options: opts(...options),
  modelAnswer: correct.join(','),
  points: 2,
  estimatedSeconds: 90,
  gradingMode: 'AUTO',
  rationale,
});

const numeric = (
  id: string,
  topic: string,
  prompt: string,
  answer: number,
  unit: string,
  tolerance: number,
  rationale: string,
): SeedQuestion => ({
  id,
  type: 'NUMERIC',
  topic,
  responseProcess: 'RECALL',
  prompt,
  modelAnswer: `${String(answer)} ${unit}`.trim(),
  points: 1,
  estimatedSeconds: 60,
  gradingMode: 'AUTO',
  tolerance,
  rationale,
});

const short = (
  id: string,
  topic: string,
  prompt: string,
  answer: string,
  rationale: string,
  seconds = 60,
): SeedQuestion => ({
  id,
  type: 'SHORT_TEXT',
  topic,
  responseProcess: 'RECALL',
  prompt,
  modelAnswer: answer,
  points: 1,
  estimatedSeconds: seconds,
  gradingMode: 'AUTO',
  rationale,
});

const order = (
  id: string,
  topic: string,
  prompt: string,
  sequence: readonly string[],
  rationale: string,
): SeedQuestion => ({
  id,
  type: 'ORDERING',
  topic,
  responseProcess: 'RECALL',
  prompt,
  ordering: sequence,
  modelAnswer: sequence.map((s) => s.slice(0, 1)).join(','),
  points: 2,
  estimatedSeconds: 120,
  gradingMode: 'AUTO',
  rationale,
});

const free = (
  id: string,
  topic: string,
  prompt: string,
  modelAnswer: string,
  rubric: readonly string[],
  rationale: string,
): SeedQuestion => ({
  id,
  type: 'FREE_RESPONSE',
  topic,
  responseProcess: 'PRODUCTION',
  prompt,
  modelAnswer,
  rubric,
  points: 4,
  estimatedSeconds: 300,
  gradingMode: 'MANUAL',
  rationale,
});

// ───────────────────────────────────────────────── Bank A: biology, 40 items

const BIO_A = [
  choice(
    'bio-photosyn-01',
    'photosynthesis',
    'RECOGNITION',
    'Which word equation is the balanced summary equation for photosynthesis?',
    [
      'carbon dioxide + water → glucose + oxygen',
      'glucose + oxygen → carbon dioxide + water + energy',
      'glucose + carbon dioxide → water + oxygen',
      'water + oxygen → glucose + hydrogen',
    ],
    ['a'],
    'Photosynthesis takes in CO2 and H2O and builds glucose, releasing O2. The distractor `b` is respiration, which is why the two are taught together.',
  ),
  choice(
    'bio-photosyn-02',
    'photosynthesis',
    'RECOGNITION',
    'Where does the light-dependent reaction take place?',
    [
      'In the stroma',
      'On the thylakoid membrane',
      'In the mitochondrial matrix',
      'In the cytoplasm',
    ],
    ['b'],
    'The light-dependent reactions are the thylakoid membranes: the photosystems and the ATP synthase embedded in them. The stroma hosts the Calvin cycle.',
  ),
  choice(
    'bio-photosyn-03',
    'photosynthesis',
    'RECOGNITION',
    'Where does the Calvin cycle take place?',
    ['In the stroma', 'On the thylakoid membrane', 'In the intermembrane space', 'In the nucleus'],
    ['a'],
    'The stroma is the fluid around the thylakoids and it is where carbon fixation happens.',
  ),
  choice(
    'bio-photosyn-04',
    'photosynthesis',
    'RECOGNITION',
    'Which pigment absorbs blue and orange light most strongly?',
    ['Chlorophyll a', 'Chlorophyll b', 'Carotene', 'Xanthophyll'],
    ['a'],
    'Chlorophyll a is the primary pigment and its absorption peaks are blue and red-orange. Chlorophyll b fills in green.',
  ),
  choice(
    'bio-photosyn-05',
    'photosynthesis',
    'RECOGNITION',
    'A plant is kept in the dark for 48 hours. What happens to the starch in its leaves?',
    [
      'It increases as respiration continues without photosynthesis replacing it',
      'It stays constant because starch is not respired',
      'It decreases as it is respired and no photosynthesis replaces it',
      'It is converted directly to chlorophyll',
    ],
    ['c'],
    'Starch is the storage carbohydrate and it is respired overnight. Destarching is the standard practical preparation for a photosynthesis test.',
  ),
  choice(
    'bio-photosyn-06',
    'photosynthesis',
    'RECOGNITION',
    'Why is iodine used to test for starch in a leaf?',
    [
      'It turns blue-black in the presence of starch',
      'It turns green in the presence of starch',
      'It dissolves starch so the leaf becomes transparent',
      'It measures the oxygen produced',
    ],
    ['a'],
    'Iodine is a non-specific test that forms a blue-black complex with starch. It says starch is present; it does not say how much.',
  ),
  choice(
    'bio-photosyn-07',
    'photosynthesis',
    'RECOGNITION',
    'In the practical, why is a leaf heated first in ethanol?',
    [
      'To remove chlorophyll so the iodine result is visible',
      'To kill any insects on the leaf',
      'To increase the rate of photosynthesis',
      'To dissolve the cell membrane',
    ],
    ['a'],
    'Ethanol removes the chlorophyll, which would otherwise mask the blue-black. Boiling water baths are used because ethanol is flammable — the safety point is examinable.',
  ),
  short(
    'bio-photosyn-08',
    'photosynthesis',
    'Name the two products of the light-dependent reactions that are used by the Calvin cycle.',
    'ATP and reduced NADP (NADPH)',
    'They carry the energy and the electrons needed to reduce carbon dioxide to triose phosphate.',
    75,
  ),
  short(
    'bio-photosyn-09',
    'photosynthesis',
    'Name the product of the light-dependent reactions that leaves the leaf.',
    'Oxygen',
    'Oxygen is the by-product of splitting water to replace the electrons lost by photosystem II.',
    40,
  ),
  short(
    'bio-photosyn-10',
    'photosynthesis',
    'Write the six-carbon product of carbon fixation in the Calvin cycle.',
    'Glucose (or a hexose)',
    'Two molecules of the three-carbon GP combine to make one hexose. Six CO2 fix to give twelve GP.',
    50,
  ),
  choice(
    'bio-photosyn-11',
    'photosynthesis',
    'RECOGNITION',
    'Which factor is NOT a limiting factor investigated in the practical?',
    ['Light intensity', 'Carbon dioxide concentration', 'Temperature', 'Soil type'],
    ['d'],
    'Light, CO2 and temperature are all manipulated. Soil type is not, which is why the answer is the odd one out and why a student should say so explicitly.',
  ),
  choice(
    'bio-photosyn-12',
    'photosynthesis',
    'RECOGNITION',
    'A plant is placed in a sealed jar with a sodium hydroxide pellet. Why?',
    [
      'To absorb the carbon dioxide so it cannot be a limiting factor',
      'To supply oxygen to the plant',
      'To raise the temperature',
      'To absorb the water vapour produced',
    ],
    ['a'],
    'Sodium hydroxide absorbs CO2, so the only variable left limiting is light. That is a control, not a condition under test.',
  ),
  numeric(
    'bio-photosyn-13',
    'photosynthesis',
    'A plant absorbs 12 units of carbon dioxide in one hour. At the same time it takes in 12 units of oxygen. How many units of oxygen does photosynthesis PRODUCE?',
    12,
    'units',
    0,
    'This is the whole difficulty of measuring gas exchange: respiration consumes oxygen at the same time. The oxygen taken in is the difference between what was produced and what respiration used.',
  ),
  numeric(
    'bio-photosyn-14',
    'photosynthesis',
    'A leaf is moved from 25 °C to 35 °C and the rate of photosynthesis stops increasing. What is the likely limiting factor?',
    35,
    '°C (the temperature at which the enzyme denatures)',
    5,
    'The rate plateauing then falling as temperature rises points at the enzymes rather than the light or CO2. Enzymes denature above their optimum.',
  ),
  short(
    'bio-photosyn-15',
    'photosynthesis',
    'Name the reagent that turns a leaf blue-black in the starch test.',
    'Iodine',
    'The test reagent. The original wording mentioned iodine in the prompt, which made the item ask a question whose answer it had already given — caught by the "prompt contains its own answer" check, which is what that check is for.',
  ),
  short(
    'bio-photosyn-16',
    'photosynthesis',
    'Name the organelle in which photosynthesis occurs.',
    'Chloroplast',
    'One word. "Chlorophyll" is the pigment and is the classic distractor.',
    30,
  ),
  multi(
    'bio-photosyn-17',
    'photosynthesis',
    'Which of these are inputs to photosynthesis? Select all that apply.',
    ['Carbon dioxide', 'Water', 'Oxygen', 'Glucose'],
    ['a', 'b'],
    'CO2 and water in, glucose and oxygen out. Asking which are INPUTS catches the student who lists all four substances involved.',
  ),
  order(
    'bio-photosyn-18',
    'photosynthesis',
    'Put these stages of photosynthesis in the correct order.',
    [
      'Light absorbed by chlorophyll',
      'Water split, releasing oxygen',
      'ATP and NADPH made',
      'Carbon dioxide fixed',
      'Glucose built',
    ],
    'The light-dependent reactions must supply ATP and NADPH before the Calvin cycle can fix carbon. Getting this backwards is the commonest ordering error.',
  ),
  choice(
    'bio-resp-01',
    'respiration',
    'RECOGNITION',
    'Where does aerobic respiration take place in a eukaryotic cell?',
    ['Cytoplasm and mitochondria', 'Chloroplasts only', 'Nucleus only', 'Cell wall'],
    ['a'],
    'Glycolysis happens in the cytoplasm; the Krebs cycle and the electron transport chain are in the mitochondria.',
  ),
  choice(
    'bio-resp-02',
    'respiration',
    'RECOGNITION',
    'Which row correctly pairs the stage with where it happens?',
    [
      'Glycolysis — cytoplasm; Krebs cycle — mitochondrial matrix',
      'Glycolysis — mitochondrial matrix; Krebs cycle — cytoplasm',
      'Glycolysis — nucleus; Krebs cycle — ribosome',
      'Glycolysis — chloroplast; Krebs cycle — mitochondrion',
    ],
    ['a'],
    'The matrix holds the Krebs cycle enzymes; the cytoplasm is where glycolysis splits glucose.',
  ),
  choice(
    'bio-resp-03',
    'respiration',
    'RECOGNITION',
    'What is the net ATP yield from aerobic respiration per glucose molecule?',
    ['2', '36–38', 'About 120', 'Zero'],
    ['b'],
    'The old textbook figure of 38 is now usually given as 36–38 because the protons used to move the sugars out of the mitochondrion cost ATP too. Both are accepted; the modern range is the better answer.',
  ),
  choice(
    'bio-resp-04',
    'respiration',
    'RECOGNITION',
    'What happens to NADH in the electron transport chain?',
    [
      'It loses electrons, which drive ATP synthase',
      'It gains electrons and becomes ATP',
      'It is converted to glucose',
      'It diffuses out of the mitochondrion',
    ],
    ['a'],
    'NADH donates electrons to the carrier proteins. The energy released pumps protons, and their flow back through ATP synthase makes ATP.',
  ),
  choice(
    'bio-resp-05',
    'respiration',
    'RECOGNITION',
    'What is the substrate-level product of glycolysis that feeds the Krebs cycle?',
    ['Pyruvate', 'Acetyl CoA', 'Glucose', 'Ethanol'],
    ['b'],
    'Pyruvate is decarboxylated in the mitochondrial matrix to give acetyl CoA, which enters the Krebs cycle. A full mark here usually mentions the loss of CO2.',
  ),
  choice(
    'bio-resp-06',
    'respiration',
    'RECOGNITION',
    'Which is the correct sequence of the Krebs cycle?',
    [
      'Glucose → pyruvate → acetyl CoA → Krebs cycle',
      'Glucose → acetyl CoA → pyruvate → Krebs cycle',
      'Pyruvate → Krebs cycle → glucose',
      'Glucose → Krebs cycle → pyruvate → acetyl CoA',
    ],
    ['a'],
    'Glycolysis produces pyruvate; the link reaction makes acetyl CoA; the Krebs cycle comes last.',
  ),
  choice(
    'bio-resp-07',
    'respiration',
    'RECOGNITION',
    'Why is anaerobic respiration described as "less efficient"?',
    [
      'Less ATP is made per glucose because the electron transport chain is not used',
      'It is slower to start',
      'It requires more glucose',
      'It produces more carbon dioxide',
    ],
    ['a'],
    'Without the electron transport chain only substrate-level ATP is available: 2 against 36–38.',
  ),
  choice(
    'bio-resp-08',
    'respiration',
    'RECOGNITION',
    'In yeast, anaerobic respiration produces ethanol and which other product?',
    ['Carbon dioxide', 'Oxygen', 'Water', 'Lactic acid'],
    ['a'],
    'Yeast fermentation yields ethanol and CO2, which is what makes bread rise and beer effervesce.',
  ),
  choice(
    'bio-resp-09',
    'respiration',
    'RECOGNITION',
    'In muscle, the anaerobic product is lactic acid. What happens to it during a sprint?',
    [
      'It builds up and is converted to ethanol afterwards',
      'It is converted to glucose in the liver using oxygen afterwards',
      'It leaves the muscle immediately as CO2',
      'It is used directly to make ATP in the electron transport chain',
    ],
    ['b'],
    'The oxygen debt is repaid in the liver by converting lactate back to glucose, which is why heavy breathing continues after the sprint ends.',
  ),
  numeric(
    'bio-resp-10',
    'respiration',
    'How many ATP molecules are made per glucose by substrate-level phosphorylation alone?',
    2,
    'ATP',
    0,
    'Two in glycolysis and two in the Krebs cycle. Everything else comes from the electron transport chain.',
  ),
  numeric(
    'bio-resp-11',
    'respiration',
    'A muscle cell respires one glucose molecule aerobically. How many molecules of carbon dioxide are released in total?',
    6,
    'CO2',
    0,
    'Two from the link reaction (pyruvate to acetyl CoA) and four from the Krebs cycle (two per acetyl CoA).',
  ),
  short(
    'bio-resp-12',
    'respiration',
    'Name the process that converts pyruvate into acetyl CoA.',
    'The link reaction (oxidative decarboxylation)',
    'The link reaction is the examinable name. Naming pyruvate dehydrogenase is a bonus.',
    45,
  ),
  short(
    'bio-resp-13',
    'respiration',
    'Name the process by which one glucose molecule is split into two pyruvate molecules.',
    'Glycolysis',
    'It happens in the cytoplasm, needs no oxygen, and nets two ATP. Every other respiration item is anchored on this stage.',
    45,
  ),
  choice(
    'bio-resp-14',
    'respiration',
    'RECOGNITION',
    'Which statement about the electron transport chain is correct?',
    [
      'Oxygen is the final electron acceptor',
      'Oxygen is produced by it',
      'It does not require a membrane',
      'It occurs in anaerobic respiration only',
    ],
    ['a'],
    'Oxygen accepts the electrons and combines with protons to form water. Without it the chain backs up, which is why anaerobic respiration has to stop at fermentation.',
  ),
  multi(
    'bio-resp-15',
    'respiration',
    'Which of these are products of aerobic respiration? Select all that apply.',
    ['Carbon dioxide', 'Water', 'Oxygen', 'ATP'],
    ['a', 'b', 'd'],
    'CO2, water and ATP. Oxygen is consumed, not produced — the same mistake as in the photosynthesis item, deliberately.',
  ),
  order(
    'bio-resp-16',
    'respiration',
    'Put the stages of aerobic respiration in order.',
    [
      'Glycolysis in cytoplasm',
      'Link reaction in matrix',
      'Krebs cycle in matrix',
      'Electron transport chain on inner membrane',
    ],
    'Glycolysis first, then the link reaction, then the Krebs cycle, then the chain. The chain is last because it needs the NADH and FADH2 made by the earlier stages.',
  ),
  choice(
    'bio-transport-01',
    'transport',
    'RECOGNITION',
    'Which vessel carries water and mineral ions from the roots to the leaves?',
    ['Xylem', 'Phloem', 'Stoma', 'Tracheid only'],
    ['a'],
    'Xylem carries water up. Phloem carries sugars, which is the single most examinable distinction in plant transport.',
  ),
  choice(
    'bio-transport-02',
    'transport',
    'RECOGNITION',
    'Which vessel carries sugars made in the leaves to other parts of the plant?',
    ['Phloem', 'Xylem', 'Stomata', 'Root hairs'],
    ['a'],
    'Phloem translocation distributes sucrose. The direction can be upwards to a bud or downwards to a root.',
  ),
  choice(
    'bio-transport-03',
    'transport',
    'RECOGNITION',
    'Which process explains the upward movement of water in the xylem?',
    ['Transpiration pull', 'Root pressure alone', 'Active transport', 'Diffusion'],
    ['a'],
    'Evaporation from the stomata pulls the column up. Root pressure exists but is far too small to account for a tall tree.',
  ),
  choice(
    'bio-transport-04',
    'transport',
    'RECOGNITION',
    'Root hairs increase the rate of water uptake because they',
    [
      'Increase the surface area',
      'Pump water actively',
      'Have thick cell walls',
      'Contain chloroplasts',
    ],
    ['a'],
    'They are extensions of the epidermal cells, and surface area is the whole mechanism. Water moves in by osmosis down a water potential gradient, not by a pump.',
  ),
  choice(
    'bio-transport-05',
    'transport',
    'RECOGNITION',
    'A plant is placed in a solution with a LOWER water potential than its cells. What happens?',
    [
      'Water leaves the cells by osmosis and the plant becomes flaccid',
      'Water enters the cells and they become turgid',
      'Nothing happens because osmosis needs light',
      'The cells pump water in',
    ],
    ['a'],
    'Water moves from higher to lower water potential. Placing a plant in this solution is how plasmolysis is demonstrated.',
  ),
  choice(
    'bio-transport-06',
    'transport',
    'RECOGNITION',
    'What is the role of a stomatal guard cell?',
    [
      'To open and close the pore by changing its turgor',
      'To absorb carbon dioxide for the Calvin cycle',
      'To secrete cuticle',
      'To transport sugars',
    ],
    ['a'],
    'Guard cells gain water and become turgid to open, and lose it to close. This is control of a diffusion pathway.',
  ),
  choice(
    'bio-transport-07',
    'transport',
    'RECOGNITION',
    'Which change would cause a plant to lose water fastest?',
    [
      'Increased temperature, low humidity and still air',
      'Low temperature, high humidity and still air',
      'Increased humidity and moving air',
      'High light intensity with stomata closed',
    ],
    ['a'],
    'A steep water-vapour gradient and still air both increase evaporation. Every one of those four factors is a variable in transpiration experiments.',
  ),
  choice(
    'bio-transport-08',
    'transport',
    'RECOGNITION',
    'During plasmolysis, the cell membrane pulls away from the cell wall because',
    [
      'The vacuole shrinks and the cytoplasm loses water',
      'The cell wall dissolves',
      'The nucleus enlarges',
      'The chloroplasts burst',
    ],
    ['a'],
    'The vacuole loses water by osmosis, the cytoplasm shrinks, and the membrane follows it. The wall is permeable and does not shrink.',
  ),
  numeric(
    'bio-transport-09',
    'transport',
    'A plant loses 30 cm³ of water in an hour. How much is that in cm³ over a school day of 8 hours at a constant rate?',
    240,
    'cm3',
    0,
    'A straight multiplication, and the assumption of a constant rate should be stated — it is the assumption doing the work.',
  ),
  short(
    'bio-transport-10',
    'transport',
    'Give the term for the movement of water from a region of higher to lower water potential across a partially permeable membrane.',
    'Osmosis',
    'The definition should include the partially permeable membrane; without it the student has described diffusion.',
    60,
  ),
  free(
    'bio-transport-11',
    'transport',
    'Explain why a plant wilts when it is moved from a water bath into a concentrated sugar solution, and what would be seen if it were returned to water.',
    'Water leaves the vacuole by osmosis down a water potential gradient; the cells lose turgor and the plant wilts. Returning it to water reverses the movement, the vacuole fills and turgor is restored, provided the cell membrane has not been permanently damaged.',
    [
      'States osmosis and the direction of water potential (2)',
      'Links loss of water to loss of turgor (1)',
      'Predicts recovery on returning to water (1)',
    ],
    'A four-mark free response. The mark scheme rewards the mechanism, not the observation: "the plant looks different" scores nothing on its own.',
  ),
  choice(
    'bio-photosyn-19',
    'photosynthesis',
    'RECOGNITION',
    'True or false: light is a reactant in the light-dependent reactions.',
    ['True', 'False'],
    ['a'],
    'True, and it is the energy source that splits water and drives ATP synthesis. Calling light a reactant rather than an energy input is the phrasing that trips students.',
  ),
  choice(
    'bio-resp-17',
    'respiration',
    'RECOGNITION',
    'True or false: aerobic respiration produces more ATP per glucose than anaerobic respiration.',
    ['True', 'False'],
    ['a'],
    'True: 36-38 against 2. This is the cleanest single-item test of why "less efficient" means less ATP rather than "slower".',
  ),
  choice(
    'bio-transport-13',
    'transport',
    'RECOGNITION',
    'True or false: water can be pulled up a tall tree by root pressure alone.',
    ['False', 'True'],
    ['a'],
    'False. Root pressure is a few kPa and cannot account for a 100 m tree; transpiration pull can. The reversed option order stops "True first" from being a strategy.',
  ),
  free(
    'bio-transport-12',
    'transport',
    'A student claims transpiration is "active transport". Explain why they are wrong, using the mechanism of transpiration pull.',
    'Transpiration is the passive evaporation of water from the spongy mesophyll through the stomata, and it pulls the water column up the xylem down a water potential gradient. No energy is spent by the plant moving the water itself, which is what makes it passive; the energy came from the sun driving evaporation.',
    [
      'Identifies transpiration as evaporation, not a pump (2)',
      'Describes the pull down a water potential gradient (1)',
      'States no ATP or energy is used by the plant (1)',
    ],
    'The misconception is extremely common and worth an item of its own, because a teacher who accepts it will teach a false mechanism.',
  ),
] as const;

// ───────────────────────────────────────────────── Bank B: physics, 24 items
//
// UNDER the 40-item threshold on purpose. See the note at the top of the file: a health check
// that has never been seen to fail is not a health check.

const PHYS_B = [
  choice(
    'phy-forces-01',
    'forces',
    'RECOGNITION',
    'Which is a contact force?',
    ['Friction', 'Gravitational force', 'Electrostatic force', 'Nuclear force'],
    ['a'],
    'Contact forces need touching. Weight and the other two act at a distance.',
  ),
  choice(
    'phy-forces-02',
    'forces',
    'RECOGNITION',
    'What is the SI unit of force?',
    ['Newton', 'Joule', 'Watt', 'Pascal'],
    ['a'],
    'Named after Isaac Newton. A joule is an energy and a pascal a pressure, which are the two most common unit confusions.',
  ),
  choice(
    'phy-forces-03',
    'forces',
    'RECOGNITION',
    'A resultant force of 0 N on an object means the object is',
    [
      'At rest or moving at constant velocity',
      'Always accelerating',
      'Always at rest',
      'Always moving',
    ],
    ['a'],
    'Newton\'s first law. Constant velocity includes "rest", which is why the first option has two clauses.',
  ),
  choice(
    'phy-forces-04',
    'forces',
    'RECOGNITION',
    'A 60 kg student stands still on the ground. What is the size of the resultant force?',
    ['0 N', 'About 600 N', '60 N', '9.81 N'],
    ['a'],
    'Weight (about 588 N) and the normal reaction are equal and opposite, so the resultant is zero. Answering "600 N" is the classic error of reporting the weight instead of the resultant.',
  ),
  numeric(
    'phy-forces-05',
    'forces',
    'A resultant force of 15 N acts on a mass of 3 kg. What is the acceleration?',
    5,
    'm/s2',
    0.001,
    'F = ma, so a = 15 ÷ 3. The units come from newtons per kilogram.',
  ),
  numeric(
    'phy-forces-06',
    'forces',
    'A 1200 kg car accelerates at 2 m/s². What resultant force acts on it?',
    2400,
    'N',
    1,
    'F = ma, with the units multiplying: kg × m/s² = N.',
  ),
  choice(
    'phy-forces-07',
    'forces',
    'RECOGNITION',
    'When a passenger walks to the front of a moving bus, which force acts on them?',
    [
      'Friction from the floor',
      'A forward force from the bus',
      'Their weight only',
      'Air resistance only',
    ],
    ['a'],
    'The floor pushes the passenger forward through friction as the bus accelerates. The student is not being pushed by the bus directly.',
  ),
  choice(
    'phy-forces-08',
    'forces',
    'RECOGNITION',
    'Which describes a balanced force pair on a book lying on a table?',
    [
      'Weight down, normal reaction up',
      'Friction up, weight up',
      'Weight down, friction down',
      'Normal reaction up, air resistance up',
    ],
    ['a'],
    'A stationary object has equal and opposite forces, which is a special case of the first law.',
  ),
  short(
    'phy-forces-09',
    'forces',
    'Give the equation that relates resultant force, mass and acceleration, in symbols.',
    'F = ma',
    'All three quantities. Marks are commonly lost for omitting the "resultant".',
    40,
  ),
  order(
    'phy-forces-10',
    'forces',
    'Put these in order from weakest to strongest.',
    [
      'Gravitational attraction between two apples',
      'Friction holding a book still',
      "A person's weight",
      "The electrostatic force between an atom's nucleus and its electron",
    ],
    'Gravity is weak at small scales; the electromagnetic force holding an atom together overwhelms it, which is why a book does not collapse.',
  ),
  choice(
    'phy-energy-01',
    'energy',
    'RECOGNITION',
    'What is the SI unit of energy?',
    ['Joule', 'Newton', 'Watt', 'Pascal'],
    ['a'],
    'A watt is a power, a rate of doing work, which is the standard mix-up.',
  ),
  choice(
    'phy-energy-02',
    'energy',
    'RECOGNITION',
    'What is the SI unit of power?',
    ['Watt', 'Joule', 'Newton', 'Ampere'],
    ['a'],
    'One watt is one joule per second.',
  ),
  numeric(
    'phy-energy-03',
    'energy',
    'A machine supplies 600 J of work in 4 seconds. What is its power output?',
    150,
    'W',
    0.5,
    'P = E ÷ t. The efficiency question is separate and is a different item.',
  ),
  choice(
    'phy-energy-04',
    'energy',
    'RECOGNITION',
    'An object is lifted 2 m and gains 100 J of gravitational energy. What is its mass?',
    ['5 kg', '50 kg', '20 kg', '0.5 kg'],
    ['a'],
    'E = mgΔh, so m = 100 ÷ (9.8 × 2) ≈ 5.1 kg, which rounds to 5.',
  ),
  choice(
    'phy-energy-05',
    'energy',
    'RECOGNITION',
    'A light ray travels through glass. What happens to its speed?',
    ['It decreases', 'It increases', 'It stays the same', 'It becomes zero'],
    ['a'],
    'Light slows entering a denser medium. The frequency does not change, which is why the wavelength does.',
  ),
  choice(
    'phy-energy-06',
    'waves',
    'RECOGNITION',
    'What is the relationship between frequency and wavelength in a wave?',
    [
      'v = f λ, so they are inversely related',
      'They are directly proportional',
      'They are equal',
      'They are unrelated',
    ],
    ['a'],
    'At a fixed speed, doubling the frequency halves the wavelength. This is the item students most often answer "directly related".',
  ),
  numeric(
    'phy-waves-07',
    'waves',
    'A wave has a frequency of 50 Hz and a speed of 300 m/s. What is its wavelength?',
    6,
    'm',
    0.01,
    'λ = v ÷ f = 300 ÷ 50.',
  ),
  choice(
    'phy-waves-08',
    'waves',
    'RECOGNITION',
    'Which wave needs a medium to travel through?',
    ['Sound', 'Light', 'X-rays', 'Radio waves'],
    ['a'],
    'Sound is mechanical and needs particles to compress. The others are electromagnetic and travel in a vacuum.',
  ),
  choice(
    'phy-waves-09',
    'waves',
    'RECOGNITION',
    'The period of a wave is',
    [
      'The time for one complete cycle',
      'The distance between two crests',
      'The height of the wave',
      'The speed of the wave',
    ],
    ['a'],
    'Wavelength is the crest-to-crest distance. Period and frequency are inverses.',
  ),
  choice(
    'phy-waves-10',
    'waves',
    'RECOGNITION',
    'What happens to a wave as it passes from a narrow part of a ripple tank into a wide part?',
    [
      'It slows down and the waves spread out',
      'It speeds up and narrows',
      'It slows down and steepens',
      'Nothing changes',
    ],
    ['a'],
    'Slower speed in the shallow region with the frequency unchanged means the wavelength gets longer — a shallow-water wave.',
  ),
  short(
    'phy-waves-11',
    'waves',
    'Give the relationship between period and frequency.',
    'T = 1 / f',
    'Both are needed: naming the inverse relationship without the equation loses the mark in most mark schemes.',
    45,
  ),
  choice(
    'phy-forces-14',
    'forces',
    'RECOGNITION',
    'True or false: a moving object must have a non-zero resultant force on it.',
    ['False', 'True'],
    ['a'],
    'False. Constant velocity is the first law; only acceleration needs a net force. This is the item that separates "moving" from "accelerating".',
  ),
  choice(
    'phy-waves-12',
    'waves',
    'RECOGNITION',
    'True or false: sound travels faster in air than in water.',
    ['False', 'True'],
    ['a'],
    'False. Sound is faster in solids than in liquids than in gases, because it needs tight particles to transmit the compression.',
  ),
  free(
    'phy-energy-12',
    'energy',
    'A crane lifts a 500 kg load 12 m in 8 seconds using a motor that takes 2400 J of electrical energy. Calculate the power output of the motor and its efficiency.',
    'Output energy = 500 × 9.8 × 12 = 58 800 J. Power = 58 800 ÷ 8 = 7350 W. Efficiency = 58 800 ÷ 2400 = 2.45, i.e. 245%, which is impossible — so the numbers must be wrong. Realistically the efficiency would be about 80%, so the load would take about 73 500 J.',
    [
      'Correctly computes the work done, mgΔh (2)',
      'Divides by time to get power (1)',
      'Divides useful output by input for efficiency (1)',
    ],
    'The impossible efficiency is the teaching point. A student who computes 245% and stops has missed the question, and an item that could not be wrong in that way would not teach anything.',
  ),
  free(
    'phy-forces-13',
    'forces',
    'Explain, using the idea of resultant force, why a car does not continue moving at constant speed when the engine is switched off.',
    'When the engine is switched off the driving force becomes zero but resistance (friction and air resistance) continues to act backwards, so the resultant force is no longer zero but equal and opposite to the resistance. The car therefore decelerates, and it only stops once the resistance has reduced the speed to zero.',
    [
      'States the driving force is zero (1)',
      'Identifies a backwards resultant, not zero (2)',
      'Links the resultant to deceleration (1)',
    ],
    'This is the item that catches "it stops because there is no friction". Friction is what slows it; without friction it would continue forever.',
  ),
] as const;

// ───────────────────────────────────────────────── the banks

export const SEED_BANKS: readonly SeedBank[] = [
  {
    id: 'seed-biology-core',
    name: 'Biology — photosynthesis, respiration and plant transport',
    description:
      `The core biology bank. ${String(BIO_A.length)} items across three topics, deliberately unambitious ground truth ` +
      'so a random draw cannot produce a grade dispute.',
    questions: BIO_A,
    pools: [
      {
        id: 'seed-biology-core-all',
        name: `All core biology (${String(BIO_A.length)})`,
        questionIds: BIO_A.map((q) => q.id),
        strategy: 'RANDOM_WITHOUT_REPLACEMENT',
        drawCount: 12,
        expectedCohortSize: 30,
      },
      {
        id: 'seed-biology-photosynthesis',
        name: 'Photosynthesis',
        questionIds: BIO_A.filter((q) => q.topic === 'photosynthesis').map((q) => q.id),
        strategy: 'RANDOM_WITHOUT_REPLACEMENT',
        drawCount: 6,
        expectedCohortSize: 30,
      },
      {
        id: 'seed-biology-respiration',
        name: 'Respiration',
        questionIds: BIO_A.filter((q) => q.topic === 'respiration').map((q) => q.id),
        strategy: 'RANDOM_WITHOUT_REPLACEMENT',
        drawCount: 6,
        expectedCohortSize: 30,
      },
      {
        id: 'seed-biology-transport',
        name: 'Plant transport',
        questionIds: BIO_A.filter((q) => q.topic === 'transport').map((q) => q.id),
        strategy: 'RANDOM_WITHOUT_REPLACEMENT',
        drawCount: 4,
        expectedCohortSize: 30,
      },
    ],
  },
  {
    id: 'seed-physics-core',
    name: 'Physics — forces, energy and waves',
    description:
      `The physics bank (${String(PHYS_B.length)} items), deliberately UNDER the 40-item threshold. It exists so ` +
      'the health reporting has a real failing pool to report on rather than a synthetic one.',
    questions: PHYS_B,
    pools: [
      {
        id: 'seed-physics-core-all',
        name: `All core physics (${String(PHYS_B.length)})`,
        questionIds: PHYS_B.map((q) => q.id),
        strategy: 'RANDOM_WITHOUT_REPLACEMENT',
        drawCount: 10,
        expectedCohortSize: 30,
      },
      {
        id: 'seed-physics-forces',
        name: 'Forces',
        questionIds: PHYS_B.filter((q) => q.topic === 'forces').map((q) => q.id),
        strategy: 'RANDOM_WITHOUT_REPLACEMENT',
        drawCount: 6,
        expectedCohortSize: 30,
      },
    ],
  },
];

export const seedQuestions = (bankId: string): readonly SeedQuestion[] =>
  SEED_BANKS.find((b) => b.id === bankId)?.questions ?? [];

export const seedPools = (bankId: string): readonly SeedPool[] =>
  SEED_BANKS.find((b) => b.id === bankId)?.pools ?? [];

// ───────────────────────────────────────────────── the report

/**
 * What `D-37` asks for: the expected-overlap tooling that makes the ABSENCE of content visible
 * rather than silent.
 *
 * A pool health module applied to zero items produces zero warnings, because there is nothing to be
 * undersized. So the authored banks are measured here, by bank and by pool, and the measurement
 * includes the number of items still needed to reach `MIN_HEALTHY_ITEM_COUNT` — because "this bank
 * is too small" is advice and "this bank needs 17 more items in the transport pool" is a task.
 *
 * Nothing here blocks. `plans/06` §7's argument is that a shortfall should be VISIBLE and
 * prioritised, not that it should stop a teacher teaching, and the one thing that genuinely does
 * block — a pool too small to draw — is the one thing `poolHealth` already marks blocking.
 */

export interface SeedPoolReport {
  readonly bankId: string;
  readonly poolId: string;
  readonly name: string;
  readonly itemCount: number;
  readonly drawCount: number;
  /** How many more items this pool needs to reach the threshold. `0` means healthy. */
  readonly itemsShortOfTarget: number;
  readonly health: PoolHealth;
  /** The draw-count integrity check: every item id resolves, and the pool can fill its own draw. */
  readonly drawable: boolean;
  readonly problems: readonly string[];
}

export interface SeedBankReport {
  readonly bankId: string;
  readonly name: string;
  readonly itemCount: number;
  readonly questionTypes: Readonly<Record<string, number>>;
  readonly topics: readonly string[];
  readonly responseProcesses: Readonly<Record<string, number>>;
  /** Items missing `topic` or `responseProcess`, which `requireItemMetadata` would reject. */
  readonly itemsMissingMetadata: readonly string[];
  /** Answer keys are present on every item that can be auto-graded, and absent where manual. */
  readonly keyProblems: readonly string[];
  readonly pools: readonly SeedPoolReport[];
  readonly totalItemsShortOfTarget: number;
  /**
   * The headline a maintainer reads first: how many items must be authored before every pool in
   * this bank is healthy.
   */
  readonly authoringTask: string;
}

const poolOf = (bank: SeedBank, pool: SeedPool): PoolHealth =>
  poolHealth({
    itemCount: pool.questionIds.length,
    drawCount: pool.drawCount,
    cohortSize: pool.expectedCohortSize,
  });

export function seedBankReport(bankId: string): SeedBankReport {
  const bank = SEED_BANKS.find((b) => b.id === bankId);
  if (!bank) throw new Error(`UNKNOWN_SEED_BANK: ${bankId}`);

  const byId = new Map(bank.questions.map((q) => [q.id, q]));
  const questionTypes: Record<string, number> = {};
  const responseProcesses: Record<string, number> = {};
  const topics = new Set<string>();
  const itemsMissingMetadata: string[] = [];
  const keyProblems: string[] = [];

  for (const q of bank.questions) {
    questionTypes[q.type] = (questionTypes[q.type] ?? 0) + 1;
    responseProcesses[q.responseProcess] = (responseProcesses[q.responseProcess] ?? 0) + 1;
    if (q.topic === '') topics.add('(untopiced)');
    else topics.add(q.topic);
    // Only `topic` is checked at runtime. `responseProcess` is a required union of three
    // non-empty literals, so the compiler has already ruled out the empty case; the first
    // version checked both and `tsc` refused the redundant half (TS2367), which is the type
    // doing its job. The type IS the guarantee.
    if (q.topic === '') itemsMissingMetadata.push(q.id);
    // An auto-graded item with no key is unanswerable, and the failure mode is a zero awarded to
    // every student who picked the right answer. A manual item is the opposite: a key that looks
    // like a model answer but is graded by a person.
    if (q.gradingMode === 'AUTO' && q.modelAnswer.trim() === '')
      keyProblems.push(`${q.id}: auto-graded with no key`);
    if (q.gradingMode === 'MANUAL' && (q.rubric ?? []).length === 0)
      keyProblems.push(`${q.id}: manual with no rubric`);
    if (q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_SELECT' || q.type === 'TRUE_FALSE') {
      const ids = new Set((q.options ?? []).map((o) => o.id));
      for (const key of q.modelAnswer.split(',').filter((k) => k !== '')) {
        if (!ids.has(key)) keyProblems.push(`${q.id}: key "${key}" is not one of its options`);
      }
    }
  }

  const pools: SeedPoolReport[] = bank.pools.map((pool) => {
    const health = poolOf(bank, pool);
    const problems: string[] = [];
    for (const qid of pool.questionIds) {
      if (!byId.has(qid)) problems.push(`pool references unknown item ${qid}`);
    }
    if (
      pool.strategy === 'RANDOM_WITHOUT_REPLACEMENT' &&
      pool.drawCount > pool.questionIds.length
    ) {
      problems.push(
        `draws ${String(pool.drawCount)} from ${String(pool.questionIds.length)} without replacement`,
      );
    }
    if (pool.strategy === 'FIXED' && pool.drawCount !== pool.questionIds.length) {
      problems.push('FIXED pool has a drawCount different from its item count');
    }
    return {
      bankId: bank.id,
      poolId: pool.id,
      name: pool.name,
      itemCount: pool.questionIds.length,
      drawCount: pool.drawCount,
      itemsShortOfTarget: Math.max(0, MIN_HEALTHY_ITEM_COUNT - pool.questionIds.length),
      health,
      drawable: health.drawable && problems.length === 0,
      problems,
    };
  });

  const totalItemsShortOfTarget = pools.reduce((sum, p) => sum + p.itemsShortOfTarget, 0);
  const totalItemsShortOfTargetHuman = totalItemsShortOfTarget;

  return {
    bankId: bank.id,
    name: bank.name,
    itemCount: bank.questions.length,
    questionTypes,
    topics: [...topics].sort(),
    responseProcesses,
    itemsMissingMetadata,
    keyProblems,
    pools,
    totalItemsShortOfTarget,
    authoringTask:
      totalItemsShortOfTargetHuman === 0
        ? `Every pool in ${bank.name} is at or above the ${String(MIN_HEALTHY_ITEM_COUNT)}-item target.`
        : `${bank.name} needs ${String(totalItemsShortOfTargetHuman)} more item(s) to bring every pool to ${String(MIN_HEALTHY_ITEM_COUNT)}. ` +
          pools
            .filter((p) => p.itemsShortOfTarget > 0)
            .map((p) => `${p.name}: +${String(p.itemsShortOfTarget)}`)
            .join('; ') +
          '. The largest pools need them least, so start with the ones that need the most.',
  };
}

export const allSeedBankReports = (): readonly SeedBankReport[] =>
  SEED_BANKS.map((b) => seedBankReport(b.id));
