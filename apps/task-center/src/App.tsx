import type { ResourceJobSnapshot } from '@xunlei-zhiqu/contracts';
import { LoaderCircle, Play, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { StageBReadableApp } from './StageBReadableApp';
import { taskService } from './services/taskServiceClient';

export function App() {
  return (
    <>
      <StageBReadableApp />
      <ResumeRecoveryBar />
    </>
  );
}

function ResumeRecoveryBar() {
  const [jobs, setJobs] = useState<ResourceJobSnapshot[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await taskService.listJobs();
        if (!cancelled) {
          setJobs(next.filter((job) =>
            job.delivery_target === 'local'
            && job.status === 'interrupted'
            && job.next_action === 'resume'
          ));
        }
      } catch {
        // StageBReadableApp already owns the Runtime connectivity presentation.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!jobs.length) return null;
  const job = jobs[0];

  async function resume() {
    setBusyId(job.job_id);
    setError('');
    try {
      const updated = await taskService.resumeJob(job.job_id);
      setJobs((current) => current.filter((item) => item.job_id !== updated.job_id));
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : '继续下载失败');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <aside
      aria-label="可恢复下载"
      style={{
        position: 'fixed', right: 24, bottom: 24, zIndex: 80, width: 360,
        padding: 16, borderRadius: 12, background: 'rgba(255,255,255,.98)',
        boxShadow: '0 14px 40px rgba(20,34,55,.18)', border: '1px solid rgba(30,60,90,.12)'
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <TriangleAlert size={19} style={{ flex: '0 0 auto', marginTop: 2 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.title}
          </strong>
          <small style={{ display: 'block', marginTop: 4 }}>
            下载中断 · 已保留 {formatBytes(job.downloaded_bytes)}
          </small>
          {job.issue && <small style={{ display: 'block', marginTop: 3 }}>{job.issue}</small>}
          {error && <small style={{ display: 'block', marginTop: 5 }}>{error}</small>}
          <button
            type="button"
            onClick={() => void resume()}
            disabled={busyId === job.job_id}
            style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {busyId === job.job_id ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
            继续下载
          </button>
          {jobs.length > 1 && <small style={{ marginLeft: 10 }}>另有 {jobs.length - 1} 个可恢复任务</small>}
        </div>
      </div>
    </aside>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}
