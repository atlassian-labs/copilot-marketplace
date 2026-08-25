const DAY_MS = 86_400_000;

function text(value, fallback = "") {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDate(value, endOfDate = false) {
    if (typeof value !== "string" || !value.trim()) return null;
    const normalized = endOfDate && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? `${value}T23:59:59.999Z`
        : value;
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function ageInDays(value, now) {
    const timestamp = parseDate(value);
    return timestamp === null ? null : Math.max(0, Math.floor((now - timestamp) / DAY_MS));
}

function dueInDays(value, now) {
    const timestamp = parseDate(value, true);
    return timestamp === null ? null : Math.ceil((timestamp - now) / DAY_MS);
}

function normalizeSiteOrigin(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" ? url.origin.toLowerCase() : "";
    } catch {
        return "";
    }
}

function issueHref(issue, siteUrl) {
    const key = text(issue?.key);
    if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(key)) return "";
    const siteOrigin = normalizeSiteOrigin(siteUrl);
    try {
        const returned = new URL(issue?.webUrl);
        if (returned.protocol === "https:"
            && returned.origin.toLowerCase() === siteOrigin) {
            return returned.href;
        }
    } catch {
        // Use the validated site origin fallback.
    }
    return siteOrigin ? `${siteOrigin}/jira/browse/${encodeURIComponent(key)}` : "";
}

function statusCategory(fields) {
    const status = fields?.status;
    const category = status?.statusCategory ?? fields?.statusCategory;
    const key = text(category?.key).toLowerCase();
    const name = text(category?.name).toLowerCase();
    if (key === "done" || name === "done") return "Done";
    if (key === "indeterminate" || name === "in progress") return "In Progress";
    if (key === "new" || name === "to do") return "To Do";
    return text(category?.name, "Unknown");
}

function normalizeNamedList(value) {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return values
        .map((entry) => text(typeof entry === "string" ? entry : entry?.name))
        .filter(Boolean);
}

function normalizeSprints(fields) {
    const candidates = Array.isArray(fields?.sprint)
        ? fields.sprint
        : fields?.sprint ? [fields.sprint]
            : Array.isArray(fields?.sprints) ? fields.sprints : [];
    return candidates.map((sprint) => ({
        name: text(typeof sprint === "string" ? sprint : sprint?.name),
        state: text(sprint?.state),
        startDate: text(sprint?.startDate),
        endDate: text(sprint?.endDate),
    })).filter((sprint) => sprint.name);
}

function normalizeLinks(fields, siteUrl) {
    const links = Array.isArray(fields?.issuelinks) ? fields.issuelinks : [];
    return links.map((link) => {
        const outward = link?.outwardIssue;
        const inward = link?.inwardIssue;
        const linked = outward ?? inward;
        const direction = outward ? "outward" : inward ? "inward" : "unknown";
        const relationship = text(
            direction === "outward" ? link?.type?.outward : link?.type?.inward,
            text(link?.type?.name, "Linked work"),
        );
        const linkedFields = linked?.fields ?? {};
        return {
            key: text(linked?.key),
            url: issueHref(linked, siteUrl),
            direction,
            relationship,
            status: text(linkedFields?.status?.name, "Unknown"),
            statusCategory: statusCategory(linkedFields),
        };
    }).filter((link) => link.key && link.url);
}

