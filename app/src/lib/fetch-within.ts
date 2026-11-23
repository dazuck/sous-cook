/**
 * `base` (the browser's `fetch` by default) that gives a call up after `ms`,
 * alongside any signal the caller passed: a call that never answers ends in
 * a `TimeoutError` rather than holding whatever waits behind it.
 */
export function fetchWithin(
  ms: number,
  base: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}
