import { writeFile } from "node:fs/promises";

const USERNAME = process.env.GITHUB_USERNAME ?? "sreearpita";
const TRACKED_ORGS = parseCsv(process.env.GITHUB_ORGS ?? "NUS-MTechSE-DMSS");
const EXCLUDED_REPOS = new Set(
  parseCsv(process.env.GITHUB_EXCLUDED_REPOS).map((repo) => repo.toLowerCase()),
);
const EXCLUDED_ORGS = new Set(
  parseCsv(process.env.GITHUB_EXCLUDED_ORGS).map((org) => org.toLowerCase()),
);
const X_URL = process.env.X_URL ?? "https://x.com/SreeArpitaPatra";
const LINKEDIN_URL =
  process.env.LINKEDIN_URL ?? "https://www.linkedin.com/in/sree-arpita-patra/";
const EMAIL = process.env.EMAIL ?? "sreearpitapatra@gmail.com";
const WEBSITE_URL = process.env.WEBSITE_URL ?? "https://sreearpita.me";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ALLOW_UNAUTHENTICATED = process.env.ALLOW_UNAUTHENTICATED === "1";
const API_BASE = "https://api.github.com";
const MAX_DETAILED_COMMITS = Number(process.env.MAX_DETAILED_COMMITS ?? 500);
const MAX_DISCOVERY_SEARCH_PAGES = Number(
  process.env.MAX_DISCOVERY_SEARCH_PAGES ?? 5,
);
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

