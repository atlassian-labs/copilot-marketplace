import { createServer } from "node:http";
import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import {
    JiraDashboardError,
    fetchOpenSprintIssues,
    requireCanvasOpenInput,
} from "./server/jira-client.mjs";
import {
    buildDashboardModel,
    markDashboardStale,
    renderDashboardHtml,
} from "./ui/dashboard.mjs";
import {
    openAttachedSession,
    StartCopilotError,
    normalizeIssueKey,
    startCopilotForIssue,
} from "./server/start-copilot.mjs";

const instances = new Map();
const MAX_REQUEST_BODY_SIZE = 16 * 1024;
let resolveSessionReady;
const sessionReady = new Promise((resolve) => {
    resolveSessionReady = resolve;
});

function publicCanvasError(error, fallbackCode = "jira_dashboard_failed") {
    if (error instanceof JiraDashboardError) {
        return new CanvasError(error.code, error.publicMessage);
    }
    if (error instanceof StartCopilotError) {
        return new CanvasError(error.code, error.publicMessage);
    }
    if (error instanceof CanvasError) return error;
    return new CanvasError(fallbackCode, "The Jira sprint dashboard could not be loaded.");
}

function writeJson(response, status, value) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
}

function notifyRefresh(entry) {
    for (const client of entry.eventClients) {
        client.write("data: refresh\n\n");
    }
}

function normalizeProjectId(value) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeSessionId(value) {
    return typeof value === "string" ? value.trim() : "";
}

function resolveCanvasIdentifiers(source) {
    const identifiers = requireCanvasOpenInput(source);
    const projectId = normalizeProjectId(source?.projectId);
    return projectId ? { ...identifiers, projectId } : identifiers;
}

function annotateRowsWithSessions(rows, attachedSessions) {
    if (!Array.isArray(rows)) return rows;
    return rows.map((row) => {
        const issueKey = normalizeIssueKey(row?.key);
        if (!issueKey) return row;
        const sessionId = attachedSessions.get(issueKey);
        return sessionId ? { ...row, copilotSessionId: sessionId } : row;
    });
}

function applyAttachedSessions(model, attachedSessions) {
    if (!model || attachedSessions.size === 0) return model;
    return {
        ...model,
        issues: annotateRowsWithSessions(model.issues, attachedSessions),
        topWork: annotateRowsWithSessions(model.topWork, attachedSessions),
        recentCompleted: annotateRowsWithSessions(model.recentCompleted, attachedSessions),
        risks: annotateRowsWithSessions(model.risks, attachedSessions),
    };
}

async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BODY_SIZE) {
            throw new CanvasError(
                "jira_request_too_large",
                "Request payload is too large.",
            );
        }
        chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw new CanvasError(
            "jira_request_invalid_json",
            "Request payload must be valid JSON.",
        );
    }
}

