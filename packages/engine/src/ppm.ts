import type { Frame } from "./types.ts"

/**
 * Binary PPM (P6) reading and writing.
 *
 * PPM is the bridge to the video pipeline: FFmpeg emits and consumes it directly
 * (`-f image2pipe -vcodec ppm`), it carries raw RGB with no colour management to
 * second-guess, and parsing it needs no dependencies. That makes a whole clip
 * processable today, before the FFmpeg sidecar lands, by decoding to a frame
 * directory and back.
 */

const MAX_HEADER_SCAN = 128

export function decodePpm(buffer: Uint8Array): Frame {
  if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x36) {
    throw new Error("not a binary PPM: expected a P6 magic number")
  }

  let offset = 2
  const fields: number[] = []

  // Header is three whitespace-separated integers, with '#' comments allowed between
  // any of them. Exactly one whitespace byte follows the last field.
  while (fields.length < 3) {
    if (offset >= buffer.length) throw new Error("truncated PPM header")
    const byte = buffer[offset] as number

    if (byte === 0x23) {
      while (offset < buffer.length && buffer[offset] !== 0x0a) offset++
      continue
    }
    if (isWhitespace(byte)) {
      offset++
      continue
    }

    let value = 0
    let digits = 0
    while (offset < buffer.length && isDigit(buffer[offset] as number)) {
      value = value * 10 + ((buffer[offset] as number) - 0x30)
      offset++
      digits++
      if (digits > MAX_HEADER_SCAN) throw new Error("malformed PPM header")
    }
    if (digits === 0) throw new Error(`unexpected byte 0x${byte.toString(16)} in PPM header`)
    fields.push(value)
  }

  const [width, height, maxValue] = fields as [number, number, number]
  if (width <= 0 || height <= 0) throw new Error(`invalid PPM dimensions ${width}x${height}`)
  if (maxValue !== 255) throw new Error(`unsupported PPM max value ${maxValue}, expected 255`)

  offset++ // the single whitespace byte terminating the header

  const expected = width * height * 3
  const available = buffer.length - offset
  if (available < expected) {
    throw new Error(`truncated PPM: expected ${expected} pixel bytes, found ${available}`)
  }

  return {
    width,
    height,
    channels: 3,
    data: new Uint8ClampedArray(buffer.buffer, buffer.byteOffset + offset, expected).slice(),
  }
}

export function encodePpm(frame: Frame): Uint8Array {
  const header = new TextEncoder().encode(`P6\n${frame.width} ${frame.height}\n255\n`)
  const pixels = frame.width * frame.height
  const out = new Uint8Array(header.length + pixels * 3)
  out.set(header, 0)

  if (frame.channels === 3) {
    out.set(frame.data, header.length)
  } else {
    // Drop the alpha channel; PPM has no place for it.
    for (let i = 0; i < pixels; i++) {
      const src = i * 4
      const dst = header.length + i * 3
      out[dst] = frame.data[src] as number
      out[dst + 1] = frame.data[src + 1] as number
      out[dst + 2] = frame.data[src + 2] as number
    }
  }
  return out
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39
}
