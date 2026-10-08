// Sci-Hub provider — academic papers by DOI / title / URL.

import * as cheerio from "cheerio";
import { fetchFromMirrors } from "../http.js";
import { SCIHUB_MIRRORS } from "../mirrors.js";
import type { Paper } from "../types.js";

const GROUP = "scihub";

/** Resolve a paper via Sci-Hub using a DOI, article URL, or title. */
export async function resolve(identifier: string): Promise<Paper> {
  const id = identifier.trim();
  const { html, base, finalUrl } = await fetchFromMirrors(
    GROUP,
    SCIHUB_MIRRORS,
    (b) => `${b}/${encodeURIComponent(id)}`
  );

  const $ = cheerio.load(html);

  // The PDF lives in an <embed>/<iframe id="pdf"> or a "save" button onclick.
  let pdfSrc =
    $("embed#pdf").attr("src") ||
    $("iframe#pdf").attr("src") ||
    $("embed[type='application/pdf']").attr("src") ||
    $("#article embed").attr("src") ||
    $("#article iframe").attr("src") ||
    $("embed[src]").first().attr("src") ||
    "";

  if (!pdfSrc) {
    const onclick = $("a:contains('save'), button:contains('save')").attr("onclick") || "";
    const m = onclick.match(/location\.href=['"]([^'"]+)['"]/);
    if (m?.[1]) pdfSrc = m[1];
  }
  if (!pdfSrc) {
    const m = html.match(/(?:src|href)=["']([^"']+\.pdf[^"']*)["']/i);
    if (m?.[1]) pdfSrc = m[1];
  }

  // Strip viewer fragment (e.g. #view=FitH) from PDF URL.
  if (pdfSrc) pdfSrc = pdfSrc.replace(/#.*$/, "");

  const title =
    $("#citation i").first().text().trim() ||
    $("title").text().trim() ||
    id;

  const doi = id.match(/10\.\d{4,9}\/\S+/)?.[0];

  return {
    source: "scihub",
    title,
    doi,
    url: finalUrl,
    pdfUrl: pdfSrc ? new URL(pdfSrc, base).href : undefined,
    mirrors: SCIHUB_MIRRORS.map((m) => `${m}/${encodeURIComponent(id)}`),
  };
}
