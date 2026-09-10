import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { requireCanvasOpenInput } from "../server/jira-client.mjs";

let fetchOpenSprintIssues;
let moduleId = 0;
beforeEach(async () => {
    // Each extension process has one session and its own module-level cache.
    ({ fetchOpenSprintIssues } = await import(`../server/jira-client.mjs?test=${moduleId++}`));
});

const identifiers = { cloudId: "cloud-123", siteUrl: "https://example.atlassian.net" };
const issue = (key) => ({ key, fields: { summary: key } });
const searchTool = (server = "atlassian") => ({
    name: `${server}-searchJiraIssuesUsingJql`,
    mcpServerName: server,
    mcpToolName: "searchJiraIssuesUsingJql",
    namespacedName: `${server}/searchJiraIssuesUsingJql`,
});
const success = (payload) => ({ resultType: "success", textResultForLlm: JSON.stringify(payload) });

function makeSession(execute = async () => success({ issues: [], isLast: true })) {
    const calls = [];
    const session = {
        rpc: {
            tools: {
                getCurrentMetadata: async () => ({ tools: [searchTool()] }),
                initializeAndValidate: async () => ({}),
                execute: async (args) => {
                    calls.push(args);
                    return execute(args, calls.length);
                },
            },
            mcp: {
                list: async () => ({ servers: [{ name: "atlassian", status: "connected" }] }),
                get apps() { throw new Error("MCP Apps must not be used"); },
            },
        },
    };
    return { session, calls };
}

test("normalizes and validates canvas site input", () => {
    assert.deepEqual(
        requireCanvasOpenInput({ cloudId: " cloud-123 ", siteUrl: "https://Example.Atlassian.net/path" }),
        identifiers,
    );
    assert.throws(
        () => requireCanvasOpenInput({ cloudId: "", siteUrl: "http://example.com" }),
        { code: "jira_canvas_input_missing" },
    );
});

