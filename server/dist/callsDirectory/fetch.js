import { z } from 'zod';
import { SourceDiagnosticError } from '../chatQa/sourceDiagnostics.js';
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
export const callsDirectoryUserSchema = z.object({
    id: z.number().int().positive().safe(),
    username: z.string().max(128).nullable(),
    firstName: z.string().max(200).nullable(),
    lastName: z.string().max(200).nullable(),
    email: z.string().max(254).nullable(),
    active: z.boolean(),
    roles: z
        .array(z.object({ name: z.string().max(128) }).passthrough())
        .max(50)
        .nullable(),
});
const pageSchema = z.object({
    content: z.array(callsDirectoryUserSchema).max(PAGE_SIZE),
    last: z.boolean(),
    number: z.number().int().nonnegative(),
    totalElements: z.number().int().nonnegative(),
});
/** Reads every Calls user with roles (the same list as the admin "User management" page). */
export async function fetchCallsDirectory(transport, signal) {
    const users = new Map();
    let total = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        signal?.throwIfAborted();
        const parsed = pageSchema.safeParse(await transport.request('GET', `/api/users/filterSearch?search=&page=${page}&size=${PAGE_SIZE}`, undefined, signal));
        if (!parsed.success || parsed.data.number !== page)
            throw new SourceDiagnosticError('source_schema_invalid');
        if (total !== null && parsed.data.totalElements !== total)
            throw new SourceDiagnosticError('source_identity_conflict');
        total = parsed.data.totalElements;
        for (const user of parsed.data.content)
            users.set(user.id, user);
        if (parsed.data.last) {
            // Offset paging is not a snapshot; a moving directory must not produce a partial mirror.
            if (users.size !== total)
                throw new SourceDiagnosticError('source_identity_conflict');
            return [...users.values()];
        }
    }
    throw new SourceDiagnosticError('source_catalog_limit');
}