function normalizeIssue(issue, siteUrl, now) {
    const fields = issue?.fields ?? {};
    const key = text(issue?.key).toUpperCase();
    const url = issueHref(issue, siteUrl);
    if (!key || !url) return null;

    const assigneeName = text(fields?.assignee?.displayName);
    const ownerStatus = assigneeName
        ? fields?.assignee?.active === true ? "active"
            : fields?.assignee?.active === false ? "inactive" : "unknown"
        : "unassigned";
    const category = statusCategory(fields);
    const updatedAge = ageInDays(fields?.updated, now);
    const createdAge = ageInDays(fields?.created, now);
    const resolutionAge = ageInDays(fields?.resolutiondate, now);
    const dueDistance = dueInDays(fields?.duedate, now);
    const labels = normalizeNamedList(fields?.labels);
    const components = normalizeNamedList(fields?.components);
    const versions = normalizeNamedList(fields?.fixVersions);
    const sprints = normalizeSprints(fields);
    const links = normalizeLinks(fields, siteUrl);
    const status = text(fields?.status?.name, "Unknown");
    const dependencyLinks = links.filter((link) =>
        /block|depend|require/i.test(link.relationship));
    const unresolvedDependencies = dependencyLinks.filter((link) =>
        link.statusCategory !== "Done");
    const blocked = category !== "Done" && (
        /block/i.test(status)
        || labels.some((label) => /^(blocked|blocker)$/i.test(label))
    );
    const stale = category !== "Done" && updatedAge !== null && updatedAge >= 3;
    const veryStale = category !== "Done" && updatedAge !== null && updatedAge >= 7;
    const unowned = category !== "Done" && !assigneeName;
    const timeSensitive = category !== "Done" && dueDistance !== null && dueDistance <= 2;
    const supportImpacting = category !== "Done" && [...labels, ...components]
        .some((value) => /support|customer|incident|sev/i.test(value));
    const unresolvedLinkedWork = category !== "Done" && unresolvedDependencies.length > 0;
    const projectKey = key.includes("-") ? key.split("-")[0] : "";
    const crossSpaceDependency = unresolvedDependencies.some((link) =>
        link.key.split("-")[0] !== projectKey);

    const estimate = number(fields?.storyPoints)
        ?? number(fields?.story_points)
        ?? number(fields?.estimate);

    return {
        key,
        url,
        summary: text(fields?.summary, "Untitled work item"),
        type: text(fields?.issuetype?.name, "Work item"),
        status,
        statusCategory: category,
        priority: text(fields?.priority?.name, "Unspecified"),
        assignee: assigneeName || "Unassigned",
        ownerStatus,
        createdAge,
        updatedAge,
        resolutionAge,
        dueDate: text(fields?.duedate),
        dueDistance,
        parent: fields?.parent?.key ? {
            key: text(fields.parent.key),
            summary: text(fields.parent?.fields?.summary),
            url: issueHref(fields.parent, siteUrl),
        } : null,
        sprints,
        estimate,
        components,
        versions,
        labels,
        links,
        unresolvedDependencies,
        resolvedAt: text(fields?.resolutiondate),
        updatedAt: text(fields?.updated),
        signals: {
            done: category === "Done",
            active: category === "In Progress",
            notStarted: category === "To Do",
            stale,
            veryStale,
            blocked,
            unowned,
            inactiveOwner: ownerStatus === "inactive",
            timeSensitive,
            supportImpacting,
            crossSpaceDependency,
            unresolvedLinkedWork,
            missingPlanningData: category !== "Done" && (!assigneeName || sprints.length === 0),
        },
    };
}

function priorityScore(priority) {
    const normalized = String(priority).toLowerCase();
    if (normalized === "highest" || normalized === "critical") return 5;
    if (normalized === "high") return 4;
    if (normalized === "medium") return 3;
    if (normalized === "low") return 2;
    if (normalized === "lowest") return 1;
    return 0;
}

function isNeedsAttention(issue) {
    const signals = issue.signals;
    return signals.blocked
        || signals.stale
        || signals.unowned
        || signals.timeSensitive
        || signals.unresolvedLinkedWork;
}

function compareAttention(left, right) {
    const signalScore = (issue) =>
        (issue.signals.blocked ? 16 : 0)
        + (issue.signals.timeSensitive ? 8 : 0)
        + (issue.signals.unresolvedLinkedWork ? 4 : 0)
        + (issue.signals.veryStale ? 3 : issue.signals.stale ? 1 : 0)
        + (issue.signals.unowned ? 2 : 0)
        + (issue.signals.inactiveOwner ? 1 : 0);
    return signalScore(right) - signalScore(left)
        || priorityScore(right.priority) - priorityScore(left.priority)
        || (right.updatedAge ?? -1) - (left.updatedAge ?? -1)
        || left.key.localeCompare(right.key);
}

