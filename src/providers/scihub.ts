// Sci-Hub provider — academic papers by DOI / title / URL.

import * as cheerio from "cheerio";
import {
  fetchFromMirrors,
  MirrorRecordMissError,
  ResourceNotFoundError,
} from "../http.js";
import { SCIHUB_MIRRORS } from "../mirrors.js";
import { absoluteUrl } from "../parse.js";
import type { Paper } from "../types.js";

const GROUP = "scihub";

/** Sci-Hub sometimes answers HTTP 200 with a human-verification page (ALTCHA)
 *  instead of the article. That is a mirror failure, not a paper: the next
 *  mirror is tried, and if all of them challenge, the caller hears why. */
const CHALLENGE_PAGE = /altcha-widget|\/captcha\/solution\/|проверка на робота/i;

/** The PDF location on an article page, or undefined when the page holds none. */
function findPdfSrc(html: string): string | undefined {
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
  return pdfSrc ? pdfSrc.replace(/#.*$/, "") || undefined : undefined;
}

const NOT_IN_CATALOGUE =
  "not found — Sci-Hub has no PDF for this identifier (the page is not an article)";

/** Validate one mirror's answer during the race. A challenge is a mirror failure;
 *  a page without a PDF is a miss for this record, so another mirror may still win. */
function checkArticlePage(html: string): true | string {
  if (CHALLENGE_PAGE.test(html)) {
    return "answered with a human-verification challenge (ALTCHA), not the article";
  }
  if (!findPdfSrc(html)) throw new MirrorRecordMissError("answered without a PDF for this record");
  return true;
}

/** Resolve a paper via Sci-Hub using a DOI, article URL, or title. */
export async function resolve(identifier: string): Promise<Paper> {
  const id = identifier.trim();
  let fetched;
  try {
    fetched = await fetchFromMirrors(
      GROUP,
      SCIHUB_MIRRORS,
      (b) => `${b}/${encodeURIComponent(id)}`,
      undefined,
      checkArticlePage
    );
  } catch (error) {
    if (error instanceof ResourceNotFoundError) {
      throw new ResourceNotFoundError(GROUP, error.tried, NOT_IN_CATALOGUE);
    }
    throw error;
  }
  const { html, base, finalUrl } = fetched;

  const pdfSrc = findPdfSrc(html);
  // A page without a PDF is a "not in our catalogue" answer, often HTTP 200 with
  // third-party links. Returning it as a paper would put the page title in
  // `title`, so report it as a missing record instead.
  if (!pdfSrc) throw new ResourceNotFoundError(GROUP, 1, NOT_IN_CATALOGUE);

  const $ = cheerio.load(html);
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
    pdfUrl: absoluteUrl(pdfSrc, base),
    mirrors: SCIHUB_MIRRORS.map((m) => `${m}/${encodeURIComponent(id)}`),
  };
}
