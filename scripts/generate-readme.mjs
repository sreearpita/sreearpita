import { writeFile } from "node:fs/promises";

const USERNAME = process.env.GITHUB_USERNAME ?? "sreearpita";
const X_URL = process.env.X_URL ?? "https://x.com/SreeArpitaPatra";
const LINKEDIN_URL =
  process.env.LINKEDIN_URL ?? "https://www.linkedin.com/in/sree-arpita-patra/";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ALLOW_UNAUTHENTICATED = process.env.ALLOW_UNAUTHENTICATED === "1";
const API_BASE = "https://api.github.com";
const MAX_DETAILED_COMMITS = Number(process.env.MAX_DETAILED_COMMITS ?? 500);
const CONCURRENCY = Number(process.env.GITHUB_API_CONCURRENCY ?? 5);

const LANGUAGE_COLORS = {
  JavaScript: "f1e05a",
  HTML: "e34c26",
  Go: "00ADD8",
  TypeScript: "3178c6",
  CSS: "663399",
  Python: "3572A5",
  Shell: "89e051",
  Ruby: "701516",
  Java: "b07219",
  C: "555555",
  "C++": "f34b7d",
  Rust: "dea584",
  PHP: "4F5D95",
  Vue: "41b883",
  Svelte: "ff3e00",
};

if (!GITHUB_TOKEN && !ALLOW_UNAUTHENTICATED) {
  throw new Error(
    "GITHUB_TOKEN is required for README generation. Set GITHUB_TOKEN, or set ALLOW_UNAUTHENTICATED=1 for a rate-limited public API run.",
  );
}

const today = new Date();
const lastYear = new Date(today);
lastYear.setFullYear(today.getFullYear() - 1);
const lastYearIso = lastYear.toISOString();
const lastYearDate = lastYearIso.slice(0, 10);