async function startInstanceServer(instanceId) {
    const server = createServer((request, response) => {
        const entry = instances.get(instanceId);
        if (!entry) {
            writeJson(response, 410, { status: "closed" });
            return;
        }

        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && requestUrl.pathname === "/data.json") {
            writeJson(response, 200, entry.model);
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/events") {
            response.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store",
                Connection: "keep-alive",
                "X-Content-Type-Options": "nosniff",
            });
            response.write(": connected\n\n");
            entry.eventClients.add(response);
            request.on("close", () => entry.eventClients.delete(response));
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/") {
            response.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
            });
            response.end(renderDashboardHtml(entry.model));
            return;
        }

        if (request.method === "POST" && requestUrl.pathname === "/start-with-copilot") {
            void (async () => {
                try {
                    const body = await readJsonBody(request);
                    const activeSession = await sessionReady;
                    const started = await startCopilotForIssue(
                        activeSession,
                        entry,
                        body?.issueKey,
                        { instanceId },
                    );
                    writeJson(response, 200, { status: "success", ...started });
                } catch (error) {
                    const canvasError = publicCanvasError(
                        error,
                        "jira_start_with_copilot_failed",
                    );
                    const clientErrorCodes = new Set([
                        "jira_issue_key_invalid",
                        "jira_issue_not_in_dashboard",
                        "jira_issue_session_not_attached",
                        "jira_request_invalid_json",
                        "jira_request_too_large",
                    ]);
                    writeJson(response, clientErrorCodes.has(canvasError.code) ? 400 : 500, {
                        status: "error",
                        code: canvasError.code,
                        message: canvasError.message,
                    });
                }
            })();
            return;
        }

        if (request.method === "POST" && requestUrl.pathname === "/open-session") {
            void (async () => {
                try {
                    const body = await readJsonBody(request);
                    const activeSession = await sessionReady;
                    const opened = await openAttachedSession(
                        activeSession,
                        entry,
                        body?.issueKey,
                    );
                    writeJson(response, 200, { status: "success", ...opened });
                } catch (error) {
                    const canvasError = publicCanvasError(
                        error,
                        "jira_open_attached_session_failed",
                    );
                    const clientErrorCodes = new Set([
                        "jira_issue_key_invalid",
                        "jira_issue_not_in_dashboard",
                        "jira_issue_session_not_attached",
                        "jira_request_invalid_json",
                        "jira_request_too_large",
                    ]);
                    writeJson(response, clientErrorCodes.has(canvasError.code) ? 400 : 500, {
                        status: "error",
                        code: canvasError.code,
                        message: canvasError.message,
                    });
                }
            })();
            return;
        }

        writeJson(response, 404, { status: "not_found" });
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        await new Promise((resolve) => server.close(resolve));
        throw new CanvasError("jira_canvas_server_failed", "The dashboard server could not start.");
    }
    return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function loadFreshModel(identifiers) {
    const activeSession = await sessionReady;
    const result = await fetchOpenSprintIssues(activeSession, identifiers);
    return buildDashboardModel(
        result.issues,
        identifiers.siteUrl,
        result.fetchedAt,
        result.partial,
    );
}

async function refreshEntry(entry) {
    const model = await loadFreshModel(entry.identifiers);
    if (!entry.attachedSessions) entry.attachedSessions = new Map();
    entry.model = applyAttachedSessions(model, entry.attachedSessions);
    notifyRefresh(entry);
    return entry.model;
}

async function closeInstance(instanceId) {
    const entry = instances.get(instanceId);
    if (!entry) return;
    instances.delete(instanceId);
    for (const client of entry.eventClients) client.end();
    entry.eventClients.clear();
    await new Promise((resolve) => entry.server.close(resolve));
}

