/**
 * The services the routes, sockets, timers and seeder depend on, bundled so `createApp({ deps })` can run
 * against Postgres + MinIO in production and against in-memory stubs in tests.
 */
import { GameStore, type StoreLogger } from './game/store.js';
import { PgGamePersistence } from './game/persistence.js';
import { PgMediaRepository, PgPackRepository, type MediaRepository, type PackRepository } from './packs/repo.js';
import { s3ObjectStore, type ObjectStore } from './storage.js';

export interface AppDeps {
  store: GameStore;
  packs: PackRepository;
  media: MediaRepository;
  objects: ObjectStore;
}

/** Production wiring: Postgres repositories and the S3 bucket. Nothing connects until first use. */
export function createDefaultDeps(log: StoreLogger): AppDeps {
  const packs = new PgPackRepository();
  const store = new GameStore(new PgGamePersistence(packs), { log });
  return { store, packs, media: new PgMediaRepository(), objects: s3ObjectStore };
}
