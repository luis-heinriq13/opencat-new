/**
 * The account verification link in a provider failure. Gemini asks the user to open a Google page
 * ("Verify your account: https://accounts.google.com/..."), and the user cannot finish without the
 * whole link. Cutting the text at a length limit or redacting a query value breaks the link, so
 * the code that shortens or redacts a failure keeps this one span whole.
 *
 * Only a link that opens Google's sign-in continuation is trusted: https, the exact host and path,
 * no credentials, no port, and a redirect that stays on Google. Any other URL stays under the normal
 * limits and redaction. The Gemini CLI repeats the link that its server sends and has no list of its
 * own: `/signin/continue` is in its tests and `/v3/signin/continue` is what users get.
 *
 * The link holds a sign-in token, so it only goes to the user of this computer. No database, log or
 * team client gets it: see `withoutGoogleSignInLinks`.
 */
const SIGN_IN_HOST = "accounts.google.com";
const SIGN_IN_PATHS: ReadonlySet<string> = new Set(["/v3/signin/continue", "/signin/continue"]);
/** The query values that Google's sign-in page goes on to after the verification. */
const REDIRECT_PARAMETERS = ["continue", "followup"] as const;
/** The only provider whose failures can carry this link. */
export const VERIFICATION_LINK_PROVIDER = "antigravity";
/** The longest link that is kept whole. A Google sign-in link is under 1,500 characters. */
const MAX_LINK_LENGTH = 2_048;
const LINK_CANDIDATE = /https:\/\/[^\s"'<>`\\^{}|]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/u;

export interface VerificationLink {
  url: string;
  /** Index of the first character of the link in the text. */
  start: number;
  /** Index after the last character of the link in the text. */
  end: number;
}

function staysOnGoogle(redirect: string): boolean {
  try {
    const { protocol, hostname } = new URL(redirect);
    return protocol === "https:" && (hostname === "google.com" || hostname.endsWith(".google.com"));
  } catch {
    return false;
  }
}

function isTrustedLink(candidate: string): boolean {
  if (candidate.length > MAX_LINK_LENGTH) return false;
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "https:" &&
      url.hostname === SIGN_IN_HOST &&
      SIGN_IN_PATHS.has(url.pathname) &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      REDIRECT_PARAMETERS.every((name) => url.searchParams.getAll(name).every(staysOnGoogle))
    );
  } catch {
    return false;
  }
}

/** The first trusted Google verification link in `text`, with its position, or `null`. */
export function findVerificationLink(text: string): VerificationLink | null {
  for (const match of text.matchAll(LINK_CANDIDATE)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (isTrustedLink(url)) return { url, start: match.index, end: match.index + url.length };
  }
  return null;
}

/**
 * `text` with each link to Google's sign-in host removed, trusted or not, for a copy that outlives
 * the live error or leaves this computer. The redaction rules do not mask each token in such a link.
 */
export function withoutGoogleSignInLinks(text: string): string {
  const stripped = text.replace(LINK_CANDIDATE, (candidate) => {
    try {
      return new URL(candidate).hostname === SIGN_IN_HOST ? "" : candidate;
    } catch {
      return candidate;
    }
  });
  return stripped === text ? text : stripped.replace(/[\s:]+$/u, "");
}

/**
 * `text` cut to `limit` characters, with `…` at the cut. A trusted link that the cut would split
 * or drop stays whole, so the result can be longer than `limit` by the part of the link past it.
 */
export function truncateKeepingVerificationLink(text: string, limit: number): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  let cut = characters.slice(0, limit - 1).join("").length;
  const link = findVerificationLink(text);
  // A link far into a long text is not worth keeping the text before it.
  if (link && link.end > cut && link.start < limit * 4) cut = link.end;
  return cut >= text.length ? text : `${text.slice(0, cut)}…`;
}

/**
 * Applies `transform` to the text around the trusted link and leaves the link as it is. The
 * redaction rules read a query value such as `ticket=` as a credential, and a link with that value
 * redacted does not open.
 */
export function transformAroundVerificationLink(text: string, transform: (part: string) => string): string {
  const link = findVerificationLink(text);
  if (!link) return transform(text);
  return `${transform(text.slice(0, link.start))}${link.url}${transformAroundVerificationLink(text.slice(link.end), transform)}`;
}