const dashboardCanvas = createCanvas({
    id: "jira-sprint-dashboard-canvas",
    displayName: "Jira Sprint Dashboard",
    description: "A live, read-only dashboard for Jira issues in currently open sprints.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["cloudId", "siteUrl"],
        properties: {
            cloudId: { type: "string", minLength: 1 },
            siteUrl: { type: "string", pattern: "^https://" },
            projectId: { type: "string", minLength: 1 },
        },
    },
    actions: [
        {
            name: "refresh_dashboard",
            description: "Refresh the dashboard from Jira while retaining last-good data if refresh fails.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {},
            },
            handler: async (context) => {
                const entry = instances.get(context.instanceId);
                if (!entry) {
                    throw new CanvasError(
                        "jira_canvas_instance_not_found",
                        "Open the Jira sprint dashboard before refreshing it.",
                    );
                }
                try {
                    const model = await refreshEntry(entry);
                    return {
                        status: "success",
                        refreshedAt: model.context.refreshedAt,
                        counts: Object.fromEntries(model.stats.map((stat) => [stat.label, stat.value])),
                    };
                } catch (error) {
                    entry.model = markDashboardStale(entry.model);
                    notifyRefresh(entry);
                    const canvasError = publicCanvasError(error, "jira_refresh_failed");
                    return {
                        status: "error",
                        code: canvasError.code,
                        message: "Refresh failed; the dashboard is showing its last successful data.",
                    };
                }
            },
        },
        {
            name: "attach_session",
            description: "Attach a created Copilot session to a Jira issue row in this dashboard.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["issueKey", "sessionId"],
                properties: {
                    issueKey: { type: "string", minLength: 1 },
                    sessionId: { type: "string", minLength: 1 },
                },
            },
            handler: async (context) => {
                const entry = instances.get(context.instanceId);
                if (!entry) {
                    throw new CanvasError(
                        "jira_canvas_instance_not_found",
                        "Open the Jira sprint dashboard before attaching sessions.",
                    );
                }

                const issueKey = normalizeIssueKey(context.input?.issueKey);
                if (!issueKey) {
                    throw new CanvasError(
                        "jira_issue_key_invalid",
                        "A valid Jira issue key is required.",
                    );
                }

                const sessionId = normalizeSessionId(context.input?.sessionId);
                if (!sessionId) {
                    throw new CanvasError(
                        "jira_session_id_invalid",
                        "A valid Copilot session ID is required.",
                    );
                }

                const issues = Array.isArray(entry.model?.issues) ? entry.model.issues : [];
                const inDashboard = issues.some((issue) => normalizeIssueKey(issue?.key) === issueKey);
                if (!inDashboard) {
                    throw new CanvasError(
                        "jira_issue_not_in_dashboard",
                        "The selected Jira issue is no longer present in this dashboard. Refresh and try again.",
                    );
                }

                if (!entry.attachedSessions) entry.attachedSessions = new Map();
                entry.attachedSessions.set(issueKey, sessionId);
                entry.model = applyAttachedSessions(entry.model, entry.attachedSessions);
                notifyRefresh(entry);

                return {
                    status: "success",
                    issueKey,
                    sessionId,
                };
            },
        },
    ],
    open: async (context) => {
        const existing = instances.get(context.instanceId);
        let identifiers;
        try {
            identifiers = resolveCanvasIdentifiers(context.input);
            const model = await loadFreshModel(identifiers);
            let entry = existing;
            if (!entry) {
                const attachedSessions = new Map();
                const serverInfo = await startInstanceServer(context.instanceId);
                entry = {
                    ...serverInfo,
                    identifiers,
                    model: applyAttachedSessions(model, attachedSessions),
                    eventClients: new Set(),
                    attachedSessions,
                };
                instances.set(context.instanceId, entry);
            } else {
                if (!entry.attachedSessions) entry.attachedSessions = new Map();
                const sameSite = entry.identifiers.cloudId === identifiers.cloudId
                    && entry.identifiers.siteUrl === identifiers.siteUrl
                    && normalizeProjectId(entry.identifiers.projectId) === normalizeProjectId(identifiers.projectId);
                if (!sameSite) entry.attachedSessions.clear();
                entry.identifiers = identifiers;
                entry.model = applyAttachedSessions(model, entry.attachedSessions);
                notifyRefresh(entry);
            }
            return {
                title: "Jira Sprint Dashboard",
                status: model.quality.partial ? "Partial Jira data" : "Live Jira data",
                url: entry.url,
            };
        } catch (error) {
            const isSameSite = existing
                && identifiers
                && existing.identifiers.cloudId === identifiers.cloudId
                && existing.identifiers.siteUrl === identifiers.siteUrl
                && normalizeProjectId(existing.identifiers.projectId) === normalizeProjectId(identifiers.projectId);
            if (isSameSite) {
                existing.model = markDashboardStale(existing.model);
                notifyRefresh(existing);
                return {
                    title: "Jira Sprint Dashboard",
                    status: "Stale Jira data",
                    url: existing.url,
                };
            }
            throw publicCanvasError(error);
        }
    },
    onClose: async (context) => {
        await closeInstance(context.instanceId);
    },
});

const session = await joinSession({
    enableMcpApps: true,
    canvases: [dashboardCanvas],
});
resolveSessionReady(session);
