/**
 * The auth route group: a bare wrapper and nothing else.
 *
 * No shell, no nav, no footer, and specifically NO `AuthFormShell` here. The pages inside it
 * each render their own, because the shell owns the `<main>` landmark and the `<h1>`. Wrapping
 * them in a second one produced two `<main>` elements — the exact
 * `landmark-no-duplicate-main` violation that the jest-axe check caught when this file was
 * first written with a shell in it.
 *
 * The point of the group is that the marketing chrome is STRUCTURALLY absent rather than
 * conditionally hidden. A layout that checks a path is a layout that eventually checks the
 * wrong path.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="auth-layout">{children}</div>;
}
