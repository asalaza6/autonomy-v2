import type { IncomingHttpHeaders } from 'http';
import type { AnyRecord, ControlPlaneJobRecord } from '../../types.js';
import { loadCustomAgentConfigs } from '../orchestrator/custom-agents.js';
import {
  createControlPlaneDeployJob,
  createControlPlaneJob,
  createControlPlanePackageUpdateJob,
  enqueueJob,
  listDiscoveredRepos,
  listJobs,
  loadControlPlaneState,
} from './control-plane-store.js';
import {
  validateDeploySubmission,
  validatePackageUpdateSubmission,
  validatePrdAddSubmission,
} from './control-plane-validation.js';

type AgentToolRequest = {
  method: string;
  pathname: string;
  searchParams?: URLSearchParams;
  headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  body?: AnyRecord;
  env?: NodeJS.ProcessEnv;
};

function handleAgentToolRequest(rootDir: string, request: AgentToolRequest) {
  const auth = authenticateAgentToolRequest(rootDir, request.headers || {}, request.env || process.env);
  if (!auth.ok) {
    return {
      statusCode: 401,
      payload: { error: auth.error },
    };
  }

  const method = String(request.method || 'GET').toUpperCase();
  const pathname = normalizeToolPath(request.pathname);
  const body = request.body || {};
  const searchParams = request.searchParams || new URLSearchParams();

  if (method === 'GET' && pathname === '/status') {
    const repoId = String(searchParams.get('repoId') || '').trim();
    const state = loadControlPlaneState(rootDir);
    const jobs = listJobs(rootDir, repoId ? { repoId } : {});
    return {
      statusCode: 200,
      payload: {
        ok: true,
        repoId: repoId || null,
        repoStatus: repoId ? state.repoStatuses[repoId] || null : null,
        jobs,
        serverTime: new Date().toISOString(),
      },
    };
  }

  if (method === 'POST' && pathname === '/prd/check') {
    const repoId = String(body.repoId || '').trim();
    const prdId = String(body.id || body.prdId || '').trim();
    const jobs = listJobs(rootDir, {
      repoId,
      type: 'prd:add',
    } as Partial<ControlPlaneJobRecord>).filter((job) => {
      if (!prdId) {
        return true;
      }
      return String((job.payload as AnyRecord).id || '').trim() === prdId;
    });
    return {
      statusCode: 200,
      payload: {
        ok: true,
        repoId,
        prdId: prdId || null,
        existingJobs: jobs,
      },
    };
  }

  if (method === 'POST' && pathname === '/prd/propose') {
    const { payload } = validatePrdAddSubmission(listDiscoveredRepos(rootDir), body);
    const job = enqueueJob(rootDir, createControlPlaneJob({
      ...payload,
      source: {
        ...((payload as AnyRecord).source || {}),
        kind: 'agent-tool',
        createdAt: new Date().toISOString(),
      },
    }));
    return {
      statusCode: 201,
      payload: {
        ok: true,
        job,
      },
    };
  }

  if (method === 'POST' && pathname === '/deploy') {
    const { payload } = validateDeploySubmission(listDiscoveredRepos(rootDir), body);
    const job = enqueueJob(rootDir, createControlPlaneDeployJob(payload));
    return {
      statusCode: 201,
      payload: {
        ok: true,
        job,
      },
    };
  }

  if (method === 'POST' && pathname === '/package-update') {
    const { payload } = validatePackageUpdateSubmission(listDiscoveredRepos(rootDir), body);
    const job = enqueueJob(rootDir, createControlPlanePackageUpdateJob(payload));
    return {
      statusCode: 201,
      payload: {
        ok: true,
        job,
      },
    };
  }

  const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/);
  if (method === 'GET' && jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const job = listJobs(rootDir).find((entry) => entry.id === jobId) || null;
    return job
      ? { statusCode: 200, payload: { ok: true, job } }
      : { statusCode: 404, payload: { error: 'Unknown job.' } };
  }

  return {
    statusCode: 404,
    payload: { error: 'Unknown agent tool endpoint.' },
  };
}

