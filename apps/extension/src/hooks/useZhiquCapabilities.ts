import type { ZhiquCapabilities } from '@xunlei-zhiqu/contracts';
import { useEffect, useState } from 'react';
import { zhiquService } from '../services/zhiquServiceClient';

export function useZhiquCapabilities(): ZhiquCapabilities | null {
  const [capabilities, setCapabilities] = useState<ZhiquCapabilities | null>(null);

  useEffect(() => {
    let disposed = false;
    void zhiquService.getCapabilities().then((resolved) => {
      if (!disposed) setCapabilities(resolved);
    });
    return () => {
      disposed = true;
    };
  }, []);

  return capabilities;
}
