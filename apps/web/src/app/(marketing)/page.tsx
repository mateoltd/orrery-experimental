export const metadata = {
  title: 'Orrery — create, teach and assess',
  description:
    'An educational portal where anyone can author resources, embed interactive simulations, run classrooms, and grade submitted work.',
};

export default function MarketingPage() {
  return (
    <main style={{ padding: '3rem', fontFamily: 'system-ui, sans-serif', maxWidth: '44rem' }}>
      <h1>Orrery</h1>
      <p>
        Four coupled products: <strong>Studio</strong> for authoring, <strong>Simulations</strong>{' '}
        that are embeddable in lessons and gradable as exam questions, <strong>Classroom</strong>{' '}
        for running cohorts, and <strong>Assessment</strong> with atomic result release.
      </p>
      <h2>The four laws</h2>
      <ol>
        <li>The server is the only authority — client clocks and scores are untrusted.</li>
        <li>Content is immutable once assigned — an assignment pins a version.</li>
        <li>Withholding is atomic — no student ever sees a partial result.</li>
        <li>Integrity controls are evidence, never a verdict.</li>
      </ol>
    </main>
  );
}
