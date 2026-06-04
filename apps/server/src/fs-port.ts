// @argus/server — the Node implementation of the adapter's FileSystemPort
// (boundaries.md §2.1). This is the ONLY place node:fs is imported for run I/O;
// the adapter stays pure and goes through this injected seam, so it can later run
// in a Tauri sidecar / browser / remote host unchanged.
//
// Read-only by design: this port exposes NO write method. M1 ships the real read
// methods (readFile/readJson/listDir/stat/exists). `watch` uses node:fs.watch as a
// minimal stub; the chokidar-backed implementation lands in the live phase (M6).

import { readFile, readdir, stat as fsStat } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import type { FileSystemPort } from '@argus/adapter';

export class NodeFileSystemPort implements FileSystemPort {
  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async readJson(path: string): Promise<unknown> {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as unknown;
  }

  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const s = await fsStat(path);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null; // absent
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fsStat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Minimal node:fs.watch-backed implementation (M1). The chokidar-backed watcher
   * with debouncing/recursive semantics is a live-phase (M6) concern. Returns an
   * unwatch function.
   */
  watch(path: string, onEvent: (event: { path: string; type: string }) => void): () => void {
    const watcher = fsWatch(path, (eventType, filename) => {
      onEvent({ path: filename ? `${path}/${filename}` : path, type: eventType });
    });
    return () => watcher.close();
  }
}
