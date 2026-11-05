import { useCallback, useEffect, useState } from 'react';
import type { DiagnoseResult, JournalInfo, RepairAction, Target } from '../shared/types';
import { ConfirmDialog, formatBytes, formatDate, phraseFor, SOURCE_LABEL, VolumeStatus } from './common';
import { api, useJobs } from './jobs';

export function RepairTab({ target, locked, onChanged }: { target: Target; locked: boolean; onChanged: () => void }): JSX.Element {
  const { run, toast } = useJobs();
  const [diag, setDiag] = useState<DiagnoseResult | null>(null);
  const [journals, setJournals] = useState<JournalInfo[]>([]);
  const [pending, setPending] = useState<RepairAction | null>(null);
  const [undoing, setUndoing] = useState<JournalInfo | null>(null);

  const targetId = target.kind === 'disk' ? `disk:${target.number}` : `image:`;
  const loadJournals = useCallback(async () => {
    const all = await api().listJournals();
    setJournals(all.filter((j) => (target.kind === 'disk' ? j.target === targetId : j.target.startsWith('image:'))));
  }, [target.kind, targetId]);

  useEffect(() => {
    void loadJournals();
  }, [loadJournals]);

  const runDiagnose = async (deep: boolean): Promise<void> => {
    const r = await run<DiagnoseResult>(deep ? '정밀 진단' : '빠른 진단', () => api().startDiagnose(target, deep));
    if (r) setDiag(r);
  };

  const apply = async (a: RepairAction, typed: string): Promise<void> => {
    setPending(null);
    if (!diag) return;
    const r = await run<JournalInfo>(a.title, () => api().startRepair(target, diag.diagnosisId, a.id, typed));
    if (r) {
      toast('ok', `복원했습니다: ${a.title}`);
      setDiag(null);
      await loadJournals();
      onChanged();
      await runDiagnose(false);
    }
  };

  const undo = async (j: JournalInfo, typed: string): Promise<void> => {
    setUndoing(null);
    const r = await run('되돌리기', () => api().startUndo(target, j.id, typed));
    if (r) {
      toast('ok', '이전 상태로 되돌렸습니다.');
      setDiag(null);
      await loadJournals();
      onChanged();
    }
  };

  return (
    <div className="stack">
      <div className="panel">
        <h3>파일시스템 구조 진단</h3>
        <div className="row">
          <button className="btn primary" onClick={() => void runDiagnose(false)}>
            빠른 진단
          </button>
          <button className="btn" onClick={() => void runDiagnose(true)}>
            정밀 진단
          </button>
          <span className="muted small">진단은 읽기만 합니다. 복원은 항목을 직접 선택해야 실행됩니다.</span>
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          중요한 데이터가 있다면 복원 전에 <strong>복구</strong> 탭에서 파일을 먼저 꺼내 두세요. 복원은 부트 섹터·파티션 테이블·FAT만 고치며, 원래 내용은 저널에 남겨 되돌릴 수 있습니다.
        </div>
      </div>

      {locked && (
        <div className="notice warn">Windows가 실행 중이거나 페이지 파일이 있는 디스크입니다. 진단은 가능하지만 복원은 할 수 없습니다.</div>
      )}

      {diag && (
        <>
          <div className={`notice ${diag.healthy ? 'ok' : 'warn'}`}>
            {diag.healthy ? '구조에서 문제를 찾지 못했습니다.' : `발견한 문제 ${diag.findings.length}건, 복원 가능한 항목 ${diag.actions.length}건`}
            {diag.findings.length > 0 && (
              <ul>
                {diag.findings.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            {!diag.healthy && diag.actions.length === 0 && (
              <div style={{ marginTop: 4 }}>자동으로 복원할 수 있는 항목이 없습니다. 정밀 진단을 실행하거나 복구 탭에서 파일을 꺼내세요.</div>
            )}
            {diag.badSectors > 0 && <div style={{ marginTop: 4 }}>읽지 못한 섹터 {diag.badSectors.toLocaleString()}개가 있습니다.</div>}
          </div>

          {diag.actions.length > 0 && (
            <div className="panel">
              <h3>복원 항목</h3>
              {diag.actions.map((a) => (
                <div className="action-card" key={a.id}>
                  <div className="body">
                    <div className="title">
                      {a.title} {a.recommended && <span className="badge ok">권장</span>}{' '}
                      {a.risk === 'medium' && <span className="badge warn">주의</span>}
                    </div>
                    <div className="muted small">{a.detail}</div>
                    <div className="muted small mono" style={{ marginTop: 4 }}>
                      {a.regions.map((r) => `${r.description}: ${r.offset.toLocaleString()} (+${formatBytes(r.length)})`).join(' · ')}
                    </div>
                  </div>
                  <button className="btn" disabled={locked} onClick={() => setPending(a)}>
                    복원
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="panel">
            <h3>
              볼륨 <span className="muted">(테이블: {diag.table.style.toUpperCase()})</span>
            </h3>
            {diag.volumes.length === 0 ? (
              <div className="empty">볼륨을 찾지 못했습니다.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>파일시스템</th>
                    <th className="num">시작 위치</th>
                    <th className="num">크기</th>
                    <th>찾은 방법</th>
                    <th>백업 부트</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {diag.volumes.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <strong>{v.fsType === 'unknown' ? '알 수 없음' : v.fsType}</strong>
                      </td>
                      <td className="num mono">{formatBytes(v.offset)}</td>
                      <td className="num">{formatBytes(v.size)}</td>
                      <td>{SOURCE_LABEL[v.source]}</td>
                      <td>{v.backupOk === null ? '-' : v.backupOk ? '정상' : '손상'}</td>
                      <td>
                        <VolumeStatus v={v} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <div className="panel">
        <h3>복원 기록</h3>
        {journals.length === 0 ? (
          <div className="muted small">이 대상에서 실행한 복원이 없습니다.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>시각</th>
                <th>내용</th>
                <th className="num">영역</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {journals.map((j) => (
                <tr key={j.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDate(j.createdAt)}</td>
                  <td>{j.title}</td>
                  <td className="num">{j.writes.length}</td>
                  <td style={{ textAlign: 'right' }}>
                    {j.undone ? (
                      <span className="badge">되돌림</span>
                    ) : (
                      <button className="btn small" disabled={locked} onClick={() => setUndoing(j)}>
                        되돌리기
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pending && (
        <ConfirmDialog
          title={pending.title}
          phrase={phraseFor(target)}
          confirmLabel="복원 실행"
          onCancel={() => setPending(null)}
          onConfirm={(t) => void apply(pending, t)}
        >
          <p style={{ marginTop: 0 }}>{pending.detail}</p>
          {target.kind === 'disk' && (
            <p className="muted small">쓰는 동안 디스크를 잠시 오프라인으로 전환합니다. 이 디스크를 쓰는 프로그램을 닫아 주세요.</p>
          )}
        </ConfirmDialog>
      )}
      {undoing && (
        <ConfirmDialog
          title="복원 되돌리기"
          phrase={phraseFor(target)}
          danger
          confirmLabel="되돌리기"
          onCancel={() => setUndoing(null)}
          onConfirm={(t) => void undo(undoing, t)}
        >
          <p style={{ marginTop: 0 }}>
            “{undoing.title}”을(를) 실행하기 전의 내용으로 되돌립니다. 그 뒤로 이 영역을 다시 바꿨다면 그 변경은 사라집니다.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
