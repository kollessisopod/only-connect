import { adminGet, adminPost, createPack, deletePack, duplicatePack, exportPackBundle, getPack, importPackFile, listPacks, savePack, uploadMedia } from '../../lib/api';
import type { Pack } from '@only-connect/shared';
import type { PacksApi } from './types';

/** Pack storage backed by the REST API (Bearer token from localStorage). */
export const livePacksApi: PacksApi = {
  list: () => listPacks(),
  get: (id) => getPack(id),
  create: (name) => createPack(name),
  save: (pack) => savePack(pack),
  remove: (id) => deletePack(id),
  duplicate: (id) => duplicatePack(id),
  upload: (file) => uploadMedia(file),
  exportJson: async (id) => JSON.stringify(await adminGet<Pack>(`packs/${encodeURIComponent(id)}/export`), null, 2),
  importJson: (json) => {
    let body: unknown;
    try {
      body = JSON.parse(json);
    } catch {
      return Promise.reject(new Error('that file is not valid JSON'));
    }
    return adminPost<Pack>('packs/import', body);
  },
  exportBundle: (id) => exportPackBundle(id),
  importBundle: (file) => importPackFile(file),
};
