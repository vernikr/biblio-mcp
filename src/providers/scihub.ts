// Sci-Hub provider — academic papers by DOI / title / URL.

import * as cheerio from "cheerio";
import { fetchFromMirrors, ResourceNotFoundError } from "../http.js";
import { SCIHUB_MIRRORS } from "../mirrors.js";

/** Sci-Hub sometimes answers HTTP 200 with a human-verification page (ALTCHA)
 *  instead of the article. That is a mirror failure, not a paper: the next
 *  mirror is tried, and if all of them challenge, the caller hears why. */
const CHALLENGE_PAGE = /altcha-widget|\/captcha\/solution\/|проверка на робота/i;
const isArticlePage = (html: string): boolean | string =>
  CHALLENGE_PAGE.test(html)
    ? "answered with a human-verification challenge (ALTCHA), not the article"
    : true;
import type { Paper } from "../types.js";

const GROUP = "scihub";

/** Resolve a paper via Sci-Hub using a DOI, article URL, or title. */
export async function resolve(identifier: string): Promise<Paper> {
  const id = identifier.trim();
  const { html, base, finalUrl } = await fetchFromMirrors(
    GROUP,
    SCIHUB_MIRRORS,
    (b) => `${b}/${encodeURIComponent(id)}`,
    undefined,
    isArticlePage
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

  // A page without a PDF is a "not in our catalogue" answer, often HTTP 200 with
  // third-party links. Returning it as a paper would put the page title in
  // `title`, so report it as a missing record instead.
  if (!pdfSrc) {
    throw new ResourceNotFoundError(
      GROUP,
      1,
      "not found — Sci-Hub has no PDF for this identifier (the page is not an article)"
    );
  }

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
