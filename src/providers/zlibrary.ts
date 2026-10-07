// Z-Library provider — best-effort, no-auth public search.
//
// Z-Library is the flakiest source to automate: it rotates "personal" domains,
// gates much of its catalog behind login, and sometimes serves a captcha. This
// provider makes a best-effort public-search attempt across known domains and
// returns whatever it can parse. It NEVER hard-fails the aggregate search — an
// empty result is an acceptable outcome here, since Anna's Archive already
// indexes the Z-Library collection as a reliable fallback.
//
// For authenticated, complete Z-Library access, set BIBLIO_ZLIB_MIRRORS to your
// working personal domain; richer login-based access is intentionally out of
// scope to keep the server credential-free by default.
//
// As of the 2026-10-07 mirror audit every public domain in the default list was
// unusable (see src/mirrors.ts), so this source is NOT part of the default
// search set — opt in with `sources: ["zlibrary"]`. Being excluded by default
// is what keeps a dead source from taxing every search; being still present
// means a user-supplied personal domain works without a code change.

import * as cheerio from "cheerio";
import { fetchFromMirrors } from "../http.js";
import { ZLIBRARY_MIRRORS } from "../mirrors.js";
import type { Book } from "../types.js";

const GROUP = "zlibrary";

export async function search(query: string, limit: number): Promise<Book[]> {
  const { html, base } = await fetchFromMirrors(GROUP, ZLIBRARY_MIRRORS, (b) =>
    `${b}/s/${encodeURIComponent(query)}`
  );
  const $ = cheerio.load(html);
  const books: Book[] = [];

  // Z-Library result cards vary by theme; try the common selectors.
  const cards = $(
    "z-bookcard, .book-item, .resItemBox, [class*='bookRow'], .book-card"
  );

  cards.each((_i, el) => {
    if (books.length >= limit) return false;
    const $el = $(el);

    const title =
      $el.attr("title") ||
      $el.find("h3 a, .title a, [slot='title'], .bookTitle").first().text().trim() ||
      $el.find("a[href*='/book/']").first().text().trim();
    if (!title) return;

    const href =
      $el.attr("href") ||
      $el.find("a[href*='/book/']").first().attr("href") ||
      "";
    const author =
      $el.attr("author") ||
      $el.find(".author, [slot='author'], [class*='author']").first().text().trim() ||
      undefined;
    const blob = $el.text().replace(/\s+/g, " ");
    const year = $el.attr("year") || blob.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1];
    const format =
      ($el.attr("extension") || blob.match(/\b(pdf|epub|mobi|djvu|azw3)\b/i)?.[1])?.toUpperCase();
    const size = $el.attr("filesize") || blob.match(/(\d+(?:\.\d+)?\s?(?:KB|MB|GB))/i)?.[1];

    books.push({
      source: "zlibrary",
      title,
      author,
      year,
      format,
      size: size?.replace(/\s+/, " "),
      url: href ? (href.startsWith("http") ? href : `${base}${href}`) : undefined,
    });
  });

  return books;
}