function authenticateAgentToolRequest(
  rootDir: string,
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env
) {
  const acceptedTokens = collectAgentToolTokens(rootDir, env);
  if (acceptedTokens.length === 0) {
    return {
      ok: false,
      error: 'No Autonomy agent-tool token env is configured.',
    };
  }
  const headerNames = collectAgentToolAuthHeaders(rootDir, env);
  const providedToken = extractAgentToolToken(headers, headerNames);
  if (!providedToken) {
    return {
      ok: false,
      error: `Missing agent-tool auth header (${headerNames.join(' or ')}).`,
    };
  }
  if (!acceptedTokens.includes(providedToken)) {
    return {
      ok: false,
      error: 'Invalid agent-tool token.',
    };
  }
  return { ok: true };
}

function collectAgentToolTokens(rootDir: string, env: NodeJS.ProcessEnv = process.env) {
  const explicitTokens = [
    env.AUTONOMY_AGENT_TOOL_TOKEN,
    env.AUTONOMY_AGENT_TOOLS_TOKEN,
    env.AUTONOMY_AGENT_TOOL_TOKENS,
    env.AUTONOMY_AGENT_TOOLS_TOKENS,
  ].flatMap(splitCsv);
  const configuredTokenEnvNames = [
    ...splitCsv(env.AUTONOMY_AGENT_TOOL_TOKEN_ENVS),
    ...splitCsv(env.AUTONOMY_AGENT_TOOLS_TOKEN_ENVS),
    ...collectConfiguredAgentToolEnvNames(rootDir),
  ];
  const configuredTokens = configuredTokenEnvNames
    .map((envName) => String(env[envName] || '').trim())
    .filter(Boolean);
  return uniqueStrings([...explicitTokens, ...configuredTokens]);
}

function collectAgentToolAuthHeaders(rootDir: string, env: NodeJS.ProcessEnv = process.env) {
  const configuredHeaders = collectConfiguredAgentToolAuthHeaders(rootDir);
  return uniqueStrings([
    env.AUTONOMY_AGENT_TOOL_AUTH_HEADER,
    env.AUTONOMY_AGENT_TOOLS_AUTH_HEADER,
    'x-autonomy-agent-key',
    'authorization',
    ...configuredHeaders,
  ].map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean));
}

function collectConfiguredAgentToolEnvNames(rootDir: string) {
  try {
    return loadCustomAgentConfigs(rootDir).flatMap((config) => {
      const agents = Array.isArray(config.agents) ? config.agents : [];
      return agents.flatMap((agent) => Object.values(agent && agent.tools || {})
        .map((tool: AnyRecord) => String(tool && tool.authEnv || '').trim())
        .filter(Boolean));
    });
  } catch (_) {
    return [];
  }
}

function collectConfiguredAgentToolAuthHeaders(rootDir: string) {
  try {
    return loadCustomAgentConfigs(rootDir).flatMap((config) => Object.values(config.agentTools || {})
      .map((tool: AnyRecord) => String(tool && tool.authHeader || '').trim())
      .filter(Boolean));
  } catch (_) {
    return [];
  }
}

function extractAgentToolToken(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  headerNames: string[]
) {
  for (const headerName of headerNames) {
    const raw = headers[headerName] || headers[headerName.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const normalized = String(value || '').trim();
    if (!normalized) {
      continue;
    }
    if (headerName === 'authorization' && /^bearer\s+/i.test(normalized)) {
      return normalized.replace(/^bearer\s+/i, '').trim();
    }
    return normalized;
  }
  return '';
}

function normalizeToolPath(pathname: string) {
  const normalized = String(pathname || '').replace(/\/+$/, '') || '/';
  return normalized.startsWith('/api/agent-tools')
    ? normalized.slice('/api/agent-tools'.length) || '/'
    : normalized;
}

function splitCsv(value: unknown) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

export {
  authenticateAgentToolRequest,
  collectAgentToolTokens,
  handleAgentToolRequest,
};
