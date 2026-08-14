import type { CaptureBatch, PendingRecoveryView, RecoveryCaptureResult } from '@xunlei-zhiqu/contracts';
import { Check, ExternalLink, LoaderCircle, Play, Search, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { zhiquService } from './services/zhiquServiceClient';
type Props = { recovery: PendingRecoveryView; onRefresh: () => void };
export function RecoveryMode({ recovery, onRefresh }: Props) {
  const [current, setCurrent] = useState(recovery); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(recovery.message); const [error, setError] = useState<string | null>(null); const submittedKey = useRef('');
  useEffect(() => { setCurrent(recovery); setMessage(recovery.message); }, [recovery]);
  const percent = current.total_bytes > 0 ? current.progress : null;
  const actionable = useMemo(() => current.candidates.filter((item) => item.verification !== 'mismatch' && item.match !== 'reject'), [current.candidates]);
  const scanCurrentPage = useCallback(async () => {
    if (busy) return; setBusy(true); setError(null); setMessage('正在当前页面寻找可用下载地址…');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id || !tab.url) throw new Error('未找到当前资源页');
      if (current.original_page_url && !sameRecoveryPage(tab.url, current.original_page_url)) { setMessage('请先切换到原资源页，再继续寻找可用来源'); return; }
      const key = `${current.recovery_id}:${tab.url}`; if (submittedKey.current === key) return;
      const response = await sendContentMessage(tab.id, { type: 'XUNLEI_ZHIQU_FULL_PAGE_SCAN', tabId: tab.id }); if (!response?.ok || !response.batch?.candidates?.length) throw new Error(response?.error || '当前页面没有发现可用下载项');
      submittedKey.current = key; applyResult(await zhiquService.submitRecoveryCapture(current.recovery_id, response.batch as CaptureBatch));
    } catch (scanError) { setError(scanError instanceof Error ? scanError.message : '寻找可用来源失败'); } finally { setBusy(false); }
  }, [busy, current]);
  useEffect(() => { if (current.phase === 'opening_source_page') void scanCurrentPage(); }, [current.phase, scanCurrentPage]);
  function applyResult(result: RecoveryCaptureResult) { setCurrent(result.recovery); setMessage(result.message); if (result.resumed) window.setTimeout(onRefresh, 700); }
  async function chooseCandidate(candidateId: string) { setBusy(true); setError(null); setMessage('正在验证新来源…'); try { const result = await zhiquService.chooseRecoveryCandidate(current.recovery_id, candidateId); setCurrent(result.recovery); setMessage(result.message); if (result.resumed) window.setTimeout(onRefresh, 700); } catch (chooseError) { setError(chooseError instanceof Error ? chooseError.message : '来源验证失败'); } finally { setBusy(false); } }
  async function openOriginalPage() { if (current.original_page_url) await chrome.tabs.create({ url: current.original_page_url }); }
  return <main className="zhiqu-shell"><header className="zhiqu-header"><strong>继续下载</strong></header><section className="zhiqu-start-card" style={{ display: 'grid', gap: 16 }}><div className="zhiqu-start-copy"><h1>{current.resource_title}</h1><p>{current.variant_summary}</p></div><div className="zhiqu-page-note"><strong>{percent !== null ? `已保留 ${percent.toFixed(1)}% 下载进度` : '已有下载进度已保留'}</strong><span>{message}</span></div>{busy && <div className="zhiqu-working" role="status"><LoaderCircle className="spin" size={20} /><span>{message}</span></div>}{!busy && current.phase === 'opening_source_page' && <div className="zhiqu-start-actions"><button className="zhiqu-primary" type="button" onClick={() => void scanCurrentPage()}><Search size={18} />在当前页面继续寻找</button>{current.original_page_url && <button className="zhiqu-secondary" type="button" onClick={() => void openOriginalPage()}><ExternalLink size={17} />打开原资源页</button>}</div>}{current.candidates.length > 0 && <section className="zhiqu-recommended"><h2>找到 {current.candidates.length} 项下载内容</h2>{current.candidates.map((candidate) => <div key={candidate.candidate_id} className="zhiqu-page-note" style={{ display: 'grid', gap: 8 }}><strong>{candidate.label}</strong><span>{candidate.verification === 'mismatch' ? '此来源与已下载内容不一致' : candidate.message || candidate.reason || '等待验证'}</span>{candidate.verification === 'sample_match' || candidate.verification === 'size_and_range' ? <span><Check size={14} /> 已验证，可接续已有进度</span> : candidate.verification === 'mismatch' ? <span><TriangleAlert size={14} /> 已拒绝</span> : actionable.some((item) => item.candidate_id === candidate.candidate_id) && <button className="zhiqu-secondary" type="button" disabled={busy} onClick={() => void chooseCandidate(candidate.candidate_id)}><Play size={15} />继续原任务</button>}</div>)}</section>}{current.phase === 'completed' && <div className="zhiqu-success" role="status"><Check size={16} /><span>已找到可用来源，正在继续下载</span></div>}{error && <div className="zhiqu-error" role="alert"><TriangleAlert size={18} /><span>{error}</span></div>}</section></main>;
}
export function usePendingRecovery() {
  const [recovery, setRecovery] = useState<PendingRecoveryView | null>(null); const refresh = useCallback(async () => { try { const values = await zhiquService.listPendingRecoveries(); setRecovery(values[0] ?? null); } catch { setRecovery(null); } }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 2000); const onActivated = () => void refresh(); chrome.tabs.onActivated.addListener(onActivated); return () => { window.clearInterval(timer); chrome.tabs.onActivated.removeListener(onActivated); }; }, [refresh]);
  return { recovery, refresh };
}
function sameRecoveryPage(current: string, original: string): boolean { try { const left = new URL(current); const right = new URL(original); return left.origin === right.origin && left.pathname === right.pathname; } catch { return current === original; } }
async function sendContentMessage(tabId: number, message: Record<string, unknown>) { try { return await chrome.tabs.sendMessage(tabId, message); } catch (error) { const text = error instanceof Error ? error.message : String(error); if (!text.includes('Receiving end does not exist') && !text.includes('Could not establish connection')) throw error; await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); return chrome.tabs.sendMessage(tabId, message); } }
