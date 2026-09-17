#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const target = input.target || {};
const run = input.run || {};
const prdPath = path.join(repoRoot, String(run.prdRelativePath || target.path || ''));
const prd = readJsonFile(prdPath, {});
const projectContext = readText(path.join(repoRoot, 'prompts', 'autonomous', 'v2', 'project-context.md'));
const systemPrompt = readText(path.join(repoRoot, 'prompts', 'autonomous', 'v2', 'custom', 'agents', 'shadow-pm-agent', 'system.md'));
const agentsConfig = readJsonFile(path.join(repoRoot, 'prompts', 'autonomous', 'v2', 'config', 'custom-lifecycle-agents.json'), {});

writeJson({
  prompt: [
    systemPrompt,
    '',
    'Project context:',
    fenced(projectContext),
    '',
    'Planning target:',
    fenced(JSON.stringify({ target, promotion: run.promotion || null, prdPath: path.relative(repoRoot, prdPath), prd }, null, 2)),
    '',
    'Available custom lifecycle agents:',
    fenced(JSON.stringify((agentsConfig.agents || []).map((agent) => ({
      id: agent.id,
      type: agent.type,
      target: agent.target || {},
    })), null, 2)),
    '',
    'Create or update implementation work only in .autonomy/runtime/custom-lifecycle/queues/shadow-architecture-agent.json.',
    'Do not write to prompts/autonomous/v2/queues; those files belong to the packaged legacy framework.',
    'Do not write mutable queue or PRD state under prompts/autonomous/v2/custom; those files are tracked templates only.',
    'Mark planning state in .autonomy/runtime/custom-lifecycle/prd-state/<prd-id>.json.',
    'If this PRD id has old terminal/merged/archived tasks from a previous generation, treat them as history only. Do not reuse them as current planning proof; create fresh pending tasks for the active or queued PRD generation.',
    'Do not edit application source code.',
    'Each created task must include id, title, description, agentId, prdId, laneKey, type, sprintId, baseBranch, checks, acceptance, status, createdAt, and updatedAt.',
    'Set agentId to shadow-architecture-agent.',
    'Prefer shadow-architecture-agent for implementation work in this repository.',
  ].join('\n'),
});

function fenced(value) {
  return ['```', String(value || '').trim(), '```'].join('\n');
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
