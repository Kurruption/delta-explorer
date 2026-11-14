import { runElevated, type ElevatedOutcome, type ElevatedRequest } from './api';
import { errorToast, movePathRefs, toast } from './store';

/** Windows' "access denied" in its various spellings (io error, HRESULT, trash crate). */
export const isDenied = (e: unknown) => /access is denied|os error 5\)|0x80070005|permission denied/i.test(String(e));

/** Runs one operation as administrator (UAC prompt), then reports. Resolves with the outcome when it worked. */
export async function elevate(req: ElevatedRequest, done: string): Promise<ElevatedOutcome | null> {
  try {
    const o = await runElevated(req);
    for (const [from, to] of o.moved) movePathRefs(from, to);
    if (!o.ok) { errorToast(o.error ?? 'The operation failed'); return null; }
    toast(`${done} (as administrator)`);
    return o;
  } catch (e) {
    if (String(e) === 'cancelled') toast('Cancelled: administrator permission wasn’t given');
    else errorToast(e);
    return null;
  }
}

/** Shows the error; when it's "access denied", offers "Try as administrator" for the same operation. */
export function failOrElevate(e: unknown, req: ElevatedRequest, done: string, after?: (o: ElevatedOutcome) => void) {
  if (!isDenied(e)) return errorToast(e);
  toast(String(e), 'error', { label: 'Try as administrator', run: () => void elevate(req, done).then((o) => o && after?.(o)) });
}
