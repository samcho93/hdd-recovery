import { useState, type ReactNode } from 'react';
import { formatBytes } from '../engine/bytes';
import type { DiskInfo, FoundVolume, Target } from '../shared/types';

export { formatBytes };

export function fsClass(fs: string | undefined): string {
  if (!fs) return '';
  if (fs === 'NTFS') return 'ntfs';
  if (fs === 'exFAT') return 'exfat';
  if (fs.startsWith('FAT')) return 'fat';
  return '';
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 디스크 대상별 쓰기 확인 문구 */
export function phraseFor(target: Target): string {
  return target.kind === 'disk' ? `DISK ${target.number}` : 'IMAGE';
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }): JSX.Element {
  return (
    <div
      className="modal-back"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose?.();
      }}
    >
      <div className="modal">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/**
 * 되돌리기 어려운 작업의 확인 창. 사용자가 대상 디스크 문구를 직접 입력해야 진행된다.
 */
export function ConfirmDialog(props: {
  title: string;
  phrase: string;
  danger?: boolean;
  confirmLabel: string;
  children: ReactNode;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
  disabled?: boolean;
}): JSX.Element {
  const [typed, setTyped] = useState('');
  return (
    <Modal title={props.title} onClose={props.onCancel}>
      <div className="stack" style={{ gap: 10 }}>
        <div>{props.children}</div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="confirm-input">
            계속하려면 <strong className="mono">{props.phrase}</strong> 를 그대로 입력하세요.
          </label>
          <input
            id="confirm-input"
            type="text"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={props.onCancel}>
            취소
          </button>
          <button
            className={`btn ${props.danger ? 'danger-fill' : 'primary'}`}
            disabled={typed !== props.phrase || props.disabled}
            onClick={() => props.onConfirm(typed)}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function DiskMap({ disk }: { disk: DiskInfo }): JSX.Element {
  const segs: { key: string; size: number; cls: string; label: string; title: string }[] = [];
  let pos = 0;
  const minGap = 16 * 1024 * 1024;
  for (const p of disk.partitions) {
    if (p.offset - pos > minGap) {
      const gap = p.offset - pos;
      segs.push({ key: `gap-${pos}`, size: gap, cls: 'free', label: formatBytes(gap), title: `미할당 ${formatBytes(gap)}` });
    }
    const fs = p.volume?.fileSystem;
    const name = p.letter ? `${p.letter}:` : (p.type || '');
    segs.push({
      key: `p-${p.number}`,
      size: p.size,
      cls: fsClass(fs),
      label: `${name} ${fs || 'RAW'}`,
      title: `파티션 ${p.number}: ${p.type} ${fs ?? ''} ${formatBytes(p.size)}`,
    });
    pos = p.offset + p.size;
  }
  if (disk.size - pos > minGap) {
    segs.push({ key: 'gap-end', size: disk.size - pos, cls: 'free', label: `미할당 ${formatBytes(disk.size - pos)}`, title: '미할당 공간' });
  }
  if (!segs.length) return <div className="diskmap" />;
  return (
    <div className="diskmap" role="img" aria-label="디스크 파티션 배치">
      {segs.map((s) => (
        <div key={s.key} className={`seg ${s.cls}`} style={{ flexGrow: s.size, flexBasis: 0 }} title={s.title}>
          {s.label}
        </div>
      ))}
    </div>
  );
}

export function VolumeStatus({ v }: { v: FoundVolume }): JSX.Element {
  if (v.fsType === 'unknown') return <span className="badge danger">식별 불가</span>;
  if (!v.recoverable) return <span className="badge warn">식별만 가능</span>;
  if (!v.inTable && v.offset > 0) return <span className="badge warn">테이블에 없음</span>;
  if (!v.bootOk) return <span className="badge danger">부트 손상</span>;
  if (v.backupOk === false) return <span className="badge warn">백업 손상</span>;
  return <span className="badge ok">정상</span>;
}

export const SOURCE_LABEL: Record<FoundVolume['source'], string> = {
  table: '파티션 테이블',
  boot: '부트 섹터',
  'backup-boot': '백업 부트 섹터',
  mft: '$MFT 역산',
  empty: '-',
};