test("executes the session tool and paginates authoritative text without MCP Apps", async () => {
    const { session, calls } = makeSession(async (_args, page) => ({
        ...success(page === 1
            ? { issues: [issue("DASH-1")], nextPageToken: "page-2", isLast: false }
            : { issues: [issue("DASH-2")], isLast: true }),
        structuredContent: { issues: { nodes: [issue("IGNORED-99")] } },
    }));
    const result = await fetchOpenSprintIssues(session, identifiers);
    assert.deepEqual(result.issues.map(({ key }) => key), ["DASH-1", "DASH-2"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, "atlassian-searchJiraIssuesUsingJql");
    assert.deepEqual(Object.keys(calls[0]).sort(), ["arguments", "name"]);
    assert.equal(calls[0].arguments.cloudId, identifiers.cloudId);
    assert.equal(calls[0].arguments.jql, "sprint in openSprints() ORDER BY priority DESC, Rank ASC");
    assert.equal(calls[0].arguments.maxResults, 100);
    assert.equal(calls[1].arguments.nextPageToken, "page-2");
});

test("uses the first exact search match and its offered model name", async () => {
    const { session, calls } = makeSession();
    session.rpc.tools.getCurrentMetadata = async () => ({
        tools: [{ ...searchTool("jira"), name: "jira_search_alias_42" }, searchTool()],
    });
    await fetchOpenSprintIssues(session, identifiers);
    assert.equal(calls[0].name, "jira_search_alias_42");
});

test("initializes session tools when opening before the first agent turn", async () => {
    const { session, calls } = makeSession();
    let initialized = false;
    session.rpc.tools.getCurrentMetadata = async () => ({ tools: initialized ? [searchTool()] : null });
    session.rpc.tools.initializeAndValidate = async () => { initialized = true; };
    await fetchOpenSprintIssues(session, identifiers);
    assert.equal(initialized, true);
    assert.equal(calls.length, 1);
});

test("parses string ToolResult values", async () => {
    const { session } = makeSession(async () => JSON.stringify({ issues: [issue("DASH-1")], isLast: true }));
    assert.equal((await fetchOpenSprintIssues(session, identifiers)).issues[0].key, "DASH-1");
});

for (const resultType of ["failure", "denied", "rejected", "timeout"]) {
    test(`handles a ${resultType} ToolResult before parsing its text`, async () => {
        const { session, calls } = makeSession(async () => ({
            resultType, textResultForLlm: JSON.stringify({ issues: [issue("INVALID-1")] }),
            error: "Execution did not succeed",
        }));
        await assert.rejects(fetchOpenSprintIssues(session, identifiers), (error) => {
            assert.equal(error.code, "jira_search_failed");
            assert.equal(error.cause.message, "Execution did not succeed");
            return true;
        });
        assert.equal(calls.length, 1);
    });
}

test("keeps authentication failures actionable", async () => {
    const { session } = makeSession(async () => ({
        resultType: "failure", textResultForLlm: "Unauthorized", error: "Unauthorized",
    }));
    await assert.rejects(fetchOpenSprintIssues(session, identifiers), { code: "jira_mcp_auth_required" });
});

for (const throws of [false, true]) {
    test(`rediscovers a stale tool after ${throws ? "a thrown error" : "a failure result"}`, async () => {
        let stale = true;
        const { session, calls } = makeSession(async () => {
            if (stale) {
                stale = false;
                if (throws) throw new Error("Unknown tool");
                return { resultType: "failure", textResultForLlm: "Unknown tool" };
            }
            return success({ issues: [issue("DASH-1")] });
        });
        session.rpc.tools.getCurrentMetadata = async () => ({
            tools: [searchTool(stale ? "atlassian-old" : "atlassian-new")],
        });
        await fetchOpenSprintIssues(session, identifiers);
        assert.deepEqual(calls.map(({ name }) => name), [
            "atlassian-old-searchJiraIssuesUsingJql", "atlassian-new-searchJiraIssuesUsingJql",
        ]);
    });
}

test("limits stale-tool retries", async () => {
    const { session, calls } = makeSession(async () => { throw new Error("Unknown tool"); });
    await assert.rejects(fetchOpenSprintIssues(session, identifiers), { code: "jira_search_failed" });
    assert.equal(calls.length, 2);
});

test("rejects unrecognized data instead of showing an empty dashboard", async () => {
    for (const payload of [{ errorMessages: ["Invalid JQL"] }, null, { count: 12 }]) {
        const { session } = makeSession(async () => success(payload));
        await assert.rejects(fetchOpenSprintIssues(session, identifiers), { code: "jira_payload_invalid" });
    }
});

test("does not replace missing Jira text with structuredContent", async () => {
    const { session } = makeSession(async () => ({
        resultType: "success", textResultForLlm: "Not JSON",
        structuredContent: { issues: [issue("IGNORED-99")] },
    }));
    await assert.rejects(fetchOpenSprintIssues(session, identifiers), { code: "jira_payload_invalid" });
});

test("keeps every issue when the host redirects large output to a file", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
        ...issue(`DASH-${index + 1}`), fields: { summary: "Long Jira summary ".repeat(100) },
    }));
    const { session, calls } = makeSession(async (_args, page) => page === 1
        ? {
            resultType: "success",
            textResultForLlm: "Output too large. Full output saved to /tmp/synthetic-tool-output.txt",
            contents: [{ type: "text", text: JSON.stringify({ issues: firstPage, nextPageToken: "page-2", isLast: false }) }],
        }
        : success({ issues: [issue("DASH-101")], isLast: true }));
    const result = await fetchOpenSprintIssues(session, identifiers);
    assert.equal(result.issues.length, 101);
    assert.equal(result.issues[100].key, "DASH-101");
    assert.equal(result.partial, false);
    assert.equal(calls.length, 2);
});

test("does not select an unrelated tool by description or name suffix", async () => {
    const { session, calls } = makeSession();
    session.rpc.tools.getCurrentMetadata = async () => ({
        tools: [
            { name: "atlassian-editJiraIssue", mcpServerName: "atlassian", description: "Edit Jira issues found with JQL search" },
            { ...searchTool(), name: "atlassian-otherSearchJiraIssuesUsingJql", mcpToolName: "otherSearchJiraIssuesUsingJql" },
        ],
    });
    await assert.rejects(fetchOpenSprintIssues(session, identifiers), { code: "jira_search_tool_not_found" });
    assert.equal(calls.length, 0);
});

test("reports MCP authentication needs when search is not offered", async () => {
    const { session } = makeSession();
    session.rpc.tools.getCurrentMetadata = async () => ({ tools: [] });
    session.rpc.mcp.list = async () => ({ servers: [{ name: "atlassian", status: "needs-auth" }] });
    await assert.rejects(fetchOpenSprintIssues(session, identifiers), { code: "jira_mcp_auth_required" });
});
