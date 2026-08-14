import { BatchImagePanel } from './BatchImagePanel';
import { RecoveryMode, usePendingRecovery } from './RecoveryMode';
import { StageDExtensionApp } from './StageDApp';

export function App() {
  const { recovery, refresh } = usePendingRecovery();
  if (recovery) return <RecoveryMode recovery={recovery} onRefresh={() => void refresh()} />;
  return <><StageDExtensionApp /><BatchImagePanel /></>;
}
