import assert from "node:assert/strict";
import test from "node:test";

import {
    buildDashboardModel,
    renderDashboardHtml,
} from "../ui/dashboard.mjs";

function sampleIssue(overrides = {}) {
    return {
        id: "private-id",
        self: "private-self-link",
        key: "DASH-1",
        webUrl: "https://other.example/invalid",
        context: { secret: "private-context" },
        fields: {
            summary: "Blocked delivery item",
            description: "private-description",
            status: {
                name: "Blocked",
                statusCategory: { key: "indeterminate", name: "In Progress" },
            },
            assignee: {
                displayName: "Example Owner",
                active: true,
                emailAddress: "private@example.com",
                accountId: "private-account",
            },
            priority: { name: "High" },
            issuetype: { name: "Task" },
            created: "2026-08-01T00:00:00Z",
            updated: "2026-08-10T00:00:00Z",
            labels: ["blocked"],
            components: [],
            fixVersions: [],
            sprint: [{ name: "Sprint 1" }],
            issuelinks: [],
            ...overrides,
        },
    };
}

test("builds an allowlisted four-stat renderer model", () => {
    const model = buildDashboardModel(
        [sampleIssue()],
        "https://example.atlassian.net",
        "2026-08-17T00:00:00Z",
    );
    const serialized = JSON.stringify(model);

    assert.equal(model.stats.length, 4);
    assert.equal(model.issues.length, 1);
    assert.equal(
        model.issues[0].url,
        "https://example.atlassian.net/jira/browse/DASH-1",
    );
    assert.equal("signals" in model.issues[0], false);
    assert.equal("signals" in model.topWork[0], false);
    for (const privateValue of [
        "private-id",
        "private-self-link",
        "private-context",
        "private-description",
        "private@example.com",
        "private-account",
    ]) {
        assert.equal(serialized.includes(privateValue), false);
    }
});

test("renders risk and attention as an accessible linked table", () => {
    const model = buildDashboardModel(
        [sampleIssue()],
        "https://example.atlassian.net",
        "2026-08-17T00:00:00Z",
    );
    const html = renderDashboardHtml(model);

    assert.match(html, /class="risk-table"/);
    assert.match(html, /<th>Evidence and next question<\/th>/);
    assert.match(html, /class="issue-key"/);
    assert.match(html, /class="start-copilot-btn"/);
    assert.match(html, /fetch\('\/start-with-copilot'/);
    assert.match(html, /text-decoration: underline/);
    assert.doesNotMatch(html, /source appendix|assumptions footer|refresh button/i);
});
