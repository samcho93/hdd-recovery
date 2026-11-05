import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppInfo, DiskInfo, Target } from '../shared/types';
import { DiskMap, formatBytes } from './common';
import { api, JobBar, JobsProvider, stripIpc, useJobs } from './jobs';
import { ManageTab } from './ManageTab';
import { RecoverTab } from './RecoverTab';
import { RepairTab } from './RepairTab';

type TabId = 'overview' | 'recover' | 'repair' | 'manage' | 'image';

function healthBadge(d: DiskInfo): JSX.Element {
  if (d.health === 'Healthy') return <span className="badge ok">정상</span>;
  if (d.health === 'Warning') return <span className="badge warn">주의</span>;
  if (d.health === 'Unhealthy') return <span className="badge danger">위험</span>;
  return <span className="badge">{d.health || '알 수 없음'}</span>;
}

function isFailing(d: DiskInfo): boolean {
  return d.health !== 'Healthy' || (d.smart?.readErrors ?? 0) > 0;
}

function hasBrokenVolume(d: DiskInfo): boolean {
  return d.style === 'RAW' || d.partitions.some((p) => p.type === 'Basic' && (!p.volume || !p.volume.fileSystem || p.volume.fileSystem === 'RAW'));
}

function Overview({ disk, go }: { disk: DiskInfo; go: (t: TabId) => void }): JSX.Element {
  const broken = hasBrokenVolume(disk);
  return (
    <div className="stack">
      {broken && !disk.protected && (
        <div className="notice warn row">
          <span>
            {disk.style === 'RAW'
              ? 'Windows가 이 디스크에서 파티션 테이블을 읽지 못합니다. 데이터를 지키려면 Windows의 초기화 제안을 수락하지 마세요.'
              : '파일시스템을 읽지 못하는 파티션이 있습니다. Windows의 포맷 제안을 수락하지 마세요.'}
          </span>
          <span className="spacer" />
          <button className="btn small primary" onClick={() => go('recover')}>
            데이터 복구 시작
          </button>
        </div>
      )}
      <div className="panel">
        <h3>파티션 배치</h3>
        <DiskMap disk={disk} />
        {disk.partitions.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>드라이브</th>
                  <th>이름</th>
                  <th>파일시스템</th>
                  <th>유형</th>
                  <th className="num">크기</th>
                  <th className="num">사용</th>
                </tr>
              </thead>
              <tbody>
                {disk.partitions.map((p) => (
                  <tr key={p.number}>
                    <td>{p.number}</td>
                    <td>{p.letter ? `${p.letter}:` : '-'}</td>
                    <td>{p.volume?.label || '-'}</td>
                    <td>{p.volume?.fileSystem || (p.type === 'Basic' ? <span className="badge warn">RAW</span> : '-')}</td>
                    <td className="muted">{p.type}</td>
                    <td className="num">{formatBytes(p.size)}</td>
                    <td className="num">{p.volume ? formatBytes(p.volume.size - p.volume.free) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="panel">
        <h3>디스크 정보</h3>
        <div className="kv">
          <div>
            <div className="k">모델</div>
            <div className="v">{disk.name}</div>
          </div>
          <div>
            <div className="k">일련번호</div>
            <div className="v mono">{disk.serial || '-'}</div>
          </div>
          <div>
            <div className="k">연결 / 종류</div>
            <div className="v">
              {disk.busType} / {disk.mediaType}
            </div>
          </div>
          <div>
            <div className="k">섹터 크기</div>
            <div className="v">
              논리 {disk.sectorSize} / 물리 {disk.physicalSectorSize}
            </div>
          </div>
          <div>
            <div className="k">파티션 형식</div>
            <div className="v">{disk.style}</div>
          </div>
          <div>
            <div className="k">상태</div>
            <div className="v">{healthBadge(disk)}</div>
          </div>
          <div>
            <div className="k">온도</div>
            <div className="v">{disk.smart?.temperature ? `${disk.smart.temperature}°C` : '-'}</div>
          </div>
          <div>
            <div className="k">사용 시간</div>
            <div className="v">{disk.smart?.powerOnHours ? `${disk.smart.powerOnHours.toLocaleString()}시간` : '-'}</div>
          </div>
          <div>
            <div className="k">읽기 오류</div>
            <div className="v">{disk.smart?.readErrors ?? '-'}</div>
          </div>
          <div>
            <div className="k">쓰기 오류</div>
            <div className="v">{disk.smart?.writeErrors ?? '-'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImageTab({ target, name }: { target: Target; name: string }): JSX.Element {
  const { run, toast } = useJobs();
  const [result, setResult] = useState<{ bytes: number; badSectors: number; mapPath: string; dest: string } | null>(null);
  const start = async (): Promise<void> => {
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = await api().pickSaveImage(`${name.replace(/[^\w가-힣-]+/g, '_')}-${stamp}.img`);
    if (!dest) return;
    const r = await run<{ bytes: number; badSectors: number; mapPath: string }>('디스크 이미지 생성', () => api().startImaging(target, dest));
    if (r) {
      setResult({ ...r, dest });
      toast(r.badSectors ? 'info' : 'ok', '이미지를 만들었습니다.');
    }
  };
  return (
    <div className="stack">
      <div className="panel">
        <h3>디스크 이미지 만들기</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          디스크 전체를 파일 하나로 복제합니다. 고장 중인 디스크는 읽을수록 나빠질 수 있으니 이미지를 먼저 만들고, 만든 이미지를 왼쪽 아래 <strong>이미지 파일 열기</strong>로 불러와 복구하면 원본에 부담을 주지 않습니다.
        </p>
        <button className="btn primary" onClick={() => void start()}>
          저장 위치 선택 후 시작
        </button>
        <div className="muted small" style={{ marginTop: 8 }}>
          디스크 크기만큼의 여유 공간이 다른 디스크에 필요합니다. 읽지 못한 섹터는 0으로 채우고 위치를 함께 기록합니다.
        </div>
      </div>
      {result && (
        <div className={`notice ${result.badSectors ? 'warn' : 'ok'}`}>
          {formatBytes(result.bytes)} 복제 완료. 읽지 못한 섹터 {result.badSectors.toLocaleString()}개.
          <div className="mono small">{result.dest}</div>
          <div className="mono small">{result.mapPath}</div>
        </div>
      )}
    </div>
  );
}

function App(): JSX.Element {
  const { toast } = useJobs();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [disks, setDisks] = useState<DiskInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [sel, setSel] = useState<Target | null>(null);
  const [tab, setTab] = useState<TabId>('overview');

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      setDisks(await api().listDisks());
    } catch (e) {
      setLoadError(stripIpc((e as Error).message));
    }
  }, []);

  useEffect(() => {
    void api().appInfo().then(setInfo);
    void refresh();
  }, [refresh]);

  const selDisk = useMemo(
    () => (sel?.kind === 'disk' ? (disks?.find((d) => d.number === sel.number) ?? null) : null),
    [sel, disks],
  );

  useEffect(() => {
    if (sel === null && disks?.length) {
      // 복구가 필요해 보이는 디스크를 먼저, 아니면 시스템이 아닌 첫 디스크를 고른다.
      const pick = disks.find((d) => !d.protected && hasBrokenVolume(d)) ?? disks.find((d) => !d.protected) ?? disks[0];
      setSel({ kind: 'disk', number: pick.number });
    }
  }, [disks, sel]);

  const openImage = async (): Promise<void> => {
    const p = await api().pickImage();
    if (!p) return;
    setImages((l) => (l.includes(p) ? l : [...l, p]));
    setSel({ kind: 'image', path: p });
    setTab('recover');
    toast('info', '이미지를 열었습니다.');
  };

  const isImage = sel?.kind === 'image';
  const tabs: { id: TabId; label: string }[] = isImage
    ? [
        { id: 'recover', label: '복구' },
        { id: 'repair', label: '구조 복원' },
      ]
    : [
        { id: 'overview', label: '개요' },
        { id: 'recover', label: '복구' },
        { id: 'repair', label: '구조 복원' },
        { id: 'manage', label: '디스크 관리' },
        { id: 'image', label: '이미지' },
      ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const key = sel ? (sel.kind === 'disk' ? `d${sel.number}` : `i${sel.path}`) : 'none';

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1>HDD Recovery</h1>
          <button className="btn small" onClick={() => void refresh()}>
            새로 고침
          </button>
        </div>
        <div className="disk-list">
          {disks === null && !loadError && <div className="empty">디스크를 읽는 중…</div>}
          {loadError && <div className="notice danger small">{loadError}</div>}
          {disks?.map((d) => (
            <button
              key={d.number}
              className={`disk-item ${sel?.kind === 'disk' && sel.number === d.number ? 'active' : ''}`}
              onClick={() => setSel({ kind: 'disk', number: d.number })}
            >
              <div className="name">
                <span>디스크 {d.number}</span>
                <span title={d.name}>{d.name}</span>
              </div>
              <div className="sub">
                <span>{formatBytes(d.size)}</span>
                <span>{d.style}</span>
                {healthBadge(d)}
                {d.protected && <span className="badge">시스템</span>}
                {hasBrokenVolume(d) && !d.protected && <span className="badge warn">손상 의심</span>}
                {d.isOffline && <span className="badge warn">오프라인</span>}
              </div>
            </button>
          ))}
          {images.map((p) => (
            <button
              key={p}
              className={`disk-item ${sel?.kind === 'image' && sel.path === p ? 'active' : ''}`}
              onClick={() => setSel({ kind: 'image', path: p })}
            >
              <div className="name">
                <span>이미지</span>
                <span title={p}>{p.split(/[\\/]/).pop()}</span>
              </div>
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          <button className="btn" style={{ width: '100%' }} onClick={() => void openImage()}>
            이미지 파일 열기…
          </button>
          <div className="muted small" style={{ marginTop: 6 }}>
            버전 {info?.version ?? '-'}
          </div>
        </div>
      </aside>

      <main className="main">
        {info && !info.elevated && (
          <div className="notice danger row" style={{ borderRadius: 0 }}>
            <span>관리자 권한이 없어 디스크를 직접 읽을 수 없습니다.</span>
            <span className="spacer" />
            <button className="btn small" onClick={() => void api().relaunchAsAdmin()}>
              관리자 권한으로 다시 실행
            </button>
          </div>
        )}
        <div className="page-head">
          <h2>{sel?.kind === 'image' ? sel.path.split(/[\\/]/).pop() : selDisk ? `디스크 ${selDisk.number}: ${selDisk.name}` : '디스크를 선택하세요'}</h2>
          <div className="meta">
            {selDisk && (
              <>
                <span>{formatBytes(selDisk.size)}</span>
                <span>{selDisk.style}</span>
                <span>{selDisk.busType}</span>
              </>
            )}
            {sel?.kind === 'image' && <span className="mono small">{sel.path}</span>}
            {!sel && <span>&nbsp;</span>}
          </div>
          {sel && (
            <div className="tabs" role="tablist">
              {tabs.map((t) => (
                <button key={t.id} role="tab" aria-selected={activeTab === t.id} className={`tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="content">
          {sel && (
            <div key={key}>
              {selDisk && (
                <div hidden={activeTab !== 'overview'}>
                  <Overview disk={selDisk} go={setTab} />
                </div>
              )}
              <div hidden={activeTab !== 'recover'}>
                <RecoverTab target={sel} failing={!!selDisk && isFailing(selDisk)} />
              </div>
              <div hidden={activeTab !== 'repair'}>
                <RepairTab target={sel} locked={!!selDisk?.protected} onChanged={() => void refresh()} />
              </div>
              {selDisk && (
                <div hidden={activeTab !== 'manage'}>
                  <ManageTab disk={selDisk} onChanged={() => void refresh()} />
                </div>
              )}
              {selDisk && (
                <div hidden={activeTab !== 'image'}>
                  <ImageTab target={sel} name={selDisk.name} />
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      <JobBar />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <JobsProvider>
    <App />
  </JobsProvider>,
);