function riskFor(issue) {
    const reasons = [];
    const evidence = [];
    if (issue.signals.blocked) {
        reasons.push("Blocked");
        evidence.push(`Status: ${issue.status}`);
    }
    if (issue.signals.timeSensitive) {
        const dueLabel = issue.dueDistance < 0
            ? `${Math.abs(issue.dueDistance)}d overdue`
            : issue.dueDistance === 0 ? "Due today" : `Due in ${issue.dueDistance}d`;
        reasons.push(issue.dueDistance < 0 ? "Overdue" : "Due soon");
        evidence.push(dueLabel);
    }
    if (issue.signals.unresolvedLinkedWork) {
        reasons.push("Dependency risk");
        evidence.push(`${issue.unresolvedDependencies.length} unresolved linked item${issue.unresolvedDependencies.length === 1 ? "" : "s"}`);
    }
    if (issue.signals.veryStale || issue.signals.stale) {
        reasons.push(issue.signals.veryStale ? "Very stale" : "Stale");
        evidence.push(`Updated ${issue.updatedAge}d ago`);
    }
    if (issue.signals.unowned) {
        reasons.push("Unassigned");
        evidence.push("No assignee");
    }
    if (issue.signals.inactiveOwner) {
        reasons.push("Inactive owner");
        evidence.push("Assignee is inactive");
    }
    if (issue.signals.supportImpacting) {
        reasons.push("Support impact (inferred)");
        evidence.push("Support/customer signal in labels or components");
    }

    let nextQuestion = "What is the next concrete step?";
    if (issue.signals.blocked) nextQuestion = "What is needed to unblock this work?";
    else if (issue.signals.timeSensitive) nextQuestion = "Is the due date still achievable?";
    else if (issue.signals.unresolvedLinkedWork) nextQuestion = "Who is coordinating the unresolved dependency?";
    else if (issue.signals.unowned) nextQuestion = "Who should own this work?";
    else if (issue.signals.stale) nextQuestion = "Is this still active, and what changed last?";

    return {
        key: issue.key,
        url: issue.url,
        summary: issue.summary,
        owner: issue.assignee,
        age: issue.updatedAge,
        reasons,
        evidence,
        nextQuestion,
        dependencies: issue.unresolvedDependencies,
        tone: issue.signals.blocked || (issue.dueDistance !== null && issue.dueDistance < 0)
            ? "danger" : "warning",
    };
}

function ownerLoad(issues) {
    const owners = new Map();
    for (const issue of issues) {
        const key = issue.assignee;
        const row = owners.get(key) ?? {
            owner: key,
            ownerStatus: issue.ownerStatus,
            active: 0,
            stale: 0,
            blocked: 0,
            supportImpacting: 0,
            done: 0,
            total: 0,
        };
        row.total += 1;
        if (issue.signals.active) row.active += 1;
        if (issue.signals.stale) row.stale += 1;
        if (issue.signals.blocked) row.blocked += 1;
        if (issue.signals.supportImpacting) row.supportImpacting += 1;
        if (issue.signals.done) row.done += 1;
        if (row.ownerStatus === "unknown" && issue.ownerStatus !== "unknown") {
            row.ownerStatus = issue.ownerStatus;
        }
        owners.set(key, row);
    }
    return [...owners.values()].sort((left, right) =>
        (right.blocked + right.stale + right.active) - (left.blocked + left.stale + left.active)
        || left.owner.localeCompare(right.owner));
}

function statusDistribution(issues) {
    const counts = new Map();
    for (const issue of issues) {
        counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([label, value]) => ({ label, value, unit: "issues" }))
        .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
}

function displayIssue(issue) {
    const { signals: _privateSignals, ...display } = issue;
    return display;
}

