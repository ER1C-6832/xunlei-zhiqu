import type { ZhiquCapabilities } from '@xunlei-zhiqu/contracts';
import { useEffect, useState } from 'react';
import { resolveZhiquCapabilities } from '../services/capabilityResolver';
import { zhiquService } from '../services/zhiquServiceClient';

const LOCAL_ONLY_FALLBACK = resolveZhiquCapabilities({
  clientRuntimeAvailable: false,
  cloudAnalysisAvailable: false,
  demoLocalRuntimeAvailable: false
});

export function useZhiquCapabilities(): ZhiquCapabilities | null {
  const [capabilities, setCapabilities] = useState<ZhiquCapabilities | null>(null);

  useEffect(() => {
    let disposed = false;
    void zhiquService.getCapabilities()
      .then((resolved) => {
        if (!disposed) setCapabilities(resolved);
      })
      .catch((error) => {
        console.warn('[迅雷智取] capability resolution failed; using local-only fallback', error);
        if (!disposed) setCapabilities(LOCAL_ONLY_FALLBACK);
      });
    return () => {
      disposed = true;
    };
  }, []);

  return capabilities;
}
