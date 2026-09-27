import { signal } from '@preact/signals';
import { useMemo } from 'preact/hooks';

export function useSignal(initialValue) {
  return useMemo(() => signal(initialValue), []);
}
