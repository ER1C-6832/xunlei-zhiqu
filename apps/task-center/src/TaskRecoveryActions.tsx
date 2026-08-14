import type { ResourceJobSnapshot } from '@xunlei-zhiqu/contracts';
import { LoaderCircle, Play, Sparkles } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { subscribeJobs, taskService } from './services/taskServiceClient';

type Target = { element: HTMLElement; job: ResourceJobSnapshot };

/**
 * Adds Stage-F actions into StageBReadableApp's existing task rows.
 * It never polls `/v1/jobs`; it subscribes to the list response the existing Task Center already owns.
 */
export function TaskRecoveryActions() {
  const [jobs, setJobs] = useState<ResourceJobSnapshot[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => subscribeJobs(setJobs), []);
  const actionable = useMemo(
    () => jobs.filter((job) =>
      (job.status === 'interrupted' && job.next_action === 'resume')
      || (job.status === 'waiting_for_source' && job.next_action === 'continue_acquisition')
    ),
    [jobs]
  );

  useLayoutEffect(() => {
    const syncTargets = () => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.rr-task-row'));
      const next: Target[] = [];
      for (const row of rows) {
        const title = row.querySelector('.rr-task-name strong')?.textContent?.trim();
        const subtitle = row.querySelector('.rr-task-name small')?.textContent?.trim();
        const job = actionable.find((item) => item.title === title && (!subtitle || item.subtitle === subtitle));
        if (!job) continue;
        const target = row.querySelector<HTMLElement>('.rr-row-status-only');
        if (!target) continue;
        target.style.width = 'auto';
        target.style.minWidth = job.status === 'waiting_for_source' ? '104px' : '96px';
        const icon = target.querySelector<SVGElement>('svg');
        if (icon) icon.style.display = 'none';
        const statusTitle = row.querySelector<HTMLElement>('.rr-task-status strong.warning');
        if (statusTitle && job.status === 'waiting_for_source') statusTitle.textContent = '来源不可用';
        next.push({ element: target, job });
      }
      setTargets(next);
    };

    // The existing StageB list updates in the same task as listJobs(). Waiting one
    // animation frame lets that render land before we resolve its action slots.
    const frame = window.requestAnimationFrame(syncTargets);
    return () => window.cancelAnimationFrame(frame);
  }, [actionable]);

  async function run(job: ResourceJobSnapshot) {
    setBusyId(job.job_id);
    try {
      if (job.status === 'waiting_for_source') {
        const handoff = await taskService.continueAcquisition(job.job_id);
        if (!handoff.resumed && handoff.page_url) {
          window.open(handoff.page_url, '_blank', 'noopener,noreferrer');
        }
      } else {
        await taskService.resumeJob(job.job_id);
      }
    } finally {
      setBusyId(null);
    }
  }

  return <>{targets.map(({ element, job }) => createPortal(
    <button
      key={`${job.job_id}-recovery-action`}
      type="button"
      onClick={(event) => { event.stopPropagation(); void run(job); }}
      disabled={busyId === job.job_id}
      title={job.status === 'waiting_for_source' ? '重新寻找可信来源并继续原任务' : '从已保留进度继续'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
    >
      {busyId === job.job_id
        ? <LoaderCircle className="spin" size={16} />
        : job.status === 'waiting_for_source'
          ? <Sparkles size={16} />
          : <Play size={16} />}
      {job.status === 'waiting_for_source' ? '一键续取' : '继续下载'}
    </button>,
    element
  ))}</>;
}