function buildUrl(path, params = {}) {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function request(path, params = {}) {
  const response = await fetch(buildUrl(path, params), {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "profile-readme-generator",
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
  });

  if (response.status === 204) {
    return { data: null, headers: response.headers, status: response.status };
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.message ?? response.statusText;
    throw new Error(`GitHub API ${response.status} for ${path}: ${message}`);
  }

  return { data, headers: response.headers, status: response.status };
}

async function safeRequest(path, params = {}) {
  try {
    return await request(path, params);
  } catch (error) {
    if (error.message.includes("GitHub API 404") || error.message.includes("GitHub API 409")) {
      return { data: null, headers: new Headers(), status: 0 };
    }
    throw error;
  }
}

function parseLastPage(linkHeader) {
  if (!linkHeader) return null;

  const lastLink = linkHeader
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="last"'));

  if (!lastLink) return null;

  const match = lastLink.match(/[?&]page=(\d+)>/);
  return match ? Number(match[1]) : null;
}

async function paginate(path, params = {}, maxPages = Infinity) {
  const results = [];
  let page = 1;

  while (page <= maxPages) {
    const { data } = await safeRequest(path, { per_page: 100, ...params, page });
    if (!Array.isArray(data) || data.length === 0) break;

    results.push(...data);
    if (data.length < 100) break;
    page += 1;
  }

  return results;
}

async function getEndpointCount(path, params = {}) {
  const { data, headers } = await safeRequest(path, { per_page: 1, ...params });
  if (!Array.isArray(data) || data.length === 0) return 0;
  return parseLastPage(headers.get("link")) ?? data.length;
}

async function getSearchCount(query) {
  const { data } = await request("/search/issues", { q: query, per_page: 1 });
  return data.total_count ?? 0;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return results;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function yearsSince(dateString) {
  const start = new Date(dateString);
  let years = today.getFullYear() - start.getFullYear();
  const hasNotHadAnniversary =
    today.getMonth() < start.getMonth() ||
    (today.getMonth() === start.getMonth() && today.getDate() < start.getDate());

  if (hasNotHadAnniversary) years -= 1;
  return years;
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|");
}

function latexDelta(value, color, prefix = "") {
  return `$\\color{${color}}{\\textsf{${prefix}${formatNumber(value)}}}$`;
}

function languageBadge(name, percentage) {
  const color = LANGUAGE_COLORS[name] ?? "858585";
  const url = new URL("https://img.shields.io/static/v1");
  url.searchParams.set("style", "flat-square");
  url.searchParams.set("label", "⠀");
  url.searchParams.set("color", "555");
  url.searchParams.set("labelColor", `#${color}`);
  url.searchParams.set("message", `${name} ${percentage}%`);
  return `![${escapeMarkdown(name)}](${url.toString()})`;
}

async function collectRepoStats(repo) {
  const allTimeCommits = await getEndpointCount(`/repos/${repo.full_name}/commits`, {
    author: USERNAME,
  });
  const lastYearCommits = await getEndpointCount(`/repos/${repo.full_name}/commits`, {
    author: USERNAME,
    since: lastYearIso,
  });

  return {
    repo,
    allTimeCommits,
    lastYearCommits,
  };
}

async function collectCommitDeltas(repo, commitLimit) {
  if (commitLimit <= 0) {
    return { commitsScanned: 0, additions: 0, deletions: 0 };
  }

  const maxPages = Math.ceil(commitLimit / 100);
  const commits = (
    await paginate(
      `/repos/${repo.full_name}/commits`,
      { author: USERNAME, since: lastYearIso },
      maxPages,
    )
  ).slice(0, commitLimit);

  const details = await mapLimit(commits, CONCURRENCY, async (commit) => {
    const { data } = await safeRequest(`/repos/${repo.full_name}/commits/${commit.sha}`);
    return data?.stats ?? { additions: 0, deletions: 0 };
  });

  return details.reduce(
    (total, stats) => ({
      commitsScanned: total.commitsScanned + 1,
      additions: total.additions + (stats.additions ?? 0),
      deletions: total.deletions + (stats.deletions ?? 0),
    }),
    { commitsScanned: 0, additions: 0, deletions: 0 },
  );
}

async function collectLanguageBytes(activeRepoStats) {
  const languageMaps = await mapLimit(activeRepoStats, CONCURRENCY, async ({ repo }) => {
    const { data } = await safeRequest(`/repos/${repo.full_name}/languages`);
    return data ?? {};
  });

  const totals = new Map();
  for (const languages of languageMaps) {
    for (const [name, bytes] of Object.entries(languages)) {
      totals.set(name, (totals.get(name) ?? 0) + bytes);
    }
  }

  const totalBytes = [...totals.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (totalBytes === 0) return [];

  return [...totals.entries()]
    .map(([name, bytes]) => ({
      name,
      bytes,
      percentage: Math.round((bytes / totalBytes) * 100),
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);
}

async function collectStats() {
  const [profile, repos] = await Promise.all([
    request(`/users/${USERNAME}`).then(({ data }) => data),
    paginate(`/users/${USERNAME}/repos`, {
      type: "owner",
      sort: "updated",
      direction: "desc",
    }),
  ]);

  const scannableRepos = repos.filter((repo) => !repo.disabled && !repo.archived);
  const repoStats = await mapLimit(scannableRepos, CONCURRENCY, collectRepoStats);
  const activeRepoStats = repoStats.filter((entry) => entry.lastYearCommits > 0);

  let remainingCommitDetails = MAX_DETAILED_COMMITS;
  const activeRepoStatsWithDeltas = [];
  for (const entry of activeRepoStats.sort((a, b) => b.lastYearCommits - a.lastYearCommits)) {
    const commitLimit = Math.min(entry.lastYearCommits, remainingCommitDetails);
    const deltas = await collectCommitDeltas(entry.repo, commitLimit);
    remainingCommitDetails -= deltas.commitsScanned;
    activeRepoStatsWithDeltas.push({ ...entry, ...deltas });
  }

  const [allTimeIssues, lastYearIssues, allTimePrs, lastYearPrs, languages] =
    await Promise.all([
      getSearchCount(`author:${USERNAME} type:issue`),
      getSearchCount(`author:${USERNAME} type:issue created:>=${lastYearDate}`),
      getSearchCount(`author:${USERNAME} type:pr`),
      getSearchCount(`author:${USERNAME} type:pr created:>=${lastYearDate}`),
      collectLanguageBytes(activeRepoStats),
    ]);

  return {
    profile,
    repos,
    repoStats,
    activeRepoStats: activeRepoStatsWithDeltas,
    languages,
    allTimeIssues,
    lastYearIssues,
    allTimePrs,
    lastYearPrs,
    commitDetailLimitReached:
      activeRepoStats.reduce((sum, entry) => sum + entry.lastYearCommits, 0) >
      MAX_DETAILED_COMMITS,
  };
}

function renderStatsTable(stats) {
  const publicRepos = stats.profile.public_repos ?? stats.repos.length;
  const stars = stats.repos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
  const allTimeCommits = stats.repoStats.reduce(
    (sum, entry) => sum + entry.allTimeCommits,
    0,
  );
  const lastYearCommits = stats.activeRepoStats.reduce(
    (sum, entry) => sum + entry.lastYearCommits,
    0,
  );
  const lastYearAdditions = stats.activeRepoStats.reduce(
    (sum, entry) => sum + entry.additions,
    0,
  );
  const lastYearDeletions = stats.activeRepoStats.reduce(
    (sum, entry) => sum + entry.deletions,
    0,
  );

  const allTimeRows = [
    `📦 **${formatNumber(publicRepos)}** public repos`,
    `🔥 **${formatNumber(allTimeCommits)}** commits`,
    `📋 **${formatNumber(stats.allTimeIssues)}** issues`,
    `🔀 **${formatNumber(stats.allTimePrs)}** PRs`,
    `⭐ **${formatNumber(stars)}** stars`,
  ];

  const lastYearRows = [
    `🔥 **${formatNumber(lastYearCommits)}** commits`,
    `📝 **${formatNumber(stats.lastYearIssues)}** issues`,
    `🔀 **${formatNumber(stats.lastYearPrs)}** PRs`,
    `${latexDelta(lastYearAdditions, "Green", "+")} lines added`,
    `${latexDelta(lastYearDeletions, "Red", "-")} lines removed`,
  ];

  const languageRows = stats.languages.map((language) =>
    languageBadge(language.name, language.percentage),
  );

  const rows = ["| All Time | Last Year | Top languages (last year) |", "|----------|-----------|---------------------------|"];
  for (let index = 0; index < 5; index += 1) {
    rows.push(
      `| ${allTimeRows[index] ?? ""} | ${lastYearRows[index] ?? ""} | ${languageRows[index] ?? ""} |`,
    );
  }

  return rows.join("\n");
}

function renderActiveProjects(stats) {
  const projects = stats.activeRepoStats
    .sort((a, b) => b.lastYearCommits - a.lastYearCommits)
    .slice(0, 10);

  if (projects.length === 0) {
    return "_No public repository activity found for the last year._";
  }

  return projects
    .map((entry) => {
      const added = latexDelta(entry.additions, "Green", "+");
      const removed = latexDelta(entry.deletions, "Red", "-");
      return `- [${escapeMarkdown(entry.repo.name)}](${entry.repo.html_url}) - ${formatNumber(entry.lastYearCommits)} commits, ${added} / ${removed}`;
    })
    .join("\n");
}

function renderReadme(stats) {
  const joinedYears = yearsSince(stats.profile.created_at);
  const limitNote = stats.commitDetailLimitReached
    ? `\n\n_Note: line totals are based on the most recent ${formatNumber(
        MAX_DETAILED_COMMITS,
      )} commits from the last year to keep API usage conservative._`
    : "";

  return `# Hi there, I'm ${USERNAME} 👋

Joined GitHub **${joinedYears}** years ago.

## 📊 Stats

${renderStatsTable(stats)}

## 🚀 Most Active Projects (Last Year)

${renderActiveProjects(stats)}${limitNote}

## 🤝 Connect with me

[![X](https://img.shields.io/badge/X-000000?style=flat&logo=x&logoColor=white)](${X_URL})
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077b5?logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0nMjU2JyBoZWlnaHQ9JzI1NicgeG1sbnM9J2h0dHA6Ly93d3cudzMub3JnJyBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSd4TWlkWU1pZCcgdmlld0JveD0nMCAwIDI1NiAyNTYnPjxwYXRoIGQ9J00yMTguMTIzIDIxOC4xMjdoLTM3LjkzMXYtNTkuNDAzYzAtMTQuMTY1LS4yNTMtMzIuNC0xOS43MjgtMzIuNC0xOS43NTYgMC0yMi43NzkgMTUuNDM0LTIyLjc3OSAzMS4zNjl2NjAuNDNoLTM3LjkzVjk1Ljk2N2gzNi40MTN2MTYuNjk0aC41MWEzOS45MDcgMzkuOTA3IDAgMCAxIDM1LjkyOC0xOS43MzJjMzguNDQ1IDAgNDUuNTMzIDI1LjI4OCA0NS41MzMgNTguMTg2bC0uMDE2IDY3LjAxM1pNNTUuOTU1IDc5LjI3Yy0xMi4xNTcuMDAyLTIyLjAxNC05Ljg1Mi0yMi4wMTYtMjIuMDA5LS4wMDItMTIuMTU3IDkuODUxLTIyLjAxNCAyMi4wMDgtMjIuMDE2IDEyLjE1Ny0uMDAzIDIyLjAxNCA5Ljg1MSAyMi4wMTYgMjIuMDA4QTIyLjAxMyAyMi4wMTMgMCAwIDEgNTYuOTU1IDc5LjI3bTE4Ljk2NiAxMzguODU4SDM3Ljk1Vjk1Ljk2N2gzNy45N3YxMjIuMTZaTTIzNy4wMzMuMDE4SDE4Ljg5QzguNTgtLjA5OC4xMjUgOC4xNjEtLjAwMSAxOC40NzF2MjE5LjA1M2MuMTIyIDEwLjMxNSA4LjU3NiAxOC41ODIgMTguODkgMTguNDc0aDIxOC4xNDRjMTAuMzM2LjEyOCAxOC44MjMtOC4xMzkgMTguOTY2LTE4LjQ3NFYxOC40NTRjLS4xNDctMTAuMzMtOC42MzUtMTguNTg4LTE4Ljk2Ni0xOC40NTMnIGZpbGw9JyNmZmYnLz48L3N2Zz4K)](${LINKEDIN_URL})

<!-- This README is generated by scripts/generate-readme.mjs. -->
`;
}

async function main() {
  const stats = await collectStats();
  await writeFile("README.md", renderReadme(stats), "utf8");
  console.log(`Generated README.md for ${USERNAME}.`);
}

await main();
