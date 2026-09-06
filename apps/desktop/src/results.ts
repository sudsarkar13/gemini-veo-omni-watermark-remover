import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"

import type { MediaKind, StoredResult } from "@gvowr/ipc"

/**
 * Where a finished render lives until the user asks for it.
 *
 * Nothing is written beside the source. A removal is a draft until somebody has looked
 * at it, and writing `clip_clean.mp4` next to `clip.mp4` the moment a run finishes
 * fills the user's folders with files they have never inspected — and makes "run it
 * again with Fill on" leave litter behind each time.
 *
 * So results land here, under the application's own directory, and stay until they are
 * exported, deleted, or age out. The index is a plain JSON file for the same reason the
 * settings are: a corrupt one costs a list, not a working application.
 */

/** Index and payloads both live under this directory inside userData. */
const DIRECTORY = "results"
const INDEX = "index.json"

export class ResultStore {
  readonly #root: string
  #entries: StoredResult[] = []

  constructor(userDataDirectory: string) {
    this.#root = join(userDataDirectory, DIRECTORY)
  }

  get root(): string {
    return this.#root
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(join(this.#root, INDEX), "utf8")
      const parsed = JSON.parse(raw) as StoredResult[]
      this.#entries = Array.isArray(parsed) ? parsed : []
    } catch {
      this.#entries = []
    }
    // An index can outlive the files it names — a crash between writing a file and
    // rewriting the index, or somebody clearing the folder by hand. Anything whose
    // file is gone and which was never exported is dropped rather than listed as
    // something the user can open.
    const surviving: StoredResult[] = []
    for (const entry of this.#entries) {
      if (entry.exportedTo !== null || (await exists(entry.storedPath))) surviving.push(entry)
    }
    this.#entries = surviving
  }

  list(): StoredResult[] {
    return [...this.#entries].sort((a, b) => b.createdAt - a.createdAt)
  }

  find(id: string): StoredResult | undefined {
    return this.#entries.find((entry) => entry.id === id)
  }

  /** Where a job's output should be written. Created before the run needs it. */
  async pathFor(jobId: string, sourcePath: string): Promise<string> {
    const directory = join(this.#root, jobId)
    await mkdir(directory, { recursive: true })
    const extension = extname(sourcePath) || ".mp4"
    return join(directory, `${basename(sourcePath, extension)}_clean${extension}`)
  }

  /**
   * Records a finished render.
   *
   * Re-running a job replaces its entry: the previous render is the same question
   * answered worse, and keeping both would leave the user picking between two files
   * they cannot tell apart.
   */
  async add(entry: Omit<StoredResult, "sizeBytes" | "createdAt" | "exportedTo" | "exportedAt">): Promise<StoredResult> {
    const sizeBytes = await sizeOf(entry.storedPath)
    const record: StoredResult = {
      ...entry,
      sizeBytes,
      createdAt: Date.now(),
      exportedTo: null,
      exportedAt: null,
    }
    this.#entries = [record, ...this.#entries.filter((candidate) => candidate.id !== entry.id)]
    await this.#save()
    return record
  }

  /**
   * Copies a result out, then removes the stored copy.
   *
   * In that order, and only after the copy is confirmed the right size. An export
   * that fails or is cancelled must leave the result exactly where it was — losing
   * someone's only copy to a full disk would be unforgivable for a convenience.
   */
  async export(id: string, targetPath: string): Promise<StoredResult> {
    const entry = this.find(id)
    if (!entry) throw new Error("that result is no longer in the store")
    if (entry.exportedTo !== null) throw new Error("that result has already been exported")

    await mkdir(dirname(targetPath), { recursive: true })
    await copyFile(entry.storedPath, targetPath)

    const written = await sizeOf(targetPath)
    if (written !== entry.sizeBytes) {
      throw new Error(
        `the exported file is ${written} bytes but the result is ${entry.sizeBytes}; ` +
          `the original is still in the app`
      )
    }

    await rm(join(this.#root, entry.id), { recursive: true, force: true })
    const updated: StoredResult = {
      ...entry,
      exportedTo: targetPath,
      exportedAt: Date.now(),
    }
    this.#entries = this.#entries.map((candidate) => (candidate.id === id ? updated : candidate))
    await this.#save()
    return updated
  }

  /** Removes one result and its file. The row goes too — this is a deletion. */
  async remove(id: string): Promise<void> {
    const entry = this.find(id)
    if (!entry) return
    await rm(join(this.#root, entry.id), { recursive: true, force: true })
    this.#entries = this.#entries.filter((candidate) => candidate.id !== id)
    await this.#save()
  }

  async clear(): Promise<void> {
    for (const entry of [...this.#entries]) {
      await rm(join(this.#root, entry.id), { recursive: true, force: true })
    }
    this.#entries = []
    await this.#save()
  }

  /**
   * Deletes results past the retention window that were never exported.
   *
   * Exported entries hold no file, so they are kept as history — knowing where a
   * render went is worth more than the row it costs. `retentionDays` of zero means
   * keep everything, which is a choice the user can make and the app must honour.
   */
  async sweep(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

    let removed = 0
    for (const entry of [...this.#entries]) {
      if (entry.exportedTo !== null) continue
      if (entry.createdAt > cutoff) continue
      await rm(join(this.#root, entry.id), { recursive: true, force: true })
      this.#entries = this.#entries.filter((candidate) => candidate.id !== entry.id)
      removed++
    }
    if (removed > 0) await this.#save()
    return removed
  }

  /** Total bytes held on disk. Exported entries hold none. */
  usageBytes(): number {
    return this.#entries.reduce(
      (total, entry) => total + (entry.exportedTo === null ? entry.sizeBytes : 0),
      0
    )
  }

  async #save(): Promise<void> {
    try {
      await mkdir(this.#root, { recursive: true })
      await writeFile(join(this.#root, INDEX), JSON.stringify(this.#entries, null, 2))
    } catch {
      // An unwritable index costs the list on next launch, not this session's work.
    }
  }
}

/**
 * Default destination for an export.
 *
 * Alongside the source unless the user has chosen a folder — that is where they were
 * looking when they added the file, and it is the answer that surprises nobody.
 */
export function exportPathFor(
  entry: StoredResult,
  exportDirectory: string | null
): string {
  const extension = extname(entry.sourcePath) || ".mp4"
  const stem = basename(entry.sourcePath, extension)
  return join(exportDirectory ?? dirname(entry.sourcePath), `${stem}_clean${extension}`)
}

export function resultKindOf(kind: MediaKind): MediaKind {
  return kind
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}
