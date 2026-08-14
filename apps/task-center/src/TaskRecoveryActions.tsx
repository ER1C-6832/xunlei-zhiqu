import type { ResourceJobSnapshot } from '@xunlei-zhiqu/contracts';
import { LoaderCircle, Play, Search, Sparkles } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useState, type MouseEvent } from 'react';
import { subscribeJobs, taskService } from './services/taskServiceClient';

type Target = { element: HTMLElement; job: ResourceJobSnapshot };

type RecoveryAction = 'resume' | 'reacquire';

/**
 * Adds recovery actions into StageBReadableApp's existing task rows.
 * It never polls `/v1/jobs`; it subscribes to the list response the existing Task Center already owns.
 */
export function TaskRecoveryActions() {
  const [jobs, setJobs] = useState<ResourceJobSnapshot[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [busy, setBusy] = useState<{ jobId: string; action: RecoveryAction } | null>(null);

  useEffect(() => subscribeJobs(setJobs), []);
  const actionable = useMemo(
    () => jobs.filter((job) =>
      (job.status === 'interrupted' && (job.next_action === 'resume' || job.next_action === 'continue_acquisition'))
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
        target.style.minWidth = job.status === 'interrupted' && job.next_action === 'continue_acquisition' ? '206px' : job.status === 'waiting_for_source' ? '104px' : '96px';
        const icon = target.querySelector<SVGElement>('svg');
        if (icon) icon.style.display = 'none';
        const statusTitle = row.querySelector<HTMLElement>('.rr-task-status strong.warning');
        if (statusTitle && job.status === 'waiting_for_source') statusTitle.textContent = '当前下载地址已失效';
        if (statusTitle && job.status === 'interrupted' && job.next_action === 'continue_acquisition') statusTitle.textContent = '下载中断';
        next.push({ element: target, job });
      }
      setTargets(next);
    };

    const frame = window.requestAnimationFrame(syncTargets);
    return () => window.cancelAnimationFrame(frame);
  }, [actionable]);

  async function run(job: ResourceJobSnapshot, action: RecoveryAction) {
    setBusy({ jobId: job.job_id, action });
    try {
      if (action === 'reacquire') {
        const handoff = await taskService.continueAcquisition(job.job_id);
        if (!handoff.resumed && handoff.page_url) {
          window.open(handoff.page_url, '_blank', 'noopener,noreferrer');
        }
      } else {
        await taskService.resumeJob(job.job_id);
      }
    } finally {
      setBusy(null);
    }
  }

  return <>{targets.map(({ element, job }) => createPortal(
    job.status === 'interrupted' && job.next_action === 'continue_acquisition'
      ? <span key={`${job.job_id}-recovery-actions`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <button
            type="button"
            onClick={(event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); void run(job, 'resume'); }}
            disabled={busy?.jobId === job.job_id}
            title="再次尝试当前下载地址"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}
          >
            {busy?.jobId === job.job_id && busy.action === 'resume' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
            继续下载
          </button>
          <button
            type="button"
            onClick={(event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); void run(job, 'reacquire'); }}
            disabled={busy?.jobId === job.job_id}
            title="去其他页面寻找同一资源的新下载地址"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}
          >
            {busy?.jobId === job.job_id && busy.action === 'reacquire' ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}
            寻找其他来源
          </button>
        </span>
      : <button
          key={`${job.job_id}-recovery-action`}
          type="button"
          onClick={(event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); void run(job, job.status === 'waiting_for_source' ? 'reacquire' : 'resume'); }}
          disabled={busy?.jobId === job.job_id}
          title={job.status === 'waiting_for_source' ? '重新寻找可信来源并继续原任务' : '从已保留进度继续'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
        >
          {busy?.jobId === job.job_id
            ? <LoaderCircle className="spin" size={16} />
            : job.status === 'waiting_for_source'
              ? <Sparkles size={16} />
              : <Play size={16} />}
          {job.status === 'waiting_for_source' ? '一键续取' : '继续下载'}
        </button>,
    element
  ))}</>;
}
