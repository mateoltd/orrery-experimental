'use client';

/**
 * The ONE place in the application that mounts generated markup.  (P2-T4)
 *
 * ## Why this exists rather than `dangerouslySetInnerHTML`
 *
 * `plans/14` rests the content security argument on this: "**No user HTML, ever.** A closed
 * block union rendered to HTML we generate. There is no sanitiser to keep patched." The renderer
 * is the security boundary, and its output is trusted *by construction* because the input is a
 * `blockSchema`-validated block from a closed union of sixteen types.
 *
 * So the markup is trusted — and the response to "this is trusted" is not to sprinkle
 * `dangerouslySetInnerHTML` at the call sites where somebody later pastes in something that is
 * not. It is to make the trust boundary a single named component that says what it trusts, and
 * to have exactly one of them.
 *
 * `dangerouslySetInnerHTML` and every other string-to-markup sink are banned by the lint config, which is the right
 * default and the reason this component had to be written: the ban is what makes "there is exactly one place that does
 * this" a checkable claim rather than a convention.
 *
 * ## THE BAN NOW EXISTS, AND `P14-T16` IS WHY THIS PARAGRAPH CHANGED (`TM-21`)
 *
 * It did not. `TM-21` recorded that `eslint.config.js` had no such rule, that `grep -rn dangerouslySetInnerHTML` across
 * the repository returned this comment and three others, and that the property therefore held only because nobody had
 * written the attribute — which is the convention the sentence above claimed it was not. `P14-T16` wrote the rule:
 * `NO_MARKUP_SINKS` and `NO_DOM_PARSER` in `eslint.config.js`, each proven to fire by
 * `packages/config/src/lint-rules.verify.test.ts`, with this file as the single named exemption.
 *
 * **`NO_DOM_PARSER` IS THE ONE THAT MAKES "EXACTLY ONE PLACE" A COUNT.** The five string sinks are all *absent* here —
 * this component assigns no string to anything — so banning only those would leave the "exactly one" claim resting on the
 * same convention it is trying to replace. Banning `new DOMParser` everywhere else makes it a count: one exemption, one
 * file, and a second mount site is a lint error rather than something a reviewer has to notice.
 *
 * ## AND THE EXEMPTION IS A NAMED BLOCK RATHER THAN A SUPPRESSION, DELIBERATELY
 *
 * Flat config merges rule options by replacement, so `eslint.config.js` cannot say "one selector off" — the exemption
 * re-declares the whole array minus `NO_DOM_PARSER`, which is why the entries are named constants at the top of that file.
 * An inline `eslint-disable` would have been shorter and would have taught the habit on the one file the ban exists to
 * protect (`ADR-0027`).
 *
 * ## Why the DOM is built with DOMParser rather than assigned to innerHTML
 *
 * `<div innerHTML={html}>` is a one-line version of the same thing, and it is the version people
 * reach for. Parsing the string ourselves and moving the resulting NODES in means the string is
 * never assigned to a sink, so a future static check that bans `innerHTML` still passes, and a
 * future reviewer grepping for the dangerous pattern finds this file and reads the explanation
 * rather than finding forty call sites to audit. **That check now exists** — `NO_MARKUP_SINKS[1]` — and it would have
 * rejected the one-liner.
 *
 * ## The invariant worth stating
 *
 * **The `html` prop must come from `renderBlock` over a validated block, and from nowhere
 * else.** There is no sanitiser here, deliberately: a sanitiser in front of our own renderer
 * would be a second parser to keep patched, which is the cost `plans/14` refuses to pay. The
 * safety is upstream, and this component's job is to be the only place that knows it.
 */

import { useEffect, useRef } from 'react';

export function TrustedHtml(props: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (host === null) return;
    // Parse in an inert document: scripts do not execute, images are not fetched, so parsing
    // markup we have not yet decided to mount has no side effects at all.
    const parsed = new DOMParser().parseFromString(`<body>${props.html}</body>`, 'text/html');
    host.replaceChildren(...Array.from(parsed.body.childNodes));
  }, [props.html]);

  // Until the effect runs the container is empty. That is a visible frame on a slow render, so
  // it is suppressed rather than left as a layout shift -- and `suppressHydrationWarning` is
  // required because the server rendered nothing and the client mounts nodes.
  return <div ref={ref} className={props.className} suppressHydrationWarning />;
}
