/**
 * Conversion between filesystem paths and `file://` URIs, matching how the
 * server encodes locations it sends back to the client.
 */

/** A `file://` URI for an absolute filesystem path (percent-encoding each segment). */
export function pathToUri(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  const withLeading = normalized.startsWith("/") ? normalized : "/" + normalized;
  return (
    "file://" + withLeading.split("/").map(encodeURIComponent).join("/")
  );
}

/** The filesystem path for a `file://` URI (or the URI itself if not `file://`). */
export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri.slice("file://".length);
    }
  }
  return uri;
}
