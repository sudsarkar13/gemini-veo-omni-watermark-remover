import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { decodePpm, encodePpm } from "./ppm.ts"
import type { Frame } from "./types.ts"

function sample(width: number, height: number, channels: 3 | 4 = 3): Frame {
  const data = new Uint8ClampedArray(width * height * channels)
  for (let i = 0; i < width * height; i++) {
    const o = i * channels
    data[o] = i % 256
    data[o + 1] = (i * 3) % 256
    data[o + 2] = (i * 7) % 256
    if (channels === 4) data[o + 3] = 255
  }
  return { width, height, channels, data }
}

describe("ppm round trip", () => {
  it("preserves pixels exactly", () => {
    const frame = sample(9, 5)
    const decoded = decodePpm(encodePpm(frame))
    assert.equal(decoded.width, 9)
    assert.equal(decoded.height, 5)
    assert.equal(decoded.channels, 3)
    assert.deepEqual(decoded.data, frame.data)
  })

  it("drops the alpha channel when encoding RGBA", () => {
    const decoded = decodePpm(encodePpm(sample(4, 4, 4)))
    assert.equal(decoded.data.length, 4 * 4 * 3)
    assert.equal(decoded.data[0], 0)
    assert.equal(decoded.data[3], 1)
  })
})

describe("decodePpm", () => {
  it("skips comments in the header", () => {
    const body = new Uint8Array(3 * 3 * 3).fill(42)
    const header = new TextEncoder().encode("P6\n# made by ffmpeg\n3 3\n# another\n255\n")
    const buffer = new Uint8Array(header.length + body.length)
    buffer.set(header)
    buffer.set(body, header.length)

    const frame = decodePpm(buffer)
    assert.equal(frame.width, 3)
    assert.equal(frame.data[0], 42)
  })

  it("accepts a header laid out on a single line", () => {
    const body = new Uint8Array(2 * 2 * 3).fill(7)
    const header = new TextEncoder().encode("P6 2 2 255 ")
    const buffer = new Uint8Array(header.length + body.length)
    buffer.set(header)
    buffer.set(body, header.length)
    assert.equal(decodePpm(buffer).width, 2)
  })

  it("rejects a non-PPM buffer", () => {
    assert.throws(() => decodePpm(new TextEncoder().encode("GIF89a")), /P6/)
  })

  it("rejects an ASCII PPM, which has a different pixel encoding", () => {
    assert.throws(() => decodePpm(new TextEncoder().encode("P3\n2 2\n255\n0 0 0")), /P6/)
  })

  it("rejects an unsupported max value", () => {
    assert.throws(() => decodePpm(new TextEncoder().encode("P6\n2 2\n65535\n")), /max value/)
  })

  it("rejects truncated pixel data rather than reading past the buffer", () => {
    const header = new TextEncoder().encode("P6\n4 4\n255\n")
    const buffer = new Uint8Array(header.length + 10)
    buffer.set(header)
    assert.throws(() => decodePpm(buffer), /truncated/)
  })

  it("rejects a truncated header", () => {
    assert.throws(() => decodePpm(new TextEncoder().encode("P6\n4 ")), /truncated PPM header/)
  })

  it("does not alias the source buffer", () => {
    // The decoded frame is mutated in place during removal, so it must own its bytes.
    const encoded = encodePpm(sample(4, 4))
    const frame = decodePpm(encoded)
    frame.data[0] = 99
    assert.notEqual(encoded[encoded.length - 48], 99)
  })
})
