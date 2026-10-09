// Unit tests for file-format sniffing.
//
// Run via `pnpm test` (which builds first). No network, no fixtures.

import test from "node:test";
import assert from "node:assert/strict";
import { sniffExt } from "../dist/sniff.js";

const epubHead = () => {
  // ZIP local file header whose first entry declares the EPUB mimetype.
  const b = Buffer.alloc(128);
  b.write("PK", 0, "latin1");
  b.write("mimetypeapplication/epub+zip", 30, "latin1");
  return b;
};

test("sniffExt recognises PDF by magic bytes", () => {
  assert.equal(sniffExt(Buffer.from("%PDF-1.7\nrest", "latin1")), "pdf");
});

test("sniffExt distinguishes EPUB from a plain ZIP", () => {
  assert.equal(sniffExt(epubHead()), "epub");
  assert.equal(sniffExt(Buffer.concat([Buffer.from("PK", "latin1"), Buffer.alloc(64)])), "zip");
});

test("sniffExt recognises RAR, MOBI and DjVu", () => {
  assert.equal(sniffExt(Buffer.from("Rar!\u001a\u0007\u0000", "latin1")), "rar");

  const mobi = Buffer.alloc(80);
  mobi.write("BOOKMOBI", 60, "latin1");
  assert.equal(sniffExt(mobi), "mobi");

  assert.equal(sniffExt(Buffer.from("AT&TFORM", "latin1")), "djvu");
});

test("sniffExt falls back to content-type, then to bin", () => {
  const opaque = Buffer.from("nothing recognisable here", "latin1");
  assert.equal(sniffExt(opaque, "application/epub+zip"), "epub");
  assert.equal(sniffExt(opaque, "application/pdf"), "pdf");
  assert.equal(sniffExt(opaque, "application/octet-stream"), "bin");
  assert.equal(sniffExt(opaque), "bin");
});

test("sniffExt does not crash on an empty buffer", () => {
  // Mirrors serve every format as octet-stream, so the content-type fallback is
  // the only signal for a zero-length or truncated response.
  assert.equal(sniffExt(Buffer.alloc(0), "application/pdf"), "pdf");
  assert.equal(sniffExt(Buffer.alloc(0)), "bin");
});
