const OPEN_SPRINT_JQL = "sprint in openSprints() ORDER BY priority DESC, Rank ASC";
const SEARCH_FIELDS = [
    "summary",
    "status",
    "assignee",
    "priority",
    "issuetype",
    "created",
    "updated",
    "resolutiondate",
    "duedate",
    "parent",
    "issuelinks",
    "labels",
    "components",
    "fixVersions",
    "sprint",
];
const PAGE_SIZE = 100;
const MAX_ISSUES = 2000;
const MAX_PAGES = 25;

const SEARCH_TOOL = "searchJiraIssuesUsingJql";
let cachedSearchMapping = null;

export class JiraDashboardError extends Error {
    constructor(code, publicMessage, cause) {
        super(publicMessage, cause ? { cause } : undefined);
        this.name = "JiraDashboardError";
        this.code = code;
        this.publicMessage = publicMessage;
    }
}

export function normalizeSiteOrigin(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" ? url.origin.toLowerCase() : "";
    } catch {
        return "";
    }
}

export function requireCanvasOpenInput(source) {
    const cloudId = typeof source?.cloudId === "string" ? source.cloudId.trim() : "";
    const siteUrl = normalizeSiteOrigin(source?.siteUrl);
    if (!cloudId || !siteUrl) {
        throw new JiraDashboardError(
            "jira_canvas_input_missing",
            "Resolved Jira site identifiers are required.",
        );
    }
    return { cloudId, siteUrl };
}

function selectSearchTool(tools) {
    return tools?.find((tool) => tool.mcpToolName === SEARCH_TOOL)?.name ?? "";
}

async function discoverSearchMapping(session) {
    if (cachedSearchMapping) return cachedSearchMapping;

    const tools = session.rpc.tools;

    let searchToolName;
    try {
        let metadata = await tools.getCurrentMetadata();
        searchToolName = selectSearchTool(metadata?.tools);
        if (!searchToolName && typeof tools.initializeAndValidate === "function") {
            // Canvas rehydration can run before the session's first agent turn.
            await tools.initializeAndValidate();
            metadata = await tools.getCurrentMetadata();
            searchToolName = selectSearchTool(metadata?.tools);
        }
    } catch (error) {
        throw new JiraDashboardError(
            "jira_tool_discovery_failed",
            "Copilot could not load the session's Jira tools. Reopen the session and try again.",
            error,
        );
    }

    if (searchToolName) {
        cachedSearchMapping = { searchToolName };
        return cachedSearchMapping;
    }

    // MCP connection state is only used to explain missing session tools.
    let listing;
    try {
        listing = await session.rpc.mcp.list();
    } catch (error) {
        throw new JiraDashboardError(
            "jira_mcp_not_found",
            "Connect the Atlassian MCP server, then open the dashboard again.",
            error,
        );
    }

    const servers = Array.isArray(listing?.servers) ? listing.servers : [];
    const needsAuth = servers.some((server) => server?.status === "needs-auth");
    const connected = servers.filter((server) => server?.status === "connected");

    if (needsAuth) {
        throw new JiraDashboardError(
            "jira_mcp_auth_required",
            "Authenticate the Atlassian MCP connection, then open the dashboard again.",
        );
    }
    if (connected.length === 0) {
        throw new JiraDashboardError(
            "jira_mcp_not_found",
            "Connect the Atlassian MCP server, then open the dashboard again.",
        );
    }
    throw new JiraDashboardError(
        "jira_search_tool_not_found",
        "Jira JQL search is not available in this Copilot session. Enable the Jira search tool and reopen the dashboard.",
    );
}

function mappingMayBeStale(error) {
    const message = String(error?.message ?? "").toLowerCase();
    return message.includes("not connected")
        || message.includes("unknown tool")
        || message.includes("tool not found")
        || message.includes("not in the current tool")
        || message.includes("not in the offered tool")
        || message.includes("server not found")
        || message.includes("no such tool");
}

