import { useCallback, useEffect, useRef, useState } from 'react';
import type { FoundVolume, ListResult, OpenVolumeResult, RecoverReport, ScanJobResult, Target } from '../shared/types';
import { formatBytes, formatDate, SOURCE_LABEL, VolumeStatus } from './common';
import { api, stripIpc, useJobs } from './jobs';

const PAGE = 500;

function Browser({
  session,
  target,
  onClose,
}: {
  session: OpenVolumeResult;
  target: Target;
  onClose: () => void;
}): JSX.Element {
  const { run, toast } = useJobs();
  const [dirId, setDirId] = useState(0);
  const [search, setSearch] = useState('');
  const [deletedOnly, setDeletedOnly] = useState(false);
  const [data, setData] = useState<ListResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lastReport, setLastReport] = useState<RecoverReport | null>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (offset = 0) => {
      const id = ++reqId.current;
      try {
        const res = await api().listEntries({
          sessionId: session.sessionId,
          dirId,
          search: search || undefined,
          showDeletedOnly: deletedOnly,
          limit: PAGE,
          offset,
        });
        if (id !== reqId.current) return;
        setData((prev) => (offset > 0 && prev ? { ...res, entries: [...prev.entries, ...res.entries] } : res));
      } catch (e) {
        toast('error', stripIpc((e as Error).message));
      }
    },
    [session.sessionId, dirId, search, deletedOnly, toast],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(0), search ? 200 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const toggle = (id: number): void => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const recover = async (ids: number[]): Promise<void> => {
    const dest = await api().pickFolder();
    if (!dest) return;
    const rep = await run<RecoverReport>('파일 복구', () => api().startRecover(session.sessionId, ids, dest));
    if (rep) {
      setLastReport(rep);
      toast(rep.filesFailed ? 'error' : 'ok', `파일 ${rep.filesRecovered.toLocaleString()}개 복구, ${rep.filesFailed}개 실패`);
    }
  };

  const allShownIds = data?.entries.map((e) => e.id) ?? [];
  const allChecked = allShownIds.length > 0 && allShownIds.every((i) => selected.has(i));

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>
          {session.fsType} 파일 목록
        </h3>
        <span className="muted small">
          파일 {session.files.toLocaleString()}개 · 폴더 {session.dirs.toLocaleString()}개 · 삭제 항목 {session.deleted.toLocaleString()}개 ·{' '}
          {formatBytes(session.totalBytes)}
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={onClose}>
          닫기
        </button>
      </div>

      {session.warnings.length > 0 && (
        <div className="notice warn small" style={{ marginBottom: 8 }}>
          <ul style={{ margin: 0 }}>
            {session.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="row" style={{ marginBottom: 8 }}>
        <button
          className="btn small"
          disabled={!data || data.parentId === null || !!search}
          onClick={() => data?.parentId !== null && data && setDirId(data.parentId)}
        >
          ↑ 상위
        </button>
        <span className="crumbs" title={data?.path}>
          \{data?.path}
        </span>
        <span className="spacer" />
        <label className="check small">
          <input type="checkbox" checked={deletedOnly} onChange={(e) => setDeletedOnly(e.target.checked)} />
          삭제 항목만
        </label>
        <input
          type="text"
          placeholder="파일 이름 검색"
          aria-label="파일 이름 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input
                  type="checkbox"
                  aria-label="모두 선택"
                  checked={allChecked}
                  onChange={() =>
                    setSelected((s) => {
                      const n = new Set(s);
                      for (const i of allShownIds) {
                        if (allChecked) n.delete(i);
                        else n.add(i);
                      }
                      return n;
                    })
                  }
                />
              </th>
              <th>이름</th>
              <th className="num">크기</th>
              <th>수정한 날짜</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {data?.entries.map((e) => (
              <tr key={e.id} className={e.deleted ? 'deleted' : ''}>
                <td>
                  <input type="checkbox" aria-label={`${e.name} 선택`} checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                </td>
                <td className="name" title={e.path ?? e.name}>
                  {e.isDir ? (
                    <button
                      className="link"
                      onClick={() => {
                        setSearch('');
                        setDirId(e.id);
                      }}
                    >
                      📁 {e.path ?? e.name}
                    </button>
                  ) : (
                    <>📄 {e.path ?? e.name}</>
                  )}
                </td>
                <td className="num">{e.isDir ? `${e.childCount ?? 0}개` : formatBytes(e.size)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{formatDate(e.mtime)}</td>
                <td>
                  {e.deleted && <span className="badge warn">삭제됨</span>} {e.flags & 1 ? <span className="badge">압축</span> : null}{' '}
                  {e.flags & 2 ? <span className="badge danger">암호화</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.entries.length === 0 && <div className="empty">표시할 항목이 없습니다.</div>}
      </div>
      {data && data.entries.length < data.total && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
          <button className="btn small" onClick={() => void load(data.entries.length)}>
            더 보기 ({(data.total - data.entries.length).toLocaleString()}개 남음)
          </button>
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <span className="muted small">{selected.size.toLocaleString()}개 선택</span>
        <span className="spacer" />
        <button className="btn" onClick={() => void recover([0])}>
          전체 복구
        </button>
        <button className="btn primary" disabled={selected.size === 0} onClick={() => void recover([...selected])}>
          선택 항목 복구
        </button>
      </div>
      {target.kind === 'disk' && (
        <div className="muted small" style={{ marginTop: 6 }}>
          복구한 파일은 다른 디스크에 저장해야 합니다. 같은 디스크로는 저장할 수 없습니다.
        </div>
      )}

      {lastReport && (
        <div className={`notice ${lastReport.filesFailed ? 'warn' : 'ok'}`} style={{ marginTop: 10 }}>
          <div>
            {lastReport.cancelled ? '복구를 중간에 취소했습니다. ' : ''}
            {lastReport.filesRecovered.toLocaleString()}개 복구 ({formatBytes(lastReport.bytes)}), 실패 {lastReport.filesFailed}개, 주의{' '}
            {lastReport.warnings.length}개
          </div>
          <div className="row small" style={{ marginTop: 4 }}>
            <span className="mono">{lastReport.destination}</span>
            <button className="btn small" onClick={() => void api().openPath(lastReport.destination)}>
              폴더 열기
            </button>
          </div>
          {lastReport.warnings.length > 0 && (
            <ul className="small">
              {lastReport.warnings.slice(0, 8).map((w) => (
                <li key={w.path}>
                  {w.path}: {w.messages[0]}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function RecoverTab({ target, failing }: { target: Target; failing: boolean }): JSX.Element {
  const { run } = useJobs();
  const [scan, setScan] = useState<ScanJobResult | null>(null);
  const [session, setSession] = useState<OpenVolumeResult | null>(null);
  const [carveTypes, setCarveTypes] = useState<{ label: string; group: string }[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [showCarve, setShowCarve] = useState(false);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    void api()
      .carveTypes()
      .then((t) => {
        setCarveTypes(t);
        setChosen(new Set(t.map((x) => x.label)));
      });
    return () => {
      if (sessionRef.current) void api().closeSession(sessionRef.current);
    };
  }, []);

  const setSess = (s: OpenVolumeResult | null): void => {
    if (sessionRef.current) void api().closeSession(sessionRef.current);
    sessionRef.current = s?.sessionId ?? null;
    setSession(s);
  };

  const doScan = async (deep: boolean): Promise<void> => {
    const r = await run<ScanJobResult>(deep ? '정밀 볼륨 스캔' : '빠른 볼륨 스캔', () => api().startScan(target, deep));
    if (r) setScan(r);
  };

  const openVolume = async (v: FoundVolume, deep = false): Promise<void> => {
    const r = await run<OpenVolumeResult>(`${v.fsType} 볼륨 탐색`, () => api().startOpenVolume(target, v, deep));
    if (r) setSess(r);
  };

  const carve = async (): Promise<void> => {
    setShowCarve(false);
    const r = await run<OpenVolumeResult>('서명 스캔', () => api().startCarve(target, [...chosen]));
    if (r) setSess(r);
  };

  return (
    <div className="stack">
      {failing && (
        <div className="notice danger">
          이 디스크는 상태가 좋지 않습니다. 긴 스캔은 고장을 앞당길 수 있으니 <strong>이미지 탭</strong>에서 디스크 이미지를 먼저 만들고, 그 이미지에서 복구하는 것을 권장합니다.
        </div>
      )}
      <div className="panel">
        <h3>1. 볼륨 찾기</h3>
        <div className="row">
          <button className="btn primary" onClick={() => void doScan(false)}>
            빠른 스캔
          </button>
          <button className="btn" onClick={() => void doScan(true)}>
            정밀 스캔
          </button>
          <button className="btn" onClick={() => setShowCarve((x) => !x)}>
            서명 스캔…
          </button>
          <span className="muted small">이 단계들은 디스크를 읽기만 합니다.</span>
        </div>
        <ul className="muted small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>빠른 스캔: 파티션 테이블과 앞쪽 2GB의 주요 시작 위치만 확인합니다.</li>
          <li>정밀 스캔: 디스크 전체를 읽어 잃어버린 파티션과 $MFT를 찾습니다. 디스크 크기에 따라 몇 시간 걸릴 수 있습니다.</li>
          <li>서명 스캔: 파일시스템을 쓸 수 없을 때 사진·문서 등을 내용으로 찾습니다. 파일 이름과 폴더 구조는 복구되지 않습니다.</li>
        </ul>
        {showCarve && (
          <div className="notice" style={{ marginTop: 8 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              {carveTypes.map((t) => (
                <label key={t.label} className="check">
                  <input
                    type="checkbox"
                    checked={chosen.has(t.label)}
                    onChange={() =>
                      setChosen((s) => {
                        const n = new Set(s);
                        if (n.has(t.label)) n.delete(t.label);
                        else n.add(t.label);
                        return n;
                      })
                    }
                  />
                  {t.label}
                </label>
              ))}
            </div>
            <button className="btn primary" disabled={chosen.size === 0} onClick={() => void carve()}>
              서명 스캔 시작
            </button>
          </div>
        )}
      </div>

      {scan && (
        <div className="panel">
          <h3>
            2. 찾은 볼륨 <span className="muted">({scan.mode === 'deep' ? '정밀 스캔' : '빠른 스캔'}, 테이블: {scan.table.style.toUpperCase()})</span>
          </h3>
          {scan.badSectors > 0 && (
            <div className="notice danger small" style={{ marginBottom: 8 }}>
              읽지 못한 섹터 {scan.badSectors.toLocaleString()}개를 발견했습니다. 이미지를 먼저 만드는 것을 권장합니다.
            </div>
          )}
          {scan.table.issues.length > 0 && (
            <div className="notice warn small" style={{ marginBottom: 8 }}>
              <ul style={{ margin: 0 }}>
                {scan.table.issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          )}
          {scan.volumes.length === 0 ? (
            <div className="empty">
              {scan.mode === 'quick' ? '볼륨을 찾지 못했습니다. 정밀 스캔을 실행해 보세요.' : '볼륨을 찾지 못했습니다. 서명 스캔을 시도해 보세요.'}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>파일시스템</th>
                    <th className="num">시작 위치</th>
                    <th className="num">크기</th>
                    <th>찾은 방법</th>
                    <th>상태</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {scan.volumes.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <strong>{v.fsType === 'unknown' ? '알 수 없음' : v.fsType}</strong>
                        {v.partition?.name ? <span className="muted small"> {v.partition.name}</span> : null}
                        {v.notes.map((n) => (
                          <div key={n} className="muted small">
                            {n}
                          </div>
                        ))}
                      </td>
                      <td className="num mono">{formatBytes(v.offset)}</td>
                      <td className="num">{formatBytes(v.size)}</td>
                      <td>{SOURCE_LABEL[v.source]}</td>
                      <td>
                        <VolumeStatus v={v} />
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn small primary" disabled={!v.recoverable} onClick={() => void openVolume(v)}>
                          파일 보기
                        </button>{' '}
                        {v.fsType === 'NTFS' && (
                          <button className="btn small" title="MFT 위치를 믿을 수 없을 때 볼륨 전체에서 레코드를 찾습니다" onClick={() => void openVolume(v, true)}>
                            전체 탐색
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {session && <Browser key={session.sessionId} session={session} target={target} onClose={() => setSess(null)} />}
    </div>
  );
}
