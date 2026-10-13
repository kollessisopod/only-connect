/**
 * First-boot seeding (SPEC §2): when the `packs` table is empty, insert the demo pack and generate + upload
 * its media (SVG images, synthesised WAV audio) under `demo/` in the bucket. Idempotent: packs are only
 * inserted when there are none, and each demo object is uploaded only if it is missing. Upload failures are
 * logged and never stop the boot.
 */
import { randomUUID } from 'node:crypto';
import { DEMO_MEDIA_PREFIX, buildDemoPack, type MediaRef, type Pack } from '@only-connect/shared';
import type { AppDeps } from '../deps.js';
import type { StoreLogger } from '../game/store.js';
import { DEMO_MELODIES } from './melodies.js';
import { DEMO_IMAGES } from './svg.js';
import { encodeWav, renderMelody } from './wav.js';

export interface DemoAsset {
  mime: string;
  body: Buffer;
}

/** Generate the bytes for one demo media file (by the file name used in the demo pack), or null if unknown. */
export function generateDemoAsset(file: string): DemoAsset | null {
  const image = DEMO_IMAGES[file];
  if (image) return { mime: 'image/svg+xml', body: Buffer.from(image(), 'utf8') };
  const melody = DEMO_MELODIES[file];
  if (melody) return { mime: 'audio/wav', body: encodeWav(renderMelody(melody.notes, melody.options)) };
  return null;
}

/** Every media reference in a pack (deduplicated by key). */
export function mediaRefs(pack: Pack): MediaRef[] {
  const seen = new Map<string, MediaRef>();
  for (const q of pack.questions) for (const c of q.clues) if (c.media && !seen.has(c.media.key)) seen.set(c.media.key, c.media);
  return [...seen.values()];
}

export interface SeedResult {
  packInserted: boolean;
  packId: string | null;
  uploaded: string[];
  skipped: string[];
  failed: string[];
}

export type SeedDeps = Pick<AppDeps, 'packs' | 'media' | 'objects'>;

export async function seedDemo(deps: SeedDeps, log: StoreLogger): Promise<SeedResult> {
  const result: SeedResult = { packInserted: false, packId: null, uploaded: [], skipped: [], failed: [] };
  const pack = buildDemoPack(() => randomUUID(), { timestamp: new Date().toISOString() });

  try {
    const count = await deps.packs.count();
    if (count === 0) {
      const stored = await deps.packs.insert(pack);
      result.packInserted = true;
      result.packId = stored.id;
      log.info(`[seed] inserted demo pack "${stored.name}" (${stored.id})`);
    } else {
      log.info(`[seed] ${count} pack(s) present, demo pack not inserted`);
    }
  } catch (err) {
    log.error(`[seed] could not insert the demo pack: ${(err as Error).message}`);
  }

  for (const ref of mediaRefs(pack)) {
    const file = ref.key.startsWith(DEMO_MEDIA_PREFIX) ? ref.key.slice(DEMO_MEDIA_PREFIX.length) : ref.key;
    try {
      const existing = await deps.objects.headObject(ref.key);
      if (existing) {
        result.skipped.push(ref.key);
        continue;
      }
      const asset = generateDemoAsset(file);
      if (!asset) {
        log.warn(`[seed] no generator for demo media "${file}"`);
        result.failed.push(ref.key);
        continue;
      }
      if (asset.mime !== ref.mime) log.warn(`[seed] mime mismatch for ${ref.key}: pack says ${ref.mime}, uploading ${asset.mime}`);
      const put = await deps.objects.putObject(ref.key, asset.body, asset.mime);
      await deps.media.record({ key: ref.key, mime: asset.mime, size: put.size, originalName: file });
      result.uploaded.push(ref.key);
    } catch (err) {
      result.failed.push(ref.key);
      log.error(`[seed] upload of ${ref.key} failed: ${(err as Error).message}`);
    }
  }
  log.info(`[seed] demo media: ${result.uploaded.length} uploaded, ${result.skipped.length} already present, ${result.failed.length} failed`);
  return result;
}