function parseCsv(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

async function searchItems(path, query, params = {}) {
  const results = [];
  let page = 1;

  while (page <= MAX_DISCOVERY_SEARCH_PAGES) {
    const { data } = await request(path, {
      per_page: 100,
      ...params,
      q: query,
      page,
    });
    const items = data?.items ?? [];
    if (items.length === 0) break;

    results.push(...items);
    if (items.length < 100) break;
    page += 1;
  }

  return results;
}

async function safeSearchItems(path, query, params = {}) {
  try {
    return await searchItems(path, query, params);
  } catch (error) {
    console.warn(`Skipping discovery query "${query}": ${error.message}`);
    return [];
  }
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

function repoFullNameFromRepositoryUrl(repositoryUrl) {
  if (!repositoryUrl) return null;

  const marker = "/repos/";
  const markerIndex = repositoryUrl.indexOf(marker);
  if (markerIndex === -1) return null;

  return repositoryUrl.slice(markerIndex + marker.length);
}

function addRepoName(repoNames, repoName) {
  if (!repoName) return;
  repoNames.add(repoName);
}

async function discoverContributionRepoNames() {
  const [commitItems, prItems, issueItems] = await Promise.all([
    safeSearchItems(
      "/search/commits",
      `author:${USERNAME} committer-date:>=${lastYearDate}`,
      { sort: "committer-date", order: "desc" },
    ),
    safeSearchItems(
      "/search/issues",
      `author:${USERNAME} type:pr created:>=${lastYearDate}`,
      { sort: "created", order: "desc" },
    ),
    safeSearchItems(
      "/search/issues",
      `author:${USERNAME} type:issue created:>=${lastYearDate}`,
      { sort: "created", order: "desc" },
    ),
  ]);

  const repoNames = new Set();

  for (const item of commitItems) {
    addRepoName(repoNames, item.repository?.full_name);
  }

  for (const item of [...prItems, ...issueItems]) {
    addRepoName(repoNames, repoFullNameFromRepositoryUrl(item.repository_url));
  }

  return repoNames;
}

async function discoverContributionRepos() {
  const repoNames = await discoverContributionRepoNames();
  const repos = await mapLimit([...repoNames], CONCURRENCY, async (fullName) => {
    const { data } = await safeRequest(`/repos/${fullName}`);
    return data;
  });

  return repos.filter(Boolean);
}

function isExcludedRepo(repo) {
  const fullName = repo.full_name.toLowerCase();
  const owner = repo.owner?.login?.toLowerCase() ?? fullName.split("/")[0];
  return EXCLUDED_REPOS.has(fullName) || EXCLUDED_ORGS.has(owner);
}

async function collectRepositories() {
  const [ownedReposRaw, orgRepoGroups, discoveredReposRaw] = await Promise.all([
    paginate(`/users/${USERNAME}/repos`, {
      type: "owner",
      sort: "updated",
      direction: "desc",
    }),
    Promise.all(
      TRACKED_ORGS.map((org) =>
        paginate(`/orgs/${org}/repos`, {
          type: "public",
          sort: "updated",
          direction: "desc",
        }),
      ),
    ),
    discoverContributionRepos(),
  ]);

  const configuredOrgReposRaw = orgRepoGroups.flat();
  const ownedRepoNames = new Set(ownedReposRaw.map((repo) => repo.full_name));
  const configuredOrgRepoNames = new Set(
    configuredOrgReposRaw.map((repo) => repo.full_name),
  );

  const ownedRepos = ownedReposRaw.filter((repo) => !isExcludedRepo(repo));
  const configuredOrgRepos = configuredOrgReposRaw.filter(
    (repo) => !isExcludedRepo(repo),
  );
  const discoveredRepos = discoveredReposRaw.filter((repo) => !isExcludedRepo(repo));
  const discoveredOnlyRepos = discoveredRepos.filter(
    (repo) =>
      !ownedRepoNames.has(repo.full_name) &&
      !configuredOrgRepoNames.has(repo.full_name),
  );

  const reposByFullName = new Map();
  for (const repo of [...ownedRepos, ...configuredOrgRepos, ...discoveredRepos]) {
    reposByFullName.set(repo.full_name, repo);
  }

  return {
    ownedRepos,
    configuredOrgRepos,
    discoveredRepos,
    discoveredOnlyRepos,
    trackedRepos: [...reposByFullName.values()],
  };
}

async function collectStats() {
  const [profile, repoCollections] = await Promise.all([
    request(`/users/${USERNAME}`).then(({ data }) => data),
    collectRepositories(),
  ]);
  const {
    ownedRepos,
    configuredOrgRepos,
    discoveredRepos,
    discoveredOnlyRepos,
    trackedRepos,
  } = repoCollections;

  const scannableRepos = trackedRepos.filter((repo) => !repo.disabled && !repo.archived);
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
    ownedRepos,
    configuredOrgRepos,
    discoveredRepos,
    discoveredOnlyRepos,
    trackedRepos,
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
  const publicRepos = stats.profile.public_repos ?? stats.ownedRepos.length;
  const trackedOrgRepos = Math.max(
    stats.trackedRepos.length - stats.ownedRepos.length,
    0,
  );
  const publicRepoLabel =
    trackedOrgRepos > 0
      ? `📦 **${formatNumber(publicRepos)}** public repos + **${formatNumber(
          trackedOrgRepos,
        )}** org repos tracked`
      : `📦 **${formatNumber(publicRepos)}** public repos`;
  const stars = stats.ownedRepos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
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
    publicRepoLabel,
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
      const repoLabel =
        entry.repo.owner.login === USERNAME ? entry.repo.name : entry.repo.full_name;
      return `- [${escapeMarkdown(repoLabel)}](${entry.repo.html_url}) - ${formatNumber(entry.lastYearCommits)} commits, ${added} / ${removed}`;
    })
    .join("\n");
}

function renderContributionScopeNote(stats) {
  const discoveredOnlyRepos = stats.discoveredOnlyRepos ?? [];
  if (discoveredOnlyRepos.length === 0) return "";

  return `\n\n_Includes ${formatNumber(
    discoveredOnlyRepos.length,
  )} public contribution repositories discovered from recent GitHub activity._`;
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

${renderStatsTable(stats)}${renderContributionScopeNote(stats)}

## 🚀 Most Active Projects (Last Year)

${renderActiveProjects(stats)}${limitNote}

## 🤝 Connect with me

[![X](https://img.shields.io/badge/X-000000?style=flat&logo=x&logoColor=white)](${X_URL})
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=flat&logo=linkedin&logoColor=white)](${LINKEDIN_URL})
[![Gmail](https://img.shields.io/badge/Gmail-EA4335?style=flat&logo=gmail&logoColor=white)](mailto:${EMAIL})
[![Website](https://img.shields.io/badge/Website-111111?style=flat&logo=googlechrome&logoColor=white)](${WEBSITE_URL})

<!-- This README is generated by scripts/generate-readme.mjs. -->
`;
}

async function main() {
  const stats = await collectStats();
  await writeFile("README.md", renderReadme(stats), "utf8");
  console.log(`Generated README.md for ${USERNAME}.`);
}

await main();
