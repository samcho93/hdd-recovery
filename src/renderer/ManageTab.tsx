import { useEffect, useState } from 'react';
import type { DiskInfo, FileSystemName, ManageOp } from '../shared/types';
import { ConfirmDialog, DiskMap, formatBytes, Modal } from './common';
import { api, useJobs } from './jobs';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const FAT32_WIN_LIMIT = 32 * GiB;

type PartitionInfo = DiskInfo['partitions'][number];

type Dialog =
  | { kind: 'format'; p: PartitionInfo }
  | { kind: 'delete'; p: PartitionInfo }
  | { kind: 'resize'; p: PartitionInfo }
  | { kind: 'split'; p: PartitionInfo }
  | { kind: 'merge'; left: PartitionInfo; right: PartitionInfo }
  | { kind: 'letter'; p: PartitionInfo }
  | { kind: 'label'; p: PartitionInfo }
  | { kind: 'create'; free: number }
  | { kind: 'table' };

function FsSelect({ value, onChange }: { value: FileSystemName; onChange: (v: FileSystemName) => void }): JSX.Element {
  return (
    <select id="fs" value={value} onChange={(e) => onChange(e.target.value as FileSystemName)}>
      <option value="NTFS">NTFS (Windows 권장)</option>
      <option value="exFAT">exFAT (다른 기기와 공유)</option>
      <option value="FAT32">FAT32 (파일당 4GB 제한)</option>
    </select>
  );
}

function largestFree(disk: DiskInfo): number {
  let pos = 0;
  let best = 0;
  for (const p of disk.partitions) {
    best = Math.max(best, p.offset - pos);
    pos = p.offset + p.size;
  }
  return Math.max(best, disk.size - pos - MiB);
}