async function callSearchTool(session, argumentsValue, mayRediscover = true) {
    const mapping = await discoverSearchMapping(session);
    try {
        const result = await session.rpc.tools.execute({
            name: mapping.searchToolName,
            arguments: argumentsValue,
        });
        if (typeof result !== "string" && result?.resultType !== "success") {
            throw new Error(result?.error || result?.textResultForLlm || "Invalid tool execution result");
        }
        return result;
    } catch (error) {
        if (mayRediscover && mappingMayBeStale(error)) {
            cachedSearchMapping = null;
            return callSearchTool(session, argumentsValue, false);
        }
        const message = String(error?.message ?? "").toLowerCase();
        if (message.includes("auth") || message.includes("unauthorized")) {
            throw new JiraDashboardError(
                "jira_mcp_auth_required",
                "Authenticate the Atlassian MCP connection, then refresh the dashboard.",
                error,
            );
        }
        throw new JiraDashboardError(
            "jira_search_failed",
            "Jira search failed. Check the connection and try again.",
            error,
        );
    }
}

function parseJsonText(value) {
    if (typeof value !== "string") return value;
    const text = value.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    try {
        return JSON.parse(text);
    } catch {
        return value;
    }
}

function unwrapToolContent(result) {
    // tools.execute returns ToolResult, not an MCP CallToolResult. Only use
    // model-facing text; structuredContent can contain a separate UI model.
    const textResult = typeof result === "string" ? result : result?.textResultForLlm;
    const parsedText = parseJsonText(textResult);
    if (parsedText && typeof parsedText === "object") return parsedText;

    const payloads = [];
    for (const part of Array.isArray(result?.contents) ? result.contents : []) {
        if (part?.type === "text" && typeof part?.text === "string") {
            const parsed = parseJsonText(part.text);
            if (parsed && typeof parsed === "object") payloads.push(parsed);
        }
    }

    if (payloads.length === 1) return payloads[0];
    if (payloads.length === 0) {
        throw new JiraDashboardError(
            "jira_payload_invalid",
            "Jira returned data in an unsupported format.",
        );
    }

    const recognized = payloads.filter((payload) =>
        Array.isArray(payload)
        || Array.isArray(payload?.issues)
        || Array.isArray(payload?.values)
        || Array.isArray(payload?.resources));
    if (recognized.length === 1) return recognized[0];
    throw new JiraDashboardError(
        "jira_payload_invalid",
        "Jira returned ambiguous data.",
    );
}

function firstArray(...values) {
    return values.find(Array.isArray);
}

function extractSearchPage(payload) {
    const issues = firstArray(
        payload?.issues?.nodes,
        payload?.issues,
        payload?.nodes,
        payload?.items,
        payload?.results,
        payload?.data?.issues,
        payload?.result?.issues,
        payload?.result?.items,
        Array.isArray(payload) ? payload : undefined,
    );
    if (!issues) {
        throw new JiraDashboardError(
            "jira_payload_invalid",
            "Jira returned data in an unsupported format.",
        );
    }
    const pageInfo = payload?.issues?.pageInfo ?? payload?.pageInfo ?? {};
    const token = payload?.nextPageToken
        ?? (pageInfo?.hasNextPage ? pageInfo?.endCursor : undefined);
    return {
        issues,
        nextPageToken: payload?.isLast ? null : token || null,
    };
}

export async function fetchOpenSprintIssues(session, identifiers) {
    const issuesByKey = new Map();
    const seenCursors = new Set();
    let nextPageToken = null;
    let partial = false;
    let partialReason = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const args = {
            cloudId: identifiers.cloudId,
            jql: OPEN_SPRINT_JQL,
            fields: SEARCH_FIELDS,
            maxResults: PAGE_SIZE,
        };
        if (nextPageToken) args.nextPageToken = nextPageToken;

        const result = await callSearchTool(session, args);
        const payload = unwrapToolContent(result);
        const pageData = extractSearchPage(payload);

        for (const issue of pageData.issues) {
            const key = typeof issue?.key === "string" ? issue.key.trim() : "";
            if (key) issuesByKey.set(key.toUpperCase(), issue);
            if (issuesByKey.size >= MAX_ISSUES) {
                partial = true;
                partialReason = "issue_limit";
                break;
            }
        }

        if (partial || !pageData.nextPageToken) break;
        if (seenCursors.has(pageData.nextPageToken)) {
            partial = true;
            partialReason = "cursor_loop";
            break;
        }
        seenCursors.add(pageData.nextPageToken);
        nextPageToken = pageData.nextPageToken;

        if (page === MAX_PAGES - 1) {
            partial = true;
            partialReason = "page_limit";
        }
    }

    return {
        issues: [...issuesByKey.values()],
        fetchedAt: new Date().toISOString(),
        partial,
        partialReason,
    };
}
