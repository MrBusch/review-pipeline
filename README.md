# Review Pipeline

Review Pipeline is a small web app that runs on your machine and shows how pull requests move through code review on GitHub. It pulls PR, review and review-request history for the repositories you choose, keeps it in a local database, and charts it over time:

- **Volume**: how many PRs are opened and merged per week or month.
- **Reviews**: how many reviews people give, and how many bots give.
- **Requests**: who asks whom for reviews, who asks the most, who gets asked the most.
- **Load**: who reviews the most, how fast they respond, and what is waiting on them right now.
- **Automation**: how many merged PRs were approved only by bots (for example `cursor`), and how that changes over time.

It reads GitHub through your own `gh` login. Nothing leaves your laptop except the read-only GitHub API calls, and there is no token to configure.

## Before you start

You need:

- macOS or Linux.
- [Node.js](https://nodejs.org/) 22.13 or later (the app uses Node's built-in SQLite). Check with `node --version`.
- The [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`, with read access to the repositories you want to analyze. Check with `gh auth status`.

## Install and start

```bash
git clone https://github.com/MrBusch/review-pipeline.git
cd review-pipeline
npm run install:all
./start.sh
```

`start.sh` builds the frontend when it has changed, starts the server, and opens <http://localhost:3025>. Run `./stop.sh` to stop it. To get a double-clickable launcher on your Desktop, run `bash setup.sh` once.

For development with live reload, run `npm run dev` and open <http://localhost:5175>.

## Use it

1. Select **Add repository** and enter `OWNER/NAME`, for example `octocat/Hello-World`. Pick how much history to pull (3, 6, 12 or 24 months).
2. The first sync starts right away. For a busy repository, 12 months of history takes roughly 15 to 20 minutes. You can use the app while it runs; charts fill in as data arrives.
3. Afterwards, select **Sync now** whenever you want fresh numbers. A sync only fetches PRs that changed since the last one, so it usually takes seconds.

Tick one or more repositories in the sidebar to combine them. Pick the period and choose weekly or monthly grouping at the top. Each tile compares the period with the period of the same length just before it.

In any chart with several series, click a legend item to hide or show it; the chart rescales to what's left. Shift-click an item to show only that one, and shift-click it again to bring the rest back.

| Tab | What it answers |
|---|---|
| Overview | How much work flows through review, how merged PRs were approved, how long PRs wait. |
| People | Who reviews, opens and merges the most over time, who asks for the most reviews, response times, and what waits on each person now. Click a person for their trend. |
| Requests | A requester × reviewer grid of who asks whom. |
| Bots | Every bot's reviews and approvals, and merges approved by bots alone. |
| Open queue | Open, non-draft PRs as of the last sync: waiting on a reviewer, with no reviewer asked, or approved but not merged. |

**How these numbers are counted** at the bottom of every tab gives the exact definitions.

### Settings

- **Count as bots**: GitHub already flags app accounts (such as `cursor` and `copilot-pull-request-reviewer`) as bots. Add service accounts that sign in as normal users here.
- **Leave out of all metrics**: logins to ignore entirely.
- **Re-pull**: forgets a repository's sync position and pulls its history again on the next sync, optionally from a different start date.

## Command line

The same sync is available without the browser:

```bash
npm run sync                                   # sync every repository
node server/cli.js add octocat/Hello-World --months 12
node server/cli.js sync octocat/Hello-World
node server/cli.js list
```

Only one sync runs at a time. A sync started from the command line shows in the app as running.

## How syncing works

A sync walks from the last sync point to now in time windows, asking GitHub search for the PRs updated in each window (`updated:A..B`). Each window is small enough to fit in one page of results, and a busy window is split in half. The app then fetches every new or changed PR whole, in batches by PR number: reviews, review-request events, and current pending reviewers. After each window, it saves the window's end as the sync point. That means:

- An interrupted sync, for example a closed laptop, resumes where it stopped.
- Later syncs only list PRs updated since the sync point, and only fetch the ones that changed. Any review, request, merge or close updates a PR, so nothing is missed. Each sync starts one hour early to allow for GitHub's search index lag.
- The first sync also fetches PRs that are still open but inactive since before the history start, so the open queue is complete.

Why windows: GitHub search sorts and filters on its own index timestamp, which can be hours away from the `updatedAt` the API returns. Paging through one long "sorted by update" search therefore skips PRs. One page per window avoids paging altogether.

A 12-month backfill of a repository with about 5,000 PRs takes roughly 15 to 20 minutes. It uses a small part of GitHub's 5,000-point hourly GraphQL budget, and the app waits and retries when GitHub rate-limits it.

## Data storage

All data lives in a single SQLite file at `~/.review-pipeline/review-pipeline.db`, outside the project folder. To back it up, copy the file. To start over, stop the app and delete it. Set `REVIEW_PIPELINE_DB` to use a different file.

## Tests

```bash
npm test
```

The tests pin down the metric definitions (bot-only approvals, self-review exclusion, response times, the open queue) against a throwaway database.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Recharts |
| Backend | Node.js, Express |
| Database | SQLite (built-in `node:sqlite`) |
| GitHub | GraphQL API through the GitHub CLI |
