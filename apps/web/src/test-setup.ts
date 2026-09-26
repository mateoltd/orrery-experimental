/**
 * Test setup.
 *
 * @testing-library/jest-dom is loaded for its SIDE EFFECT of extending expect with the
 * `toBeInTheDocument` family, which is exactly the kind of implicit dependency that makes a
 * suite confusing to read — hence this file existing to say so once, in the place a reader
 * will look.
 *
 * `cleanup` is explicit rather than relying on testing-library's automatic teardown. The
 * automatic path only fires when the test framework exposes globals, and vitest does not by
 * default — so without this, every test that renders a component leaks its DOM into the next
 * one and `getByLabelText` starts failing with "found multiple elements", which looks like a
 * component bug and is not.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
