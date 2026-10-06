import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
/**
 * Tiny JSON object store with optimistic concurrency.
 *
 * Production uses a private Vercel Blob store (ETag compare-and-swap via `ifMatch`).
 * Tests and local dev use MemoryStore with identical semantics.
 */
import { BlobError, BlobPreconditionFailedError, get as blobGet, put as blobPut, del as blobDel } from "@vercel/blob";

export class ConflictError extends Error {
  constructor(path: string) {
    super(`Write conflict on ${path}`);
    this.name = "ConflictError";
  }
}

export interface Versioned<T> {
  value: T;
  etag: string;
}

export interface PutOptions {
  /** Overwrite only if the stored ETag still matches. */
  ifMatch?: string;
  /** Create only; fail with ConflictError when the object exists. */
  createOnly?: boolean;
}

export interface Store {
  get<T>(path: string): Promise<Versioned<T> | null>;
  put<T>(path: string, value: T, opts?: PutOptions): Promise<{ etag: string }>;
  del(path: string): Promise<void>;
}

export class MemoryStore implements Store {
  private data = new Map<string, { json: string; etag: string }>();
  private n = 0;

  async get<T>(path: string): Promise<Versioned<T> | null> {
    const hit = this.data.get(path);
    return hit ? { value: JSON.parse(hit.json) as T, etag: hit.etag } : null;
  }

  async put<T>(path: string, value: T, opts: PutOptions = {}): Promise<{ etag: string }> {
    const cur = this.data.get(path);
    if (opts.createOnly && cur) throw new ConflictError(path);
    if (opts.ifMatch !== undefined && cur?.etag !== opts.ifMatch) throw new ConflictError(path);
    const etag = `"mem-${++this.n}"`;
    this.data.set(path, { json: JSON.stringify(value), etag });
    return { etag };
  }

  async del(path: string): Promise<void> {
    this.data.delete(path);
  }
}

export class BlobStore implements Store {
  constructor(private readonly token?: string) {}

  async get<T>(path: string): Promise<Versioned<T> | null> {
    const res = await blobGet(path, { access: "private", useCache: false, token: this.token });
    if (!res || res.statusCode !== 200) return null;
    const text = await new Response(res.stream).text();
    return { value: JSON.parse(text) as T, etag: res.blob.etag };
  }

  async put<T>(path: string, value: T, opts: PutOptions = {}): Promise<{ etag: string }> {
    try {
      const res = await blobPut(path, JSON.stringify(value), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: !opts.createOnly,
        cacheControlMaxAge: 60,
        ...(opts.ifMatch !== undefined ? { ifMatch: opts.ifMatch } : {}),
        token: this.token,
      });
      return { etag: res.etag };
    } catch (err) {
      if (err instanceof BlobPreconditionFailedError) throw new ConflictError(path);
      // Concurrent writers to one blob surface as a plain BlobError (HTTP 409), not a precondition failure.
      if (err instanceof BlobError && /already exists|conflicting operation|conditional request/i.test(err.message)) throw new ConflictError(path);
      throw err;
    }
  }

  async del(path: string): Promise<void> {
    await blobDel(path, { token: this.token });
  }
}

/** Single-process JSON file store for local development. CAS is serialized through an in-process lock per path. */
export class FileStore implements Store {
  private locks = new Map<string, Promise<void>>();
  constructor(private readonly dir: string) {}

  private file(path: string): string {
    const full = resolve(this.dir, path);
    if (!full.startsWith(resolve(this.dir) + sep)) throw new Error("path escapes store");
    return full;
  }

  private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(path) ?? Promise.resolve();
    const { promise, resolve: done } = Promise.withResolvers<void>();
    this.locks.set(path, prev.then(() => promise));
    await prev;
    try {
      return await fn();
    } finally {
      done();
    }
  }

  async get<T>(path: string): Promise<Versioned<T> | null> {
    try {
      const text = await readFile(this.file(path), "utf8");
      return { value: JSON.parse(text) as T, etag: createHash("sha1").update(text).digest("hex") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put<T>(path: string, value: T, opts: PutOptions = {}): Promise<{ etag: string }> {
    return this.withLock(path, async () => {
      const cur = await this.get<unknown>(path);
      if (opts.createOnly && cur) throw new ConflictError(path);
      if (opts.ifMatch !== undefined && cur?.etag !== opts.ifMatch) throw new ConflictError(path);
      const text = JSON.stringify(value);
      const f = this.file(path);
      await mkdir(dirname(f), { recursive: true });
      const tmp = join(dirname(f), `.tmp-${process.pid}-${Date.now()}`);
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, f);
      return { etag: createHash("sha1").update(text).digest("hex") };
    });
  }

  async del(path: string): Promise<void> {
    await rm(this.file(path), { force: true });
  }
}

/**
 * Read-modify-write with retries. `mutate` receives the current value (or null) and returns the next one,
 * or `undefined` to abort without writing. Returns the written value.
 */
export async function update<T>(
  store: Store,
  path: string,
  mutate: (current: T | null) => T | undefined,
  attempts = 8,
): Promise<T | undefined> {
  for (let i = 0; i < attempts; i++) {
    const cur = await store.get<T>(path);
    const next = mutate(cur ? cur.value : null);
    if (next === undefined) return undefined;
    try {
      await store.put(path, next, cur ? { ifMatch: cur.etag } : { createOnly: true });
      return next;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      await sleep(20 + Math.random() * 60 * (i + 1));
    }
  }
  throw new ConflictError(path);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
