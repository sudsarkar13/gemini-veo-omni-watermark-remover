import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { DEFAULT_SETTINGS, type Settings } from "./ipc.ts"

/**
 * Settings persistence.
 *
 * A plain JSON file in userData rather than a dependency. A corrupt or unreadable
 * file falls back to defaults instead of preventing the app from starting — losing
 * a theme preference is a far better outcome than a window that never opens.
 */

export class SettingsStore {
  readonly #path: string
  #cache: Settings = DEFAULT_SETTINGS

  constructor(userDataDirectory: string) {
    this.#path = join(userDataDirectory, "settings.json")
  }

  async load(): Promise<Settings> {
    try {
      const raw = await readFile(this.#path, "utf8")
      const parsed = JSON.parse(raw) as Partial<Settings>
      this.#cache = sanitise({ ...DEFAULT_SETTINGS, ...parsed })
    } catch {
      this.#cache = DEFAULT_SETTINGS
    }
    return this.#cache
  }

  get(): Settings {
    return this.#cache
  }

  async set(partial: Partial<Settings>): Promise<Settings> {
    this.#cache = sanitise({ ...this.#cache, ...partial })
    try {
      await mkdir(dirname(this.#path), { recursive: true })
      await writeFile(this.#path, JSON.stringify(this.#cache, null, 2))
    } catch {
      // An unwritable settings file must not take the app down with it.
    }
    return this.#cache
  }
}

/** Clamps values that arrive from disk or IPC, both of which can be stale or wrong. */
function sanitise(settings: Settings): Settings {
  return {
    ...settings,
    maxConcurrentJobs: Math.min(8, Math.max(1, Math.floor(settings.maxConcurrentJobs) || 1)),
    crf: Math.min(28, Math.max(10, Math.floor(settings.crf) || DEFAULT_SETTINGS.crf)),
    theme: settings.theme === "dark" || settings.theme === "light" ? settings.theme : "system",
  }
}