function workingDaysEndingAt(now, count) {
    const dates = [];
    const cursor = new Date(now);
    cursor.setUTCHours(0, 0, 0, 0);
    while (dates.length < count) {
        const day = cursor.getUTCDay();
        if (day !== 0 && day !== 6) dates.unshift(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return dates;
}

function completedByWorkingDay(issues, now) {
    const dates = workingDaysEndingAt(now, 10);
    const values = new Map(dates.map((date) => [date, 0]));
    for (const issue of issues) {
        const date = issue.resolvedAt.slice(0, 10);
        if (values.has(date)) values.set(date, values.get(date) + 1);
    }
    const series = dates.map((date) => ({ date, value: values.get(date), unit: "issues" }));
    return series.some((entry) => entry.value > 0) ? {
        series,
        range: { start: dates[0], end: dates.at(-1) },
        unit: "issues",
    } : null;
}

export function buildDashboardModel(rawIssues, siteUrl, fetchedAt, partial = false) {
    const now = parseDate(fetchedAt) ?? Date.now();
    const normalized = (Array.isArray(rawIssues) ? rawIssues : [])
        .map((issue) => normalizeIssue(issue, siteUrl, now))
        .filter(Boolean);
    const needsAttention = normalized.filter(isNeedsAttention);
    const completed = normalized.filter((issue) => issue.signals.done);
    const active = normalized.filter((issue) => issue.signals.active);
    const projects = [...new Set(normalized.map((issue) => issue.key.split("-")[0]))].sort();
    const sprints = [...new Set(normalized.flatMap((issue) => issue.sprints.map((sprint) => sprint.name)))].sort();
    const hostname = new URL(siteUrl).hostname;
    const risks = normalized
        .filter((issue) => isNeedsAttention(issue)
            || issue.signals.inactiveOwner
            || issue.signals.supportImpacting)
        .sort(compareAttention)
        .slice(0, 8)
        .map(riskFor);
    const topWork = [...normalized]
        .sort(compareAttention)
        .slice(0, 12);
    const recentCompleted = completed
        .filter((issue) => issue.resolutionAge !== null && issue.resolutionAge <= 14)
        .sort((left, right) => (left.resolutionAge ?? 999) - (right.resolutionAge ?? 999))
        .slice(0, 10);

    let notice = null;
    if (partial) notice = "This dashboard is based on a partial Jira result set.";
    else if (normalized.length === 0) notice = "No Jira issues were returned for currently open sprints.";

    return {
        schemaVersion: 1,
        context: {
            title: "Jira sprint dashboard",
            scopeLabel: "All visible issues in currently open sprints",
            site: hostname,
            projectCount: projects.length,
            sprintNames: sprints,
            refreshedAt: fetchedAt,
            mode: "Open sprints",
        },
        stats: [
            { label: "Total scope", value: normalized.length, tone: "neutral" },
            { label: "Done", value: completed.length, tone: "success" },
            { label: "In progress", value: active.length, tone: "info" },
            { label: "Needs attention", value: needsAttention.length, tone: needsAttention.length ? "warning" : "neutral" },
        ],
        quality: {
            partial,
            stale: false,
            notice,
        },
        charts: {
            statusDistribution: statusDistribution(normalized),
            completedByWorkingDay: completedByWorkingDay(completed, now),
        },
        owners: ownerLoad(normalized),
        risks,
        issues: normalized.map(displayIssue),
        topWork: topWork.map(displayIssue),
        recentCompleted: recentCompleted.map(displayIssue),
    };
}

export function markDashboardStale(model) {
    return {
        ...model,
        quality: {
            ...model.quality,
            stale: true,
            notice: "Refresh failed. Showing the last successfully loaded Jira data.",
        },
    };
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function issueLink(item) {
    return `<a class="issue-key" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.key)}</a>`;
}

function issueActions(item) {
    const key = escapeHtml(item.key);
    return `<button type="button" class="start-copilot-btn" data-issue-key="${key}" aria-label="Start with Copilot for ${key}">Start with Copilot</button>`;
}

function issueCell(item) {
    return `<div class="issue-cell">${issueLink(item)}${issueActions(item)}</div>`;
}

function formatDateTime(value) {
    const timestamp = parseDate(value);
    if (timestamp === null) return "Unknown";
    return new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(timestamp);
}

function formatAge(days) {
    if (days === null || days === undefined) return "Unknown";
    if (days === 0) return "Today";
    return `${days}d`;
}

function statusTone(category) {
    if (category === "Done") return "success";
    if (category === "In Progress") return "info";
    return "neutral";
}

function renderDependencies(links) {
    if (!Array.isArray(links) || links.length === 0) return "<span class=\"muted\">None flagged</span>";
    return links.map((link) =>
        `${issueLink(link)} <span class="muted">${escapeHtml(link.status)}</span>`).join("<br>");
}

function renderStats(stats) {
    return `<section class="stats" aria-label="Sprint summary">${stats.map((stat) => `
        <article class="stat stat-${escapeHtml(stat.tone)}">
            <div class="stat-value">${escapeHtml(stat.value)}</div>
            <div class="stat-label">${escapeHtml(stat.label)}</div>
        </article>`).join("")}
    </section>`;
}

function renderStatusChart(series) {
    if (!series.length) return "";
    const max = Math.max(1, ...series.map((entry) => entry.value));
    return `<section class="panel chart-panel">
        <div class="section-heading">
            <div><p class="eyebrow">Flow</p><h2>Status distribution</h2></div>
            <span class="muted">Issues</span>
        </div>
        <div class="bars">${series.map((entry) => {
            const width = Math.max(4, Math.round((entry.value / max) * 100));
            return `<div class="bar-row">
                <span class="bar-label">${escapeHtml(entry.label)}</span>
                <span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>
                <strong>${escapeHtml(entry.value)}</strong>
            </div>`;
        }).join("")}</div>
    </section>`;
}

function renderCompletionChart(chart) {
    if (!chart) return "";
    const max = Math.max(1, ...chart.series.map((entry) => entry.value));
    return `<section class="panel chart-panel">
        <div class="section-heading">
            <div><p class="eyebrow">Throughput</p><h2>Completed per working day</h2></div>
            <span class="muted">${escapeHtml(chart.range.start)} – ${escapeHtml(chart.range.end)}</span>
        </div>
        <div class="columns" aria-label="Completed issues per working day">${chart.series.map((entry) => {
            const height = entry.value ? Math.max(12, Math.round((entry.value / max) * 100)) : 2;
            return `<div class="column-item" title="${escapeHtml(entry.date)}: ${escapeHtml(entry.value)} issues">
                <span class="column-value">${escapeHtml(entry.value)}</span>
                <span class="column-track"><span class="column-fill" style="height:${height}%"></span></span>
                <span class="column-label">${escapeHtml(entry.date.slice(5))}</span>
            </div>`;
        }).join("")}</div>
    </section>`;
}

function renderOwners(owners) {
    if (!owners.length) return "";
    return `<section class="panel">
        <div class="section-heading"><div><p class="eyebrow">People</p><h2>Owner load and gaps</h2></div></div>
        <div class="table-wrap"><table>
            <thead><tr><th>Owner</th><th>Active</th><th>Stale</th><th>Blocked</th><th>Support</th><th>Done</th><th>Total</th></tr></thead>
            <tbody>${owners.map((owner) => `<tr>
                <td><span class="owner">${escapeHtml(owner.owner)}</span>${owner.ownerStatus !== "active" ? `<span class="owner-state">${escapeHtml(owner.ownerStatus)}</span>` : ""}</td>
                <td>${owner.active}</td><td>${owner.stale}</td><td>${owner.blocked}</td><td>${owner.supportImpacting}</td><td>${owner.done}</td><td>${owner.total}</td>
            </tr>`).join("")}</tbody>
        </table></div>
    </section>`;
}

function renderRisks(risks) {
    if (!risks.length) return "";
    return `<section class="panel">
        <div class="section-heading"><div><p class="eyebrow">Attention</p><h2>Risk and attention</h2></div><span class="muted">Highest-signal items</span></div>
        <div class="table-wrap"><table class="risk-table">
            <thead><tr><th>Key</th><th>Summary</th><th>Risk</th><th>Owner</th><th>Updated</th><th>Evidence and next question</th><th>Dependencies</th></tr></thead>
            <tbody>${risks.map((risk, index) => `<tr class="risk-row risk-row-${escapeHtml(risk.tone)} ${index === 0 ? "risk-row-primary" : ""}">
                <td>${issueCell(risk)}</td>
                <td class="summary-cell">${escapeHtml(risk.summary)}</td>
                <td><div class="chips">${risk.reasons.map((reason) => `<span class="chip">${escapeHtml(reason)}</span>`).join("")}</div></td>
                <td>${escapeHtml(risk.owner)}</td>
                <td>${escapeHtml(formatAge(risk.age))}</td>
                <td class="risk-detail"><span class="evidence">${risk.evidence.map(escapeHtml).join(" · ")}</span><span class="next-question"><strong>Next:</strong> ${escapeHtml(risk.nextQuestion)}</span></td>
                <td>${renderDependencies(risk.dependencies)}</td>
            </tr>`).join("")}</tbody>
        </table></div>
    </section>`;
}

function renderTopWork(items) {
    if (!items.length) return "";
    return `<section class="panel">
        <div class="section-heading"><div><p class="eyebrow">Work</p><h2>Highest-priority items</h2></div><span class="muted">Top ${items.length}</span></div>
        <div class="table-wrap"><table>
            <thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Priority</th><th>Owner</th><th>Updated</th><th>Dependencies</th></tr></thead>
            <tbody>${items.map((item) => `<tr>
                <td>${issueCell(item)}</td>
                <td class="summary-cell">${escapeHtml(item.summary)}</td>
                <td><span class="badge badge-${statusTone(item.statusCategory)}">${escapeHtml(item.status)}</span></td>
                <td>${escapeHtml(item.priority)}</td>
                <td>${escapeHtml(item.assignee)}</td>
                <td>${escapeHtml(formatAge(item.updatedAge))}</td>
                <td>${renderDependencies(item.unresolvedDependencies)}</td>
            </tr>`).join("")}</tbody>
        </table></div>
    </section>`;
}

function renderCompleted(items) {
    if (!items.length) return "";
    return `<details class="panel completed">
        <summary><span><span class="eyebrow">Recently completed</span><strong>${items.length} items completed in the last 14 days</strong></span><span aria-hidden="true">＋</span></summary>
        <div class="table-wrap"><table>
            <thead><tr><th>Key</th><th>Summary</th><th>Owner</th><th>Completed</th></tr></thead>
            <tbody>${items.map((item) => `<tr><td>${issueCell(item)}</td><td>${escapeHtml(item.summary)}</td><td>${escapeHtml(item.assignee)}</td><td>${escapeHtml(formatAge(item.resolutionAge))} ago</td></tr>`).join("")}</tbody>
        </table></div>
    </details>`;
}

export function renderDashboardHtml(model) {
    const context = model.context;
    const sprintLabel = context.sprintNames.length
        ? `${context.sprintNames.length} sprint${context.sprintNames.length === 1 ? "" : "s"}`
        : "Open sprints";
    const qualityNotice = model.quality.notice
        ? `<aside class="notice ${model.quality.stale ? "notice-warning" : ""}" role="status">${escapeHtml(model.quality.notice)}</aside>`
        : "";
    const emptyState = model.stats[0].value === 0
        ? `<section class="panel empty"><h2>No open-sprint work to display</h2><p>The Jira search completed successfully, but returned no visible issues in currently open sprints.</p></section>`
        : "";

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(context.title)}</title>
    <style>
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            background: var(--background-color-default, #f7f8fa);
            color: var(--text-color-default, #1f2328);
            font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
            font-size: var(--text-body-medium, 14px);
            line-height: var(--leading-body-medium, 20px);
        }
        a { color: var(--true-color-blue, #0969da); }
        a:focus-visible { outline: 2px solid var(--color-focus-outline, #0969da); outline-offset: 3px; border-radius: 3px; }
        .shell { width: min(1180px, 100%); margin: 0 auto; padding: 24px; }
        header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; margin-bottom: 18px; }
        h1, h2, p { margin-top: 0; }
        h1 { margin-bottom: 5px; font-size: var(--text-title-large, 26px); line-height: var(--leading-title-large, 32px); font-weight: var(--font-weight-semibold, 650); letter-spacing: -0.02em; }
        h2 { margin-bottom: 0; font-size: var(--text-title-medium, 17px); line-height: 24px; }
        .subtitle, .muted { color: var(--text-color-muted, #59636e); }
        .subtitle { margin: 0; }
        .context-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
        .meta-pill, .owner-chip, .badge, .chip, .owner-state { border: 1px solid var(--border-color-default, #d0d7de); border-radius: 999px; padding: 2px 8px; font-size: 12px; white-space: nowrap; }
        .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
        .stat, .panel { background: var(--background-color-default, #fff); border: 1px solid var(--border-color-default, #d0d7de); border-radius: 10px; }
        .stat { padding: 15px 16px; border-top-width: 3px; }
        .stat-success { border-top-color: var(--true-color-green, #1a7f37); }
        .stat-info { border-top-color: var(--true-color-blue, #0969da); }
        .stat-warning { border-top-color: var(--true-color-yellow, #bf8700); }
        .stat-value { font-size: 28px; line-height: 34px; font-weight: var(--font-weight-semibold, 650); }
        .stat-label { color: var(--text-color-muted, #59636e); }
        .notice { margin: 0 0 16px; padding: 10px 12px; border-left: 3px solid var(--true-color-blue, #0969da); background: var(--true-color-blue-muted, #ddf4ff); border-radius: 6px; }
        .notice-warning { border-left-color: var(--true-color-yellow, #bf8700); background: var(--true-color-yellow-muted, #fff8c5); }
        .chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
        .panel { padding: 16px; margin-bottom: 12px; overflow: hidden; }
        .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
        .eyebrow { display: block; margin: 0 0 2px; color: var(--text-color-muted, #59636e); font-size: 11px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
        .bars { display: grid; gap: 9px; }
        .bar-row { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(90px, 2fr) 28px; gap: 10px; align-items: center; }
        .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .bar-track { height: 8px; background: var(--border-color-default, #d8dee4); border-radius: 99px; overflow: hidden; }
        .bar-fill { display: block; height: 100%; background: var(--true-color-blue, #0969da); border-radius: inherit; }
        .columns { display: flex; align-items: end; height: 150px; gap: 5px; padding-top: 18px; }
        .column-item { flex: 1; min-width: 0; height: 100%; display: grid; grid-template-rows: 18px 1fr 18px; text-align: center; }
        .column-track { position: relative; height: 100%; background: var(--background-color-subtle, rgba(127,127,127,.08)); border-radius: 4px 4px 2px 2px; overflow: hidden; }
        .column-fill { position: absolute; inset: auto 0 0; background: var(--true-color-green, #1a7f37); border-radius: 4px 4px 0 0; }
        .column-value, .column-label { font-size: 11px; color: var(--text-color-muted, #59636e); }
        .table-wrap { overflow-x: auto; margin: 0 -16px -16px; }
        table { width: 100%; border-collapse: collapse; min-width: 680px; }
        th, td { padding: 10px 12px; border-top: 1px solid var(--border-color-default, #d0d7de); text-align: left; vertical-align: top; }
        th { color: var(--text-color-muted, #59636e); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
        td { font-size: 13px; }
        .owner { display: block; font-weight: 600; }
        .owner-state { display: inline-block; margin-top: 3px; color: var(--text-color-muted, #59636e); padding-block: 0; }
        .issue-key { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); font-weight: 650; text-decoration: underline; text-underline-offset: 3px; white-space: nowrap; }
        .issue-key:hover { text-decoration-thickness: 2px; }
        .issue-cell { display: grid; gap: 7px; align-content: start; justify-items: start; }
        .start-copilot-btn {
            appearance: none;
            border: 1px solid var(--border-color-default, #d0d7de);
            background: var(--background-color-default, #ffffff);
            color: var(--text-color-default, #1f2328);
            border-radius: 6px;
            font: inherit;
            font-size: 12px;
            line-height: 16px;
            padding: 3px 7px;
            cursor: pointer;
            white-space: nowrap;
        }
        .start-copilot-btn:hover { border-color: var(--true-color-blue, #0969da); color: var(--true-color-blue, #0969da); }
        .start-copilot-btn:focus-visible { outline: 2px solid var(--color-focus-outline, #0969da); outline-offset: 2px; }
        .start-copilot-btn:disabled { opacity: .65; cursor: progress; }
        .action-status {
            display: none;
            margin: 0 0 16px;
            padding: 10px 12px;
            border-left: 3px solid var(--true-color-blue, #0969da);
            background: var(--true-color-blue-muted, #ddf4ff);
            border-radius: 6px;
        }
        .action-status.error {
            border-left-color: var(--true-color-red, #cf222e);
            background: var(--true-color-red-muted, #ffebe9);
        }
        .badge-success { border-color: var(--true-color-green, #1a7f37); color: var(--true-color-green, #1a7f37); }
        .badge-info { border-color: var(--true-color-blue, #0969da); color: var(--true-color-blue, #0969da); }
        .risk-table { min-width: 980px; }
        .risk-row td:first-child { border-left: 3px solid transparent; }
        .risk-row-warning td:first-child { border-left-color: var(--true-color-yellow, #bf8700); }
        .risk-row-danger td:first-child { border-left-color: var(--true-color-red, #cf222e); }
        .risk-row-primary { background: var(--background-color-subtle, rgba(127,127,127,.045)); }
        .chips { display: flex; flex-wrap: wrap; gap: 5px; }
        .chip { padding-block: 1px; color: var(--text-color-muted, #59636e); }
        .risk-detail { min-width: 250px; }
        .evidence, .next-question { display: block; font-size: 13px; }
        .evidence { color: var(--text-color-muted, #59636e); }
        .next-question { margin-top: 5px; }
        .summary-cell { min-width: 240px; }
        details.completed { padding: 0; }
        details.completed summary { display: flex; justify-content: space-between; align-items: center; cursor: pointer; list-style: none; padding: 16px; }
        details.completed summary::-webkit-details-marker { display: none; }
        details.completed summary strong { display: block; }
        details.completed[open] summary { border-bottom: 1px solid var(--border-color-default, #d0d7de); }
        details.completed[open] .table-wrap { margin-top: 0; }
        .empty { text-align: center; padding: 32px 20px; }
        .empty p { color: var(--text-color-muted, #59636e); margin-bottom: 0; }
        footer { padding: 6px 2px 18px; color: var(--text-color-muted, #59636e); font-size: 12px; }
        @media (max-width: 760px) {
            .shell { padding: 16px; }
            header { display: block; }
            .context-meta { justify-content: flex-start; margin-top: 12px; }
            .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .chart-grid { grid-template-columns: 1fr; }
            .risk-top { display: block; }
            .owner-chip { display: inline-block; margin-top: 7px; }
        }
        @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
    </style>
</head>
<body>
    <main class="shell">
        <header>
            <div><h1>${escapeHtml(context.title)}</h1><p class="subtitle">${escapeHtml(context.scopeLabel)}</p></div>
            <div class="context-meta" aria-label="Dashboard context">
                <span class="meta-pill">${escapeHtml(context.site)}</span>
                <span class="meta-pill">${escapeHtml(sprintLabel)}</span>
                <span class="meta-pill">${escapeHtml(context.projectCount)} project${context.projectCount === 1 ? "" : "s"}</span>
            </div>
        </header>
        ${renderStats(model.stats)}
        ${qualityNotice}
        <aside id="action-status" class="action-status" role="status" aria-live="polite"></aside>
        ${emptyState}
        <div class="chart-grid">
            ${renderStatusChart(model.charts.statusDistribution)}
            ${renderCompletionChart(model.charts.completedByWorkingDay)}
        </div>
        ${renderOwners(model.owners)}
        ${renderRisks(model.risks)}
        ${renderTopWork(model.topWork)}
        ${renderCompleted(model.recentCompleted)}
        <footer>Last refreshed ${escapeHtml(formatDateTime(context.refreshedAt))}</footer>
    </main>
    <script>
        const actionStatus = document.getElementById('action-status');
        const pendingIssueKeys = new Set();
        const setActionStatus = (message, isError = false) => {
            if (!actionStatus) return;
            actionStatus.textContent = message;
            actionStatus.classList.toggle('error', isError);
            actionStatus.style.display = message ? 'block' : 'none';
        };
        const setIssueButtonsDisabled = (issueKey, disabled) => {
            document.querySelectorAll('.start-copilot-btn').forEach((candidate) => {
                if (candidate.getAttribute('data-issue-key') === issueKey) {
                    candidate.disabled = disabled;
                    candidate.setAttribute('aria-busy', disabled ? 'true' : 'false');
                }
            });
        };
        document.addEventListener('click', async (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const button = target?.closest('.start-copilot-btn');
            if (!button) return;
            const issueKey = (button.getAttribute('data-issue-key') || '').trim();
            if (!issueKey || pendingIssueKeys.has(issueKey)) return;

            pendingIssueKeys.add(issueKey);
            setIssueButtonsDisabled(issueKey, true);
            setActionStatus('Starting Copilot for ' + issueKey + '…');
            try {
                const response = await fetch('/start-with-copilot', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ issueKey }),
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok || payload.status !== 'success') {
                    throw new Error(payload.message || ('Could not start Copilot for ' + issueKey + '.'));
                }
                const destination = payload.mode === 'background-agent'
                    ? ' in a background task.'
                    : ' in the current session.';
                setActionStatus('Started Copilot for ' + payload.issueKey + destination);
            } catch (error) {
                setActionStatus(
                    error?.message || ('Could not start Copilot for ' + issueKey + '.'),
                    true,
                );
            } finally {
                pendingIssueKeys.delete(issueKey);
                setIssueButtonsDisabled(issueKey, false);
            }
        });
        const events = new EventSource('/events');
        events.addEventListener('message', (event) => {
            if (event.data === 'refresh') window.location.reload();
        });
    </script>
</body>
</html>`;
}
