/** Test-harness contract: install before creating resources, then register their cleanup actions. */
export interface TerminationCleanup {
  add(action: () => Promise<void>): void;
  cleanup(): Promise<void>;
  dispose(): void;
  throwIfStopping(): void;
}

/** Catchable termination joins the same cleanup as normal completion. SIGKILL cannot be handled. */
export function installTerminationCleanup(options: { readonly actionTimeoutMs: number; readonly onError?: (error: unknown) => void; readonly onSignal?: (signal: 'SIGINT' | 'SIGTERM') => void }): TerminationCleanup {
  if (!Number.isFinite(options.actionTimeoutMs) || options.actionTimeoutMs <= 0) throw new Error('Invalid cleanup timeout');
  const actions: Array<() => Promise<void>> = [];
  let pending: Promise<void> | undefined;
  let terminating = false;
  const cleanup = (): Promise<void> => pending ??= (async () => {
    const errors: unknown[] = [];
    for (const action of actions) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(action),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cleanup action timed out')), options.actionTimeoutMs); }),
        ]);
      } catch (error) { errors.push(error); try { options.onError?.(error); } catch (callbackError) { errors.push(callbackError); } }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
    if (errors.length) throw new AggregateError(errors, 'Owned resource cleanup failed');
  })();
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    if (terminating) return;
    terminating = true;
    try { options.onSignal?.(signal); } catch (error) { console.error('[fixture] signal callback failed', error); }
    void cleanup().catch(error => { console.error('[fixture] cleanup failed', error); }).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return {
    add(action) { if (pending) throw new Error('Cleanup already started'); actions.push(action); },
    cleanup,
    throwIfStopping() { if (pending) throw new Error('Fixture cleanup has started'); },
    dispose() { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); },
  };
}
