// The deploy's last step (ADR-0132 §6): once guide.yml has deployed a release's
// guide, fetch USER_GUIDE_URL and every page in pages.ts, and hold each to a
// 200 that carries the release's version stamp (render.ts). Pages serves
// through a CDN that can answer with the previous deploy for a few minutes, so
// the pages still wrong are fetched again, round after round, until each
// answers right or the rounds run out.
//
//   bun apps/guide/src/live-check.ts <version>
//
// The version may carry its tag's `v`. Exit 0 when every page answered right,
// 1 when one never did, 2 on a bad argument.
import { USER_GUIDE_URL } from "@maxprice/shared/user-guide";
import { PAGES, type Page } from "./pages";

export type LiveCheck = {
  /** The guide's root URL, with its trailing slash. */
  base: string;
  /** The bare version every page must carry. */
  version: string;
  pages?: readonly Page[];
  fetch?: (url: string) => Promise<Response>;
  /** How many times a page still wrong is fetched. */
  rounds?: number;
  /** The wait between rounds. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

// Twenty waits of 30 s between twenty-one rounds span the ten minutes Pages
// lets a response be cached for. A fetch that hangs counts as a wrong answer.
const ROUNDS = 21;
const DELAY_MS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;

/** The version a built page is stamped with, or null when it carries none. */
export function stampedVersion(html: string): string | null {
  return /<meta name="maxprice-version" content="([^"]*)"/.exec(html)?.[1] ?? null;
}

/** The guide's root, then every page's URL under it, in navigation order. */
export function liveUrls(base: string, pages: readonly Page[] = PAGES): string[] {
  return [base, ...pages.map((page) => new URL(page.out, base).href)];
}

/** What is wrong with one URL's answer, or null when it is right. */
async function probe(
  url: string,
  version: string,
  fetchUrl: (url: string) => Promise<Response>,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchUrl(url);
  } catch (err) {
    return `${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (response.status !== 200) return `${url}: HTTP ${response.status}`;
  const stamp = stampedVersion(await response.text());
  if (stamp !== version) return `${url}: version ${stamp ?? "missing"}, expected ${version}`;
  return null;
}

/** Every URL that never answered right, each with its last answer; empty when all did. */
export async function checkLive(check: LiveCheck): Promise<string[]> {
  const fetchUrl =
    check.fetch ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
  const rounds = check.rounds ?? ROUNDS;
  const sleep = check.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = check.log ?? console.log;
  let pending = liveUrls(check.base, check.pages);
  let problems: string[] = [];
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) await sleep(check.delayMs ?? DELAY_MS);
    const verdicts = await Promise.all(pending.map((url) => probe(url, check.version, fetchUrl)));
    problems = verdicts.filter((verdict): verdict is string => verdict !== null);
    pending = pending.filter((_, at) => verdicts[at] !== null);
    if (pending.length === 0) return [];
    log(`round ${round}/${rounds}: ${pending.length} page(s) not yet live at ${check.version}`);
  }
  return problems;
}

/** The script, given its arguments; its exit code. */
export async function main(argv: string[]): Promise<number> {
  const version = (argv[0] ?? "").replace(/^v/, "");
  if (argv.length !== 1 || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("usage: bun apps/guide/src/live-check.ts <version>");
    return 2;
  }
  const urls = liveUrls(USER_GUIDE_URL);
  console.log(`checking ${urls.length} URLs under ${USER_GUIDE_URL} for ${version}`);
  const problems = await checkLive({ base: USER_GUIDE_URL, version });
  if (problems.length === 0) {
    console.log(`every page answers 200 at ${version}`);
    return 0;
  }
  console.error(`${problems.length} page(s) never went live:\n${problems.join("\n")}`);
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
