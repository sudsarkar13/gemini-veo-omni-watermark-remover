import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { exportPathFor, ResultStore } from "./results.ts"
import type { StoredResult } from "@gvowr/ipc"

/**
 * The store holds the only copy of somebody's render until they export it, so these
 * exercise the real filesystem. A mock would prove the calls were made, which is not
 * the property that matters — the property that matters is that a file still exists
 * afterwards.
 */

const DAY = 24 * 60 * 60 * 1000

async function freshStore(): Promise<{ store: ResultStore; userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), "gvowr-results-"))
  const store = new ResultStore(userData)
  await store.load()
  return { store, userData }
}

/** Puts a render in the store the way a finished job would. */
async function addResult(
  store: ResultStore,
  id = "job-1",
  bytes = "a cleaned video"
): Promise<StoredResult> {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "gvowr-source-"))
  const sourcePath = join(sourceDirectory, "clip.mp4")
  await writeFile(sourcePath, "the original")

  const storedPath = await store.pathFor(id, sourcePath)
  await writeFile(storedPath, bytes)

  return store.add({
    id,
    fileName: "clip.mp4",
    sourcePath,
    storedPath,
    kind: "video",
    framesCorrected: 240,
    framesFilled: 0,
    framesUncovered: 0,
  })
}

describe("ResultStore", () => {
  it("keeps a render inside the app rather than beside the source", async () => {
    const { store, userData } = await freshStore()
    const entry = await addResult(store)

    assert.ok(
      entry.storedPath.startsWith(join(userData, "results")),
      `stored outside the app: ${entry.storedPath}`
    )
    assert.equal(existsSync(entry.storedPath), true)
    assert.equal(entry.exportedTo, null)
    assert.equal(entry.sizeBytes, (await stat(entry.storedPath)).size)
    // The source folder holds only the original.
    assert.equal(existsSync(entry.sourcePath.replace("clip.mp4", "clip_clean.mp4")), false)
  })

  it("exports a copy, then removes the stored one and keeps the row", async () => {
    const { store } = await freshStore()
    const entry = await addResult(store)
    const target = join(await mkdtemp(join(tmpdir(), "gvowr-export-")), "clip_clean.mp4")

    const updated = await store.export(entry.id, target)

    assert.equal(await readFile(target, "utf8"), "a cleaned video")
    assert.equal(existsSync(entry.storedPath), false, "the stored copy was left behind")
    assert.equal(updated.exportedTo, target)
    assert.ok(updated.exportedAt !== null)
    // The row survives: knowing where a render went is worth more than the row costs.
    assert.equal(store.list().length, 1)
    assert.equal(store.usageBytes(), 0)
  })

  it("leaves the stored copy alone when the export cannot be written", async () => {
    const { store } = await freshStore()
    const entry = await addResult(store)

    // A directory where the file should go: the copy fails, and the result must
    // survive it. Losing somebody's only copy to a failed convenience is the worst
    // thing this store could do.
    const directory = await mkdtemp(join(tmpdir(), "gvowr-blocked-"))
    const target = join(directory, "taken")
    await mkdir(target, { recursive: true })

    await assert.rejects(() => store.export(entry.id, target))
    assert.equal(existsSync(entry.storedPath), true)
    assert.equal(store.find(entry.id)?.exportedTo, null)
  })

  it("refuses to export the same result twice", async () => {
    const { store } = await freshStore()
    const entry = await addResult(store)
    const target = join(await mkdtemp(join(tmpdir(), "gvowr-export-")), "one.mp4")
    await store.export(entry.id, target)

    await assert.rejects(() => store.export(entry.id, join(target, "..", "two.mp4")), /already/)
  })

  it("replaces a job's previous render when it is run again", async () => {
    const { store } = await freshStore()
    await addResult(store, "job-1", "first attempt")
    await addResult(store, "job-1", "second attempt, with fill")

    assert.equal(store.list().length, 1)
    assert.equal(await readFile(store.list()[0]!.storedPath, "utf8"), "second attempt, with fill")
  })

  it("clears results past the retention window, and only those", async () => {
    const { store } = await freshStore()
    const old = await addResult(store, "old")
    const recent = await addResult(store, "recent")

    // Age the first one by rewriting the index the way time would.
    const aged = store.list().map((entry) =>
      entry.id === old.id ? { ...entry, createdAt: Date.now() - 31 * DAY } : entry
    )
    await writeFile(
      join(store.root, "index.json"),
      JSON.stringify(aged, null, 2)
    )
    await store.load()

    const removed = await store.sweep(30)

    assert.equal(removed, 1)
    assert.equal(store.list().length, 1)
    assert.equal(store.list()[0]?.id, recent.id)
    assert.equal(existsSync(old.storedPath), false)
  })

  it("never clears something that was exported, however old", async () => {
    const { store } = await freshStore()
    const entry = await addResult(store, "exported")
    const target = join(await mkdtemp(join(tmpdir(), "gvowr-export-")), "kept.mp4")
    await store.export(entry.id, target)

    const aged = store.list().map((row) => ({ ...row, createdAt: Date.now() - 400 * DAY }))
    await writeFile(join(store.root, "index.json"), JSON.stringify(aged, null, 2))
    await store.load()

    assert.equal(await store.sweep(30), 0)
    assert.equal(store.list().length, 1, "history of an exported render was thrown away")
    assert.equal(existsSync(target), true)
  })

  it("keeps everything when retention is switched off", async () => {
    const { store } = await freshStore()
    await addResult(store, "ancient")
    const aged = store.list().map((row) => ({ ...row, createdAt: Date.now() - 4000 * DAY }))
    await writeFile(join(store.root, "index.json"), JSON.stringify(aged, null, 2))
    await store.load()

    assert.equal(await store.sweep(0), 0)
    assert.equal(store.list().length, 1)
  })

  it("drops rows whose file has gone missing rather than offering to open it", async () => {
    const { store, userData } = await freshStore()
    const entry = await addResult(store)
    await rm(join(userData, "results", entry.id), { recursive: true, force: true })

    await store.load()

    assert.equal(store.list().length, 0)
  })

  it("names an export after the source, wherever it is going", () => {
    const entry = {
      sourcePath: join("/videos", "my.holiday.clip.mp4"),
    } as StoredResult

    assert.ok(exportPathFor(entry, null).endsWith(join("/videos", "my.holiday.clip_clean.mp4")))
    assert.ok(exportPathFor(entry, "/exports").endsWith(join("/exports", "my.holiday.clip_clean.mp4")))
  })
})
