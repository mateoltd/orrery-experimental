/**
 * The generated client, re-exported from ONE place.
 *
 * Two reasons this file exists:
 *
 *   1. The generated output path is an implementation detail of the Prisma generator
 *      (`output = "./generated/client"` in the schema, relative to the schema directory).
 *      When it changes, exactly one file changes.
 *   2. `@prisma/client`'s generated output is not in the module graph until `db:generate`
 *      has run. Routing the import through here keeps that failure legible: if the generate
 *      has not run, `tsc` reports `Cannot find module '../prisma/generated/client/client.js'`
 *      — which names the exact missing artefact and the command that produces it.
 *
 * A `@ts-expect-error` was here to paper over exactly that, and it was wrong twice over:
 * it is banned by `plans/00` §6.2 rule 6 without an exception, and once the generate HAS
 * run it becomes an *unused* directive, which is itself an error. The legible failure is
 * strictly better than the suppression.
 *
 * If you see this module unresolved, run: `pnpm --filter @orrery/db db:generate`
 */

export { PrismaClient } from '../prisma/generated/client/client.js';
