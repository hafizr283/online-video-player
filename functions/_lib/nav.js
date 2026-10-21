/**
 * Shared navigation markup for the dynamic movie/category shells.
 *
 * The static home page carries the same upload link directly; keeping the
 * dynamic shells in one place stops them from drifting apart.
 */

export const UPLOAD_LINK =
  '<a class="site-bar__link" href="/upload">Upload a film</a>';

export const ADMIN_LINK =
  '<a class="site-bar__admin" href="/admin" title="Manage videos" aria-label="Manage videos">' +
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" aria-hidden="true" focusable="false">' +
  '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/>' +
  '<circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></svg>' +
  "<span>Manage videos</span></a>";

export const ADMIN_NAV = UPLOAD_LINK + ADMIN_LINK;
