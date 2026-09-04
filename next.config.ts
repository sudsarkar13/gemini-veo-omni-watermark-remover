import type { NextConfig } from "next";

/**
 * The renderer is a static export loaded by Electron over a custom `app://` scheme.
 *
 * Static rather than a Next server inside the app: nothing here needs server-side
 * rendering — all processing is local and driven over IPC — and shipping a localhost
 * server inside a desktop application means a listening port, a lifecycle to manage,
 * and a larger attack surface for no benefit.
 *
 * Assets are referenced relatively because the app is served from a custom scheme
 * root, not from a web server that can resolve absolute paths.
 */
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Electron serves index.html directly, so trailing-slash directory URLs would
  // resolve to the wrong place under the custom protocol handler.
  trailingSlash: false,
};

export default nextConfig;
