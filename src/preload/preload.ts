import { contextBridge, ipcRenderer } from 'electron';
import type { Api, JobDone, JobProgress } from '../shared/types';

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

const api: Api = {
  appInfo: invoke('app:info') as Api['appInfo'],
  relaunchAsAdmin: invoke('app:relaunchAsAdmin') as Api['relaunchAsAdmin'],
  listDisks: invoke('disks:list') as Api['listDisks'],
  pickImage: invoke('dialog:pickImage') as Api['pickImage'],
  pickFolder: invoke('dialog:pickFolder') as Api['pickFolder'],
  pickSaveImage: invoke('dialog:pickSaveImage') as Api['pickSaveImage'],
  openPath: invoke('shell:openPath') as Api['openPath'],

  startScan: invoke('scan:start') as Api['startScan'],
  startOpenVolume: invoke('volume:open') as Api['startOpenVolume'],
  startCarve: invoke('carve:start') as Api['startCarve'],
  carveTypes: invoke('carve:types') as Api['carveTypes'],
  listEntries: invoke('volume:list') as Api['listEntries'],
  closeSession: invoke('volume:close') as Api['closeSession'],
  startRecover: invoke('recover:start') as Api['startRecover'],

  startDiagnose: invoke('repair:diagnose') as Api['startDiagnose'],
  startRepair: invoke('repair:apply') as Api['startRepair'],
  listJournals: invoke('repair:journals') as Api['listJournals'],
  startUndo: invoke('repair:undo') as Api['startUndo'],

  startManage: invoke('manage:op') as Api['startManage'],
  partitionRange: invoke('manage:range') as Api['partitionRange'],
  startFat32Format: invoke('manage:fat32') as Api['startFat32Format'],

  startImaging: invoke('imaging:start') as Api['startImaging'],
  cancelJob: invoke('job:cancel') as Api['cancelJob'],

  onProgress(fn) {
    const h = (_: unknown, p: JobProgress) => fn(p);
    ipcRenderer.on('job:progress', h);
    return () => ipcRenderer.removeListener('job:progress', h);
  },
  onDone(fn) {
    const h = (_: unknown, d: JobDone) => fn(d);
    ipcRenderer.on('job:done', h);
    return () => ipcRenderer.removeListener('job:done', h);
  },
};

contextBridge.exposeInMainWorld('api', api);
