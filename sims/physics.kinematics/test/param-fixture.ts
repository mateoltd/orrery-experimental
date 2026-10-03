/** The grader's OWN declaration, for the clamping test, so the fixture cannot drift from the sim. */
import { choice, type ParamSpec } from '@orrery/sim-sdk/grader';

export const scenarioParam = choice({
  name: 'scenario',
  label: 'Situation',
  values: ['dropped', 'thrown', 'rolled'],
  default: 'dropped',
});

/** Only the numeric half is needed here; the point of the test is that `scenario` SURVIVES. */
export const simpleParams = (t: ParamSpec) => ({ t, scenario: scenarioParam });