export function ManageTab({ disk, onChanged }: { disk: DiskInfo; onChanged: () => void }): JSX.Element {
  const { run, toast } = useJobs();
  const [dlg, setDlg] = useState<Dialog | null>(null);
  const phrase = `DISK ${disk.number}`;
  const locked = disk.protected;

  const exec = async (op: ManageOp, typed: string, done: string): Promise<void> => {
    setDlg(null);
    const r = await run<{ copiedTo?: string; status?: string }>('디스크 작업', () => api().startManage(op, typed));
    if (r) {
      toast('ok', done + (r.copiedTo ? ` 파일은 ${r.copiedTo}에 있습니다.` : '') + (r.status ? ` 결과: ${r.status}` : ''));
    }
    onChanged();
  };

  const isRaw = disk.style === 'RAW';
  const freeSpace = isRaw ? 0 : largestFree(disk);
  const dataParts = disk.partitions.filter((p) => p.type !== 'Reserved');
  const rightOf = (p: PartitionInfo): PartitionInfo | undefined => {
    const i = disk.partitions.indexOf(p);
    return disk.partitions[i + 1];
  };

  return (
    <div className="stack">
      {locked && (
        <div className="notice danger">
          Windows 시스템 디스크(또는 페이지 파일이 있는 디스크)입니다. 실수로 시스템을 망가뜨리지 않도록 이 디스크의 변경 작업은 막아 두었습니다.
        </div>
      )}
      {disk.isOffline && (
        <div className="notice warn row">
          <span>디스크가 오프라인 상태입니다.</span>
          <span className="spacer" />
          <button className="btn small" onClick={() => void exec({ op: 'online', disk: disk.number, online: true }, '', '디스크를 온라인으로 전환했습니다.')}>
            온라인으로 전환
          </button>
        </div>
      )}

      <div className="panel">
        <h3>파티션 배치</h3>
        <DiskMap disk={disk} />
        <div className="row" style={{ marginTop: 10 }}>
          {isRaw ? (
            <>
              <span className="muted">파티션 테이블이 없습니다.</span>
              <span className="spacer" />
              <button className="btn primary" disabled={locked} onClick={() => setDlg({ kind: 'table' })}>
                디스크 초기화…
              </button>
            </>
          ) : (
            <>
              <span className="muted small">미할당 {formatBytes(Math.max(0, freeSpace))}</span>
              <span className="spacer" />
              <button className="btn" disabled={locked || freeSpace < 16 * MiB} onClick={() => setDlg({ kind: 'create', free: freeSpace })}>
                새 파티션…
              </button>
              <button className="btn danger" disabled={locked} onClick={() => setDlg({ kind: 'table' })}>
                파티션 테이블 새로 만들기…
              </button>
            </>
          )}
        </div>
      </div>

      {!isRaw && (
        <div className="panel">
          <h3>파티션</h3>
          {dataParts.length === 0 ? (
            <div className="empty">파티션이 없습니다. 새 파티션을 만들거나 복구 탭에서 잃어버린 파티션을 찾아보세요.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>드라이브</th>
                    <th>이름</th>
                    <th>파일시스템</th>
                    <th className="num">크기</th>
                    <th className="num">여유</th>
                    <th>작업</th>
                  </tr>
                </thead>
                <tbody>
                  {dataParts.map((p) => {
                    const right = rightOf(p);
                    const canMerge = !!right && right.type !== 'Reserved' && p.volume?.fileSystem === 'NTFS';
                    return (
                      <tr key={p.number}>
                        <td>{p.number}</td>
                        <td>{p.letter ? `${p.letter}:` : '-'}</td>
                        <td>{p.volume?.label || <span className="muted">{p.type}</span>}</td>
                        <td>{p.volume?.fileSystem || <span className="badge warn">RAW</span>}</td>
                        <td className="num">{formatBytes(p.size)}</td>
                        <td className="num">{p.volume ? formatBytes(p.volume.free) : '-'}</td>
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <button className="btn small" disabled={locked} onClick={() => setDlg({ kind: 'format', p })}>
                              포맷
                            </button>
                            <button className="btn small" disabled={locked || p.volume?.fileSystem !== 'NTFS'} onClick={() => setDlg({ kind: 'split', p })}>
                              분할
                            </button>
                            <button
                              className="btn small"
                              disabled={locked || !canMerge}
                              title={canMerge ? '오른쪽 파티션과 통합' : '바로 오른쪽 파티션이 있고 NTFS여야 합니다'}
                              onClick={() => right && setDlg({ kind: 'merge', left: p, right })}
                            >
                              통합
                            </button>
                            <button className="btn small" disabled={locked || p.volume?.fileSystem !== 'NTFS'} onClick={() => setDlg({ kind: 'resize', p })}>
                              크기
                            </button>
                            <button className="btn small" disabled={locked} onClick={() => setDlg({ kind: 'letter', p })}>
                              문자
                            </button>
                            <button className="btn small" disabled={!p.volume} onClick={() => setDlg({ kind: 'label', p })}>
                              이름
                            </button>
                            <button
                              className="btn small"
                              disabled={!p.volume}
                              onClick={() => void exec({ op: 'check', disk: disk.number, partition: p.number, fix: false }, '', '파일시스템 검사를 마쳤습니다.')}
                            >
                              검사
                            </button>
                            <button className="btn small danger" disabled={locked} onClick={() => setDlg({ kind: 'delete', p })}>
                              삭제
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {dlg?.kind === 'format' && (
        <FormatDialog
          p={dlg.p}
          phrase={phrase}
          onCancel={() => setDlg(null)}
          onSubmit={async (o, typed) => {
            if (o.fs === 'FAT32' && dlg.p.size > FAT32_WIN_LIMIT) {
              setDlg(null);
              await run('FAT32 포맷', () => api().startFat32Format(disk.number, dlg.p.number, o.label, typed));
              onChanged();
              return;
            }
            await exec(
              { op: 'format', disk: disk.number, partition: dlg.p.number, fs: o.fs, label: o.label, quick: o.quick },
              typed,
              '포맷을 마쳤습니다.',
            );
          }}
        />
      )}
      {dlg?.kind === 'delete' && (
        <ConfirmDialog
          title={`파티션 ${dlg.p.number} 삭제`}
          phrase={phrase}
          danger
          confirmLabel="파티션 삭제"
          onCancel={() => setDlg(null)}
          onConfirm={(t) => void exec({ op: 'delete', disk: disk.number, partition: dlg.p.number }, t, '파티션을 삭제했습니다.')}
        >
          <p style={{ marginTop: 0 }}>
            {dlg.p.letter ? `${dlg.p.letter}: 드라이브 ` : ''}({formatBytes(dlg.p.size)})의 파티션을 삭제합니다. 파일을 탐색기에서 볼 수 없게 됩니다.
          </p>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'resize' && <ResizeDialog disk={disk} p={dlg.p} phrase={phrase} onCancel={() => setDlg(null)} onSubmit={(size, t) => void exec({ op: 'resize', disk: disk.number, partition: dlg.p.number, size }, t, '크기를 변경했습니다.')} />}
      {dlg?.kind === 'split' && <SplitDialog disk={disk} p={dlg.p} phrase={phrase} onCancel={() => setDlg(null)} onSubmit={(firstSize, fs, label, t) => void exec({ op: 'split', disk: disk.number, partition: dlg.p.number, firstSize, fs, label }, t, '파티션을 분할했습니다.')} />}
      {dlg?.kind === 'merge' && (
        <MergeDialog
          left={dlg.left}
          right={dlg.right}
          phrase={phrase}
          onCancel={() => setDlg(null)}
          onSubmit={(preserve, t) =>
            void exec({ op: 'merge', disk: disk.number, left: dlg.left.number, right: dlg.right.number, preserve }, t, '파티션을 통합했습니다.')
          }
        />
      )}
      {dlg?.kind === 'letter' && (
        <TextDialog
          title="드라이브 문자 변경"
          label="드라이브 문자 (A~Z, 비우면 자동 할당)"
          initial={dlg.p.letter ?? ''}
          maxLength={1}
          onCancel={() => setDlg(null)}
          onSubmit={(v) => void exec({ op: 'letter', disk: disk.number, partition: dlg.p.number, letter: v }, '', '드라이브 문자를 변경했습니다.')}
        />
      )}
      {dlg?.kind === 'label' && (
        <TextDialog
          title="볼륨 이름 변경"
          label="볼륨 이름"
          initial={dlg.p.volume?.label ?? ''}
          maxLength={32}
          onCancel={() => setDlg(null)}
          onSubmit={(v) => void exec({ op: 'label', disk: disk.number, partition: dlg.p.number, label: v }, '', '볼륨 이름을 변경했습니다.')}
        />
      )}
      {dlg?.kind === 'create' && (
        <CreateDialog
          free={dlg.free}
          phrase={phrase}
          onCancel={() => setDlg(null)}
          onSubmit={(size, fs, label, quick, t) => void exec({ op: 'create', disk: disk.number, size, fs, label, quick }, t, '새 파티션을 만들었습니다.')}
        />
      )}
      {dlg?.kind === 'table' && (
        <TableDialog
          disk={disk}
          phrase={phrase}
          onCancel={() => setDlg(null)}
          onSubmit={(style, t) =>
            void exec(
              isRaw ? { op: 'initialize', disk: disk.number, style } : { op: 'wipe-table', disk: disk.number, style },
              t,
              '디스크를 초기화했습니다.',
            )
          }
        />
      )}
    </div>
  );
}

function FormatDialog({
  p,
  phrase,
  onCancel,
  onSubmit,
}: {
  p: PartitionInfo;
  phrase: string;
  onCancel: () => void;
  onSubmit: (o: { fs: FileSystemName; label: string; quick: boolean }, typed: string) => Promise<void>;
}): JSX.Element {
  const [fs, setFs] = useState<FileSystemName>('NTFS');
  const [label, setLabel] = useState(p.volume?.label ?? '');
  const [quick, setQuick] = useState(true);
  return (
    <ConfirmDialog
      title={`파티션 ${p.number} 포맷`}
      phrase={phrase}
      danger
      confirmLabel={quick ? '빠른 포맷' : '전체 포맷'}
      onCancel={onCancel}
      onConfirm={(t) => void onSubmit({ fs, label, quick }, t)}
    >
      <div className="field">
        <label htmlFor="fs">파일시스템</label>
        <FsSelect value={fs} onChange={setFs} />
      </div>
      <div className="field">
        <label htmlFor="label">볼륨 이름</label>
        <input id="label" type="text" maxLength={fs === 'FAT32' ? 11 : 32} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <label className="check" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={quick} onChange={(e) => setQuick(e.target.checked)} />
        빠른 포맷 (전체 포맷은 섹터를 검사하며 내용을 지워 복구가 불가능해지고, 큰 디스크는 몇 시간 걸립니다)
      </label>
      {fs === 'FAT32' && p.size > FAT32_WIN_LIMIT && (
        <div className="notice small" style={{ marginBottom: 8 }}>
          Windows는 32GB가 넘는 FAT32를 만들지 못해 이 앱의 자체 포맷터를 사용합니다(항상 빠른 포맷).
        </div>
      )}
      <div className="notice danger small">
        {p.letter ? `${p.letter}: ` : ''}
        {formatBytes(p.size)}의 모든 파일이 지워집니다.
      </div>
    </ConfirmDialog>
  );
}

function useRange(disk: DiskInfo, p: PartitionInfo): { min: number; max: number } | null | 'error' {
  const [range, setRange] = useState<{ min: number; max: number } | null | 'error'>(null);
  useEffect(() => {
    void api()
      .partitionRange(disk.number, p.number)
      .then(setRange)
      .catch(() => setRange('error'));
  }, [disk.number, p.number]);
  return range;
}

function ResizeDialog({
  disk,
  p,
  phrase,
  onCancel,
  onSubmit,
}: {
  disk: DiskInfo;
  p: PartitionInfo;
  phrase: string;
  onCancel: () => void;
  onSubmit: (size: number, typed: string) => void;
}): JSX.Element {
  const range = useRange(disk, p);
  const [mb, setMb] = useState(Math.floor(p.size / MiB));
  const r = range && range !== 'error' ? range : null;
  const size = mb * MiB;
  const valid = !!r && size >= r.min && size <= r.max && size !== p.size;
  return (
    <ConfirmDialog
      title={`파티션 ${p.number} 크기 변경`}
      phrase={phrase}
      danger
      confirmLabel="크기 변경"
      disabled={!valid}
      onCancel={onCancel}
      onConfirm={(t) => onSubmit(size, t)}
    >
      <div className="field">
        <label htmlFor="mb">새 크기 (MiB)</label>
        <input id="mb" type="number" value={mb} onChange={(e) => setMb(Number(e.target.value))} />
      </div>
      {range === null && <div className="muted small">가능한 크기를 계산하는 중…</div>}
      {range === 'error' && <div className="notice danger small">가능한 크기를 알 수 없습니다.</div>}
      {r && (
        <div className="muted small">
          가능한 범위: {Math.ceil(r.min / MiB).toLocaleString()} ~ {Math.floor(r.max / MiB).toLocaleString()} MiB
        </div>
      )}
    </ConfirmDialog>
  );
}

function SplitDialog({
  disk,
  p,
  phrase,
  onCancel,
  onSubmit,
}: {
  disk: DiskInfo;
  p: PartitionInfo;
  phrase: string;
  onCancel: () => void;
  onSubmit: (firstSize: number, fs: FileSystemName, label: string, typed: string) => void;
}): JSX.Element {
  const range = useRange(disk, p);
  const r = range && range !== 'error' ? range : null;
  const [mb, setMb] = useState(Math.floor(p.size / 2 / MiB));
  const [fs, setFs] = useState<FileSystemName>('NTFS');
  const [label, setLabel] = useState('');
  const size = mb * MiB;
  const valid = !!r && size >= r.min && size < p.size - 16 * MiB;
  return (
    <ConfirmDialog
      title={`파티션 ${p.number} 분할`}
      phrase={phrase}
      danger
      confirmLabel="분할"
      disabled={!valid}
      onCancel={onCancel}
      onConfirm={(t) => onSubmit(size, fs, label, t)}
    >
      <div className="field">
        <label htmlFor="mb">기존 파티션에 남길 크기 (MiB)</label>
        <input id="mb" type="number" value={mb} onChange={(e) => setMb(Number(e.target.value))} />
      </div>
      {r && <div className="muted small" style={{ marginBottom: 8 }}>데이터 때문에 최소 {Math.ceil(r.min / MiB).toLocaleString()} MiB가 필요합니다.</div>}
      {range === 'error' && <div className="notice danger small">축소 가능한 크기를 알 수 없습니다.</div>}
      <div className="muted small" style={{ marginBottom: 8 }}>
        새 파티션: {formatBytes(Math.max(0, p.size - size))}
      </div>
      <div className="field">
        <label htmlFor="fs">새 파티션 파일시스템</label>
        <FsSelect value={fs} onChange={setFs} />
      </div>
      <div className="field">
        <label htmlFor="label">새 파티션 이름</label>
        <input id="label" type="text" maxLength={32} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="notice small">기존 파일은 유지되지만, 작업 전에 중요한 데이터를 백업하는 것이 안전합니다.</div>
    </ConfirmDialog>
  );
}

function MergeDialog({
  left,
  right,
  phrase,
  onCancel,
  onSubmit,
}: {
  left: PartitionInfo;
  right: PartitionInfo;
  phrase: string;
  onCancel: () => void;
  onSubmit: (preserve: boolean, typed: string) => void;
}): JSX.Element {
  const canPreserve = !!left.letter && !!right.letter && !!right.volume;
  const [preserve, setPreserve] = useState(canPreserve);
  return (
    <ConfirmDialog
      title="파티션 통합"
      phrase={phrase}
      danger
      confirmLabel="통합"
      onCancel={onCancel}
      onConfirm={(t) => onSubmit(preserve, t)}
    >
      <p style={{ marginTop: 0 }}>
        파티션 {right.number}
        {right.letter ? ` (${right.letter}:)` : ''}를 지우고 파티션 {left.number}
        {left.letter ? ` (${left.letter}:)` : ''}를 {formatBytes(left.size + right.size)}로 확장합니다.
      </p>
      <label className="check" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={preserve} disabled={!canPreserve} onChange={(e) => setPreserve(e.target.checked)} />
        오른쪽 파티션의 파일을 왼쪽 파티션의 폴더로 먼저 옮기기
      </label>
      {!preserve && (
        <div className="notice danger small">
          파티션 {right.number}의 모든 파일이 지워집니다.
          {!canPreserve && ' 파일을 옮기려면 두 파티션 모두 드라이브 문자가 필요합니다.'}
        </div>
      )}
      {preserve && <div className="notice small">복사에 실패하면 어떤 파티션도 지우지 않고 작업을 멈춥니다.</div>}
    </ConfirmDialog>
  );
}

function CreateDialog({
  free,
  phrase,
  onCancel,
  onSubmit,
}: {
  free: number;
  phrase: string;
  onCancel: () => void;
  onSubmit: (size: number | undefined, fs: FileSystemName, label: string, quick: boolean, typed: string) => void;
}): JSX.Element {
  const maxMb = Math.floor(free / MiB);
  const [mb, setMb] = useState(maxMb);
  const [fs, setFs] = useState<FileSystemName>('NTFS');
  const [label, setLabel] = useState('');
  const useMax = mb >= maxMb;
  const valid = mb >= 16 && mb <= maxMb;
  return (
    <ConfirmDialog
      title="새 파티션"
      phrase={phrase}
      confirmLabel="만들기"
      disabled={!valid}
      onCancel={onCancel}
      onConfirm={(t) => onSubmit(useMax ? undefined : mb * MiB, fs, label, true, t)}
    >
      <div className="field">
        <label htmlFor="mb">크기 (MiB, 최대 {maxMb.toLocaleString()})</label>
        <input id="mb" type="number" value={mb} onChange={(e) => setMb(Number(e.target.value))} />
      </div>
      <div className="field">
        <label htmlFor="fs">파일시스템</label>
        <FsSelect value={fs} onChange={setFs} />
      </div>
      <div className="field">
        <label htmlFor="label">볼륨 이름</label>
        <input id="label" type="text" maxLength={32} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}

function TableDialog({
  disk,
  phrase,
  onCancel,
  onSubmit,
}: {
  disk: DiskInfo;
  phrase: string;
  onCancel: () => void;
  onSubmit: (style: 'GPT' | 'MBR', typed: string) => void;
}): JSX.Element {
  const [style, setStyle] = useState<'GPT' | 'MBR'>('GPT');
  const isRaw = disk.style === 'RAW';
  return (
    <ConfirmDialog
      title={isRaw ? '디스크 초기화' : '파티션 테이블 새로 만들기'}
      phrase={phrase}
      danger
      confirmLabel={isRaw ? '초기화' : '모두 지우고 새로 만들기'}
      onCancel={onCancel}
      onConfirm={(t) => onSubmit(style, t)}
    >
      <div className="field">
        <label htmlFor="style">파티션 형식</label>
        <select id="style" value={style} onChange={(e) => setStyle(e.target.value as 'GPT' | 'MBR')}>
          <option value="GPT">GPT (권장, 2TB 초과 지원)</option>
          <option value="MBR" disabled={disk.size > 2 * 1024 ** 4}>
            MBR (구형 시스템 호환)
          </option>
        </select>
      </div>
      <div className="notice danger small">
        {isRaw
          ? '파일시스템이 깨져 있어 RAW로 보이는 디스크일 수 있습니다. 데이터가 필요하다면 초기화 전에 복구 탭에서 먼저 꺼내세요.'
          : `이 디스크(${formatBytes(disk.size)})의 모든 파티션이 사라집니다.`}
      </div>
    </ConfirmDialog>
  );
}

function TextDialog({
  title,
  label,
  initial,
  maxLength,
  onCancel,
  onSubmit,
}: {
  title: string;
  label: string;
  initial: string;
  maxLength: number;
  onCancel: () => void;
  onSubmit: (v: string) => void;
}): JSX.Element {
  const [v, setV] = useState(initial);
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="field">
        <label htmlFor="text-input">{label}</label>
        <input id="text-input" type="text" autoFocus maxLength={maxLength} value={v} onChange={(e) => setV(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onCancel}>
          취소
        </button>
        <button className="btn primary" onClick={() => onSubmit(v)}>
          적용
        </button>
      </div>
    </Modal>
  );
}
