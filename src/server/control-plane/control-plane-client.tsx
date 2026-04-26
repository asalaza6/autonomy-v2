/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { Fragment, h, renderToHtml } from './control-plane-jsx-runtime/jsx-runtime.js';
import { PackageStatus, VersionStatus } from './control-plane-version-view.js';
import type { PackageStatusSummary, VersionStatusSummary } from './control-plane-version-view.js';
import {
  buildPrdSubmissionFromProposal,
  extractPrdProposalFromText,
  getPrdProposalStableKey,
  normalizePrdProposal,
} from './control-plane-prd-proposal.js';
import { selectActivePullRequestStatusForPrd } from '../../autonomy-v2/control-plane/status-view.js';
import type { ControlPlanePrdProposal, ControlPlanePrdSourceChat } from '../../types.js';

declare global {
  interface Window {
    __AUTONOMY_CONTROL_PLANE_DEV__?: boolean;
    __AUTONOMY_CONTROL_PLANE_DEV_TOKEN__?: string;
    __AUTONOMY_CONTROL_PLANE_API_BASE_URL__?: string;
  }
}

type RepoRecord = {
  repoId: string;
  label: string;
  description?: string;
  default?: boolean;
  deploymentUrl?: string;
  deploymentLabel?: string;
};

type PrdSummary = {
  id?: string;
  title?: string;
  status?: string;
  stateLabel?: string;
  detail?: string;
  specification?: string;
  requirements?: string[];
  tasks?: PrdTaskSummary[];
  plannedTaskCount?: number;
  completedTaskCount?: number;
  remainingTaskCount?: number;
  progressPercent?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  archived?: boolean;
  archivePath?: string | null;
  sourceChat?: PrdSourceChatSummary | null;
};

type PrdSourceChatSummary = ControlPlanePrdSourceChat;

type PrdTaskSummary = {
  id?: string;
  title?: string;
  agentId?: string;
  description?: string;
  acceptance?: string[];
  sprintId?: string;
};

type PrdRunStep = {
  id?: string;
  label?: string;
  state?: string;
  detail?: string;
};

type PrdRunSummary = {
  currentStepId?: string;
  currentStepLabel?: string;
  detail?: string;
  steps?: PrdRunStep[];
};

type AgentSummary = {
  role?: string;
  agentId?: string;
  workerStatus?: string;
  detail?: string;
  pid?: number;
};

type PullRequestSummary = {
  title?: string;
  prId?: string;
  prdId?: string | null;
  number?: number | null;
  statusLabel?: string;
  status?: string;
  mergeState?: string;
  mergeBlockedCode?: string;
  mergeBlockedReason?: string;
  action?: string;
  branch?: string;
  url?: string | null;
  updatedAt?: string | null;
};

type JobSummary = {
  id?: string;
  type?: string;
  title?: string;
  status?: string;
  statusLabel?: string;
  detail?: string;
  repoId?: string;
  repoLabel?: string;
  updatedAt?: string | null;
  createdAt?: string | null;
  action?: string;
  branch?: string;
  restartEvidence?: RestartEvidenceSummary | null;
};

type RestartEvidenceTargetSummary = {
  target?: string;
  label?: string;
  status?: string;
  statusLabel?: string;
  reason?: string | null;
  reasonLabel?: string | null;
  mode?: string | null;
  modeLabel?: string | null;
  command?: string | null;
  cwd?: string | null;
  preRestartPid?: number | null;
  postRestartPid?: number | null;
  recordedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
  pidChanged?: boolean | null;
  compactLabel?: string;
};

type RestartEvidenceSummary = {
  status?: string;
  statusLabel?: string;
  completedAt?: string | null;
  helperStatus?: string | null;
  compactSummary?: string;
  allTargetsRelaunched?: boolean;
  allTargetsChangedPid?: boolean;
  relaunchedTargetCount?: number;
  pidChangedTargetCount?: number;
  targets?: RestartEvidenceTargetSummary[];
};

type ChatMessageSummary = {
  id?: string;
  role?: 'manager' | 'agent';
  content?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: 'queued' | 'responding' | 'complete' | 'failed';
  jobId?: string;
  error?: string;
  prdProposal?: ControlPlanePrdProposal;
};

type ChatConversationSummary = {
  id?: string;
  repoId?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  messages?: ChatMessageSummary[];
};

type HeartbeatSummary = {
  label?: string;
  status?: string;
  statusLabel?: string;
  detail?: string;
  updatedAt?: string | null;
};

type ControlPlaneHeartbeatSummary = {
  overallStatus?: string;
  statusLabel?: string;
  server?: HeartbeatSummary;
  bridge?: HeartbeatSummary;
};

type RepoSummary = {
  repoId?: string;
  label?: string;
  description?: string;
  default?: boolean;
  updatedAt?: string | null;
  overview?: string;
  freshnessStatus?: string;
  freshnessStatusLabel?: string;
  freshnessDetail?: string;
  activePrd?: PrdSummary | null;
  queuedPrds?: PrdSummary[];
  prdRun?: PrdRunSummary | null;
  prdHistory?: PrdSummary[];
  agentStatuses?: AgentSummary[];
  pullRequestStatuses?: PullRequestSummary[];
  deployment?: {
    sourceBranch?: string;
    targetBranch?: string;
    sourceAheadBy?: number;
    targetAheadBy?: number;
    branchesAligned?: boolean;
    hasChanges?: boolean;
    deployable?: boolean;
    status?: string;
    statusLabel?: string;
    detail?: string;
  } | null;
  deploymentUrl?: string | null;
  deploymentLabel?: string | null;
  deployJob?: JobSummary | null;
  prdResetJob?: JobSummary | null;
  restartJob?: JobSummary | null;
  versionStatus?: VersionStatusSummary | null;
  packageStatus?: PackageStatusSummary | null;
  packageUpdateJob?: JobSummary | null;
};

type DashboardSummary = {
  repoCount?: number;
  activePrdCount?: number;
  queuedPrdCount?: number;
  deployableRepoCount?: number;
  pendingJobCount?: number;
  runningAgentCount?: number;
  activePullRequestCount?: number;
  overallHeartbeatStatus?: string;
  statusLabel?: string;
  serverHeartbeat?: HeartbeatSummary;
  bridgeHeartbeat?: HeartbeatSummary;
  repos?: RepoSummary[];
  jobs?: JobSummary[];
};

type StateSnapshot = {
  dashboard?: DashboardSummary;
  jobs?: JobSummary[];
  conversations?: Record<string, ChatConversationSummary[]>;
  [key: string]: unknown;
};

type ProjectProgressPullRequestAction = {
  href: string;
  label: string;
};

type EntranceContext = {
  entrance: 'manager' | 'project';
  repoId: string;
};

type ChatPrdDraftState = {
  key: string;
  proposal: ControlPlanePrdProposal;
  title: string;
  specification: string;
  requirements: string[];
  sprintId: string;
  taskSpecsRaw: string;
  updatedAt: string;
};

const repoSelect = document.getElementById('repo-id') as HTMLSelectElement | null;
const lastUpdatedEl = document.getElementById('last-updated');
const messageEl = document.getElementById('form-message');
const form = document.getElementById('prd-form') as HTMLFormElement | null;
const prdTitleEl = document.getElementById('prd-title') as HTMLInputElement | null;
const prdSpecEl = document.getElementById('prd-spec') as HTMLTextAreaElement | null;
const prdReqEl = document.getElementById('prd-req') as HTMLTextAreaElement | null;
const prdSprintEl = document.getElementById('prd-sprint') as HTMLInputElement | null;
const prdTaskSpecsEl = document.getElementById('prd-task-specs') as HTMLTextAreaElement | null;
const chatPrdDraftPanelEl = document.getElementById('chat-prd-draft-panel');
const chatPrdDraftTitleEl = document.getElementById('chat-prd-draft-title');
const chatPrdDraftMetaEl = document.getElementById('chat-prd-draft-meta');
const openChatPrdReviewButton = document.getElementById('open-chat-prd-review');
const discardChatPrdDraftButton = document.getElementById('discard-chat-prd-draft');
const chatPrdReviewModalEl = document.getElementById('chat-prd-review-modal');
const chatPrdReviewMetaEl = document.getElementById('chat-prd-review-meta');
const chatPrdReviewContentEl = document.getElementById('chat-prd-review-content');
const closeChatPrdReviewButton = document.getElementById('close-chat-prd-review');
const backChatPrdReviewButton = document.getElementById('back-chat-prd-review');
const submitChatPrdReviewButton = document.getElementById('submit-chat-prd-review');
const refreshButton = document.getElementById('refresh-button');
const dashboardMetricsEl = document.getElementById('dashboard-metrics');
const dashboardReposEl = document.getElementById('dashboard-repos');
const dashboardJobsEl = document.getElementById('dashboard-jobs');
const dashboardSummaryNoteEl = document.getElementById('dashboard-summary-note');
const controlPlaneHeartbeatsEl = document.getElementById('control-plane-heartbeats');
const rawStateEl = document.getElementById('raw-state');
const rawDashboardEl = document.getElementById('raw-dashboard');
const rawJobsEl = document.getElementById('raw-jobs');
const rawReposEl = document.getElementById('raw-repos');
const fixedRepoIdEl = document.getElementById('fixed-repo-id');
const mainHeroActionLabelEl = document.getElementById('main-hero-action-label');
const mainProgressTitleEl = document.getElementById('main-progress-title');
const mainProgressDetailEl = document.getElementById('main-progress-detail');
const mainProgressStatsEl = document.getElementById('main-progress-stats');
const mainProgressFillEl = document.getElementById('main-progress-fill');
const mainProgressStepsEl = document.getElementById('main-progress-steps');
const mainProgressActionsEl = document.getElementById('main-progress-actions');
const mainDeployActionsEl = document.getElementById('main-deploy-actions');
const prdHistorySummaryEl = document.getElementById('prd-history-summary');
const prdHistoryListEl = document.getElementById('prd-history-list');
const prdHistoryDetailEl = document.getElementById('prd-history-detail');
const openPrdModalButton = document.getElementById('open-prd-modal');
const closePrdModalButton = document.getElementById('close-prd-modal');
const prdModalEl = document.getElementById('prd-modal');
const quickPrdForm = document.getElementById('quick-prd-form') as HTMLFormElement | null;
const quickPrdSpecEl = document.getElementById('quick-prd-spec') as HTMLTextAreaElement | null;
const quickFormMessageEl = document.getElementById('quick-form-message');
const chatConversationSelect = document.getElementById('chat-conversation-select') as HTMLSelectElement | null;
const newChatButton = document.getElementById('new-chat-button');
const chatRefreshButton = document.getElementById('chat-refresh-button');
const chatThreadEl = document.getElementById('chat-thread');
const chatJumpLatestButton = document.getElementById('chat-jump-latest') as HTMLButtonElement | null;
const chatForm = document.getElementById('chat-form') as HTMLFormElement | null;
const chatInputEl = document.getElementById('chat-input') as HTMLTextAreaElement | null;
const chatMessageEl = document.getElementById('chat-message');
const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-tab]'));
const panels: Record<string, HTMLElement | null> = {
  main: document.getElementById('main-panel'),
  chat: document.getElementById('chat-panel'),
  history: document.getElementById('history-panel'),
  dashboard: document.getElementById('dashboard-panel'),
  submit: document.getElementById('submit-panel'),
  advanced: document.getElementById('advanced-panel'),
};
const entranceContext = readEntranceContext();
const apiBaseUrl = String(window.__AUTONOMY_CONTROL_PLANE_API_BASE_URL__ || '').trim().replace(/\/+$/, '');
const NEW_CHAT_VALUE = '__new__';
const CHAT_PRD_DRAFT_STORAGE_PREFIX = 'autonomy.controlPlane.chatPrdDraft';
const CHAT_NEAR_BOTTOM_THRESHOLD_PX = 96;

let latestRepos: RepoRecord[] = [];
let latestDashboard: DashboardSummary = {};
let latestConversations: ChatConversationSummary[] = [];
let deployingRepoIds = new Set<string>();
let resettingPrdRepoIds = new Set<string>();
let updatingPackageRepoIds = new Set<string>();
let restartingRepoIds = new Set<string>();
let devUiToken = String(window.__AUTONOMY_CONTROL_PLANE_DEV_TOKEN__ || '');
let selectedHistoryPrdId = '';
let preferredHistoryPrdId = '';
let prdHistoryContinueMessagePrdId = '';
let prdHistoryContinueMessage = '';
let selectedChatConversationId = '';
let activeChatPrdDraft: ChatPrdDraftState | null = null;
let chatPrdReviewModalOpen = false;
let forceChatScrollToLatest = false;
let chatJumpLatestVisible = false;
let lastRenderedChatConversationId = '';
let lastRenderedChatFingerprint = '';

function mountControlPlane() {
  if (
    !lastUpdatedEl
    || !dashboardReposEl
    || !dashboardSummaryNoteEl
    || !controlPlaneHeartbeatsEl
  ) {
    return;
  }

  if (form) {
    form.addEventListener('submit', handleSubmit);
    form.addEventListener('input', () => persistActiveChatPrdDraftFromForm());
  }
  if (discardChatPrdDraftButton) {
    discardChatPrdDraftButton.addEventListener('click', () => discardChatPrdDraft());
  }
  if (openChatPrdReviewButton) {
    openChatPrdReviewButton.addEventListener('click', () => openChatPrdReviewModal());
  }
  if (closeChatPrdReviewButton) {
    closeChatPrdReviewButton.addEventListener('click', () => closeChatPrdReviewModal());
  }
  if (backChatPrdReviewButton) {
    backChatPrdReviewButton.addEventListener('click', () => closeChatPrdReviewModal());
  }
  if (submitChatPrdReviewButton) {
    submitChatPrdReviewButton.addEventListener('click', () => {
      submitActiveChatPrdDraftReview().catch((error: unknown) => {
        if (messageEl) {
          messageEl.textContent = getErrorMessage(error);
        }
      });
    });
  }
  if (quickPrdForm) {
    quickPrdForm.addEventListener('submit', handleQuickSubmit);
  }
  if (chatForm) {
    chatForm.addEventListener('submit', handleChatSubmit);
  }
  if (chatThreadEl) {
    chatThreadEl.addEventListener('scroll', () => {
      if (isChatNearBottom(chatThreadEl)) {
        setChatJumpLatestVisible(false);
      }
    });
  }
  if (chatJumpLatestButton) {
    chatJumpLatestButton.addEventListener('click', () => {
      scrollChatToLatest();
      setChatJumpLatestVisible(false);
    });
  }
  if (chatConversationSelect) {
    chatConversationSelect.addEventListener('change', () => {
      selectedChatConversationId = chatConversationSelect.value || NEW_CHAT_VALUE;
      forceChatScrollToLatest = true;
      renderChat(latestConversations);
    });
  }
  if (newChatButton) {
    newChatButton.addEventListener('click', () => {
      selectedChatConversationId = NEW_CHAT_VALUE;
      forceChatScrollToLatest = true;
      renderChat(latestConversations);
      window.setTimeout(() => chatInputEl?.focus(), 0);
    });
  }
  if (chatRefreshButton) {
    chatRefreshButton.addEventListener('click', () => refresh().catch((error: unknown) => {
      if (chatMessageEl) {
        chatMessageEl.textContent = getErrorMessage(error);
      }
    }));
  }
  if (refreshButton) {
    refreshButton.addEventListener('click', () => refresh().catch((error: unknown) => {
      if (messageEl) {
        messageEl.textContent = getErrorMessage(error);
      }
    }));
  }
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target ? target.closest<HTMLButtonElement>('[data-action="deploy"]') : null;
    if (button) {
      const repoId = String(button.dataset.repoId || '').trim();
      if (!repoId) {
        return;
      }
      handleDeploy(repoId).catch((error: unknown) => {
        if (messageEl) {
          messageEl.textContent = getErrorMessage(error);
        }
      });
      return;
    }

    const packageUpdateButton = target ? target.closest<HTMLButtonElement>('[data-action="package-update"]') : null;
    if (packageUpdateButton) {
      const repoId = String(packageUpdateButton.dataset.repoId || '').trim();
      if (!repoId) {
        return;
      }
      handlePackageUpdate(repoId).catch((error: unknown) => {
        if (messageEl) {
          messageEl.textContent = getErrorMessage(error);
        }
      });
      return;
    }

    const restartButton = target ? target.closest<HTMLButtonElement>('[data-action="restart"]') : null;
    if (restartButton) {
      const repoId = String(restartButton.dataset.repoId || '').trim();
      if (!repoId) {
        return;
      }
      handleRestart(repoId).catch((error: unknown) => {
        if (messageEl) {
          messageEl.textContent = getErrorMessage(error);
        }
      });
      return;
    }

    const resetPrdsButton = target ? target.closest<HTMLButtonElement>('[data-action="reset-prds"]') : null;
    if (resetPrdsButton) {
      const repoId = String(resetPrdsButton.dataset.repoId || '').trim();
      if (!repoId) {
        return;
      }
      handlePrdReset(repoId).catch((error: unknown) => {
        if (messageEl) {
          messageEl.textContent = getErrorMessage(error);
        }
      });
      return;
    }

    const historyButton = target ? target.closest<HTMLButtonElement>('[data-action="select-prd-history"]') : null;
    if (historyButton) {
      selectedHistoryPrdId = String(historyButton.dataset.prdId || '').trim();
      preferredHistoryPrdId = '';
      prdHistoryContinueMessagePrdId = '';
      prdHistoryContinueMessage = '';
      renderPrdHistory(latestDashboard);
      return;
    }

    const continueSourceChatButton = target ? target.closest<HTMLButtonElement>('[data-action="continue-prd-source-chat"]') : null;
    if (continueSourceChatButton) {
      const prdId = String(continueSourceChatButton.dataset.prdId || selectedHistoryPrdId || '').trim();
      const prd = findHistoryPrdById(latestDashboard, prdId);
      continueSourceChatFromPrd(prd, latestConversations);
      return;
    }

    const reviewChatPrdButton = target ? target.closest<HTMLButtonElement>('[data-action="review-chat-prd"]') : null;
    if (reviewChatPrdButton) {
      loadChatPrdDraftFromButton(reviewChatPrdButton);
      return;
    }

    const discardChatPrdButton = target ? target.closest<HTMLButtonElement>('[data-action="discard-chat-prd"]') : null;
    if (discardChatPrdButton) {
      discardChatPrdDraft(String(discardChatPrdButton.dataset.proposalKey || '').trim());
    }
  });
  if (openPrdModalButton) {
    openPrdModalButton.addEventListener('click', () => openPrdModal());
  }
  if (closePrdModalButton) {
    closePrdModalButton.addEventListener('click', () => closePrdModal());
  }
  if (prdModalEl) {
    prdModalEl.addEventListener('click', (event) => {
      if (event.target === prdModalEl) {
        closePrdModal();
      }
    });
  }
  if (chatPrdReviewModalEl) {
    chatPrdReviewModalEl.addEventListener('click', (event) => {
      if (event.target === chatPrdReviewModalEl) {
        closeChatPrdReviewModal();
      }
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeChatPrdReviewModal();
      closePrdModal();
    }
  });

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => setActiveTab(String(tab.dataset.tab || 'main')));
  });

  restoreActiveChatPrdDraft();

  refresh().catch((error: unknown) => {
    if (messageEl) {
      messageEl.textContent = getErrorMessage(error);
    }
  });

  window.setInterval(() => refresh().catch(() => {}), 5000);
  if (window.__AUTONOMY_CONTROL_PLANE_DEV__ === true) {
    window.setInterval(() => checkForUiReload().catch(() => {}), 1000);
  }
}

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();

  if (!form || !messageEl) {
    return;
  }

  messageEl.textContent = 'Queueing...';

  try {
    const job = await submitPrd({
      title: prdTitleEl?.value.trim() || '',
      specification: prdSpecEl?.value.trim() || '',
      requirements: (prdReqEl?.value || '')
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
      sprintId: prdSprintEl?.value.trim() || '',
      taskSpecsRaw: prdTaskSpecsEl?.value.trim() || '',
    });
    const submittedChatDraftKey = activeChatPrdDraft?.key || '';
    form.reset();
    clearActiveChatPrdDraft(submittedChatDraftKey);
    messageEl.textContent = buildQueuedMessage(job);
  } catch (error) {
    messageEl.textContent = getErrorMessage(error);
  }
}

async function handleQuickSubmit(event: SubmitEvent) {
  event.preventDefault();

  if (!quickFormMessageEl || !quickPrdSpecEl) {
    return;
  }

  quickFormMessageEl.textContent = 'Queueing...';

  try {
    const job = await submitPrd({
      title: '',
      specification: quickPrdSpecEl.value.trim(),
      requirements: [],
      sprintId: '',
      taskSpecsRaw: '',
    });
    quickPrdForm?.reset();
    quickFormMessageEl.textContent = buildQueuedMessage(job);
    closePrdModal();
    if (messageEl) {
      messageEl.textContent = buildQueuedMessage(job);
    }
  } catch (error) {
    quickFormMessageEl.textContent = getErrorMessage(error);
  }
}

async function handleChatSubmit(event: SubmitEvent) {
  event.preventDefault();

  if (!chatInputEl || !chatMessageEl || entranceContext.entrance !== 'project') {
    return;
  }

  const message = chatInputEl.value.trim();
  if (!message) {
    chatMessageEl.textContent = 'Enter a message first.';
    return;
  }

  chatMessageEl.textContent = 'Sending...';

  try {
    const queued = await requestJson<{
      conversation?: ChatConversationSummary;
      job?: JobSummary;
    }>(`/api/repos/${encodeURIComponent(entranceContext.repoId)}/conversations`, {
      method: 'POST',
      body: JSON.stringify({
        repoId: entranceContext.repoId,
        conversationId: selectedChatConversationId === NEW_CHAT_VALUE ? '' : selectedChatConversationId,
        message,
      }),
    });
    selectedChatConversationId = String(queued.conversation && queued.conversation.id || selectedChatConversationId || '');
    chatInputEl.value = '';
    chatMessageEl.textContent = 'Message queued for the bridge.';
    forceChatScrollToLatest = true;
    await refresh();
  } catch (error) {
    forceChatScrollToLatest = false;
    chatMessageEl.textContent = getErrorMessage(error);
  }
}

async function refresh() {
  const reposRequestUrl = entranceContext.entrance === 'project' && entranceContext.repoId
    ? `/api/repos?repoId=${encodeURIComponent(entranceContext.repoId)}`
    : '/api/repos';
  const stateRequestUrl = entranceContext.entrance === 'project' && entranceContext.repoId
    ? `/api/state?repoId=${encodeURIComponent(entranceContext.repoId)}`
    : '/api/state';
  const [repos, state] = await Promise.all([
    requestJson<{ repos?: RepoRecord[] }>(reposRequestUrl),
    requestJson<StateSnapshot>(stateRequestUrl),
  ]);

  renderRepos(repos.repos || []);
  renderDashboard(state.dashboard || {});
  renderControlPlaneHeartbeats(state.dashboard || {});
  renderProjectMain(state.dashboard || {});
  renderChat(extractRepoConversations(state));
  renderAdvanced(state);

  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
}

async function submitPrd({
  title,
  specification,
  requirements,
  sprintId,
  taskSpecsRaw,
}: {
  title: string;
  specification: string;
  requirements: string[];
  sprintId: string;
  taskSpecsRaw: string;
}) {
  const targetRepoId = entranceContext.entrance === 'project'
    ? entranceContext.repoId
    : String(repoSelect && repoSelect.value || '').trim();
  if (!targetRepoId) {
    throw new Error('No repo selected.');
  }
  const body = {
    repoId: targetRepoId,
    title,
    specification,
    requirements,
    sprintId,
    taskSpecs: taskSpecsRaw ? JSON.parse(taskSpecsRaw) : [],
  };
  const job = await requestJson<{ payload?: { id?: string; title?: string } }>('/api/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await refresh();
  return job;
}

function loadChatPrdDraftFromButton(button: HTMLButtonElement) {
  const buttonProposalKey = String(button.dataset.proposalKey || '').trim();
  const existingDraft = buttonProposalKey
    ? resolveChatPrdDraftForProposalKey(buttonProposalKey)
    : null;
  if (existingDraft) {
    activeChatPrdDraft = existingDraft;
    writeChatPrdDraftToForm(existingDraft);
    saveActiveChatPrdDraft();
    renderChatPrdDraftPanel();
    openChatPrdReviewModal();
    if (messageEl) {
      messageEl.textContent = 'Review the chat PRD draft, then submit it or return without queueing.';
    }
    return;
  }

  const proposal = readProposalFromButton(button);
  if (!proposal) {
    if (chatMessageEl) {
      chatMessageEl.textContent = 'The chat PRD proposal could not be read.';
    }
    return;
  }
  const key = buttonProposalKey || getPrdProposalStableKey(proposal, String(button.dataset.messageId || ''));
  const draft = buildChatPrdDraftFormState(key, proposal, entranceContext.repoId);
  activeChatPrdDraft = draft;
  writeChatPrdDraftToForm(draft);
  saveActiveChatPrdDraft();
  renderChatPrdDraftPanel();
  openChatPrdReviewModal();
  if (messageEl) {
    messageEl.textContent = 'Review the chat PRD draft, then submit it or return without queueing.';
  }
}

function readProposalFromButton(button: HTMLButtonElement) {
  try {
    return normalizePrdProposal(JSON.parse(String(button.dataset.prdProposal || '{}')), {
      repoId: entranceContext.repoId,
      responseMessageId: String(button.dataset.messageId || ''),
    });
  } catch {
    return null;
  }
}

function buildChatPrdDraftFormState(
  key: string,
  proposal: ControlPlanePrdProposal,
  repoId: string
): ChatPrdDraftState {
  const normalized = normalizePrdProposal(proposal, { repoId });
  if (!normalized) {
    throw new Error('Invalid chat PRD proposal.');
  }
  const submission = buildPrdSubmissionFromProposal(normalized, { repoId });
  return {
    key,
    proposal: normalized,
    title: String(submission.title || normalized.title || '').trim(),
    specification: String(submission.specification || '').trim(),
    requirements: Array.isArray(submission.requirements) ? submission.requirements : [],
    sprintId: '',
    taskSpecsRaw: '',
    updatedAt: new Date().toISOString(),
  };
}

function writeChatPrdDraftToForm(draft: ChatPrdDraftState) {
  if (prdTitleEl) {
    prdTitleEl.value = draft.title;
  }
  if (prdSpecEl) {
    prdSpecEl.value = draft.specification;
  }
  if (prdReqEl) {
    prdReqEl.value = draft.requirements.join('\n');
  }
  if (prdSprintEl) {
    prdSprintEl.value = draft.sprintId;
  }
  if (prdTaskSpecsEl) {
    prdTaskSpecsEl.value = draft.taskSpecsRaw;
  }
}

function persistActiveChatPrdDraftFromForm() {
  if (!activeChatPrdDraft) {
    return;
  }
  activeChatPrdDraft = {
    ...activeChatPrdDraft,
    title: prdTitleEl ? prdTitleEl.value.trim() : activeChatPrdDraft.title,
    specification: prdSpecEl?.value.trim() || '',
    requirements: (prdReqEl?.value || '')
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean),
    sprintId: prdSprintEl?.value.trim() || '',
    taskSpecsRaw: prdTaskSpecsEl?.value.trim() || '',
    updatedAt: new Date().toISOString(),
  };
  saveActiveChatPrdDraft();
  renderChatPrdDraftPanel();
  renderChatPrdReviewModal();
}

function renderChatPrdDraftPanel() {
  if (!chatPrdDraftPanelEl) {
    return;
  }
  const draft = activeChatPrdDraft;
  chatPrdDraftPanelEl.hidden = !draft;
  if (!draft) {
    return;
  }
  if (chatPrdDraftTitleEl) {
    chatPrdDraftTitleEl.textContent = draft.title || 'Ready for review';
  }
  if (chatPrdDraftMetaEl) {
    chatPrdDraftMetaEl.textContent = [
      'Draft preserved for later review',
      draft.proposal.source?.conversationId ? `conversation ${draft.proposal.source.conversationId}` : '',
      draft.proposal.source?.responseMessageId ? `message ${draft.proposal.source.responseMessageId}` : '',
    ].filter(Boolean).join(' | ');
  }
}

function openChatPrdReviewModal() {
  if (!activeChatPrdDraft) {
    if (messageEl) {
      messageEl.textContent = 'No chat PRD draft is ready to review.';
    }
    return;
  }
  chatPrdReviewModalOpen = true;
  renderChatPrdReviewModal();
}

function closeChatPrdReviewModal() {
  if (!chatPrdReviewModalOpen) {
    return;
  }
  chatPrdReviewModalOpen = false;
  renderChatPrdReviewModal();
  if (messageEl && activeChatPrdDraft) {
    messageEl.textContent = 'Chat PRD draft preserved for later review.';
  }
}

function renderChatPrdReviewModal() {
  if (!chatPrdReviewModalEl) {
    return;
  }
  const draft = buildCurrentChatPrdDraftState(activeChatPrdDraft);
  const visible = Boolean(draft && chatPrdReviewModalOpen);
  chatPrdReviewModalEl.hidden = !visible;
  if (!draft || !visible) {
    return;
  }
  if (chatPrdReviewMetaEl) {
    chatPrdReviewMetaEl.textContent = [
      draft.proposal.priority ? `Priority ${draft.proposal.priority}` : '',
      draft.proposal.source?.conversationId ? `Conversation ${draft.proposal.source.conversationId}` : '',
      draft.proposal.source?.responseMessageId ? `Message ${draft.proposal.source.responseMessageId}` : '',
    ].filter(Boolean).join(' | ') || 'Review the proposal before queueing it.';
  }
  if (chatPrdReviewContentEl) {
    chatPrdReviewContentEl.innerHTML = renderToHtml(<ChatPrdReviewSummary draft={draft} />);
  }
}

function buildCurrentChatPrdDraftState(draft: ChatPrdDraftState | null) {
  if (!draft) {
    return null;
  }
  return {
    ...draft,
    title: prdTitleEl ? prdTitleEl.value.trim() : draft.title,
    specification: prdSpecEl?.value.trim() || '',
    requirements: (prdReqEl?.value || '')
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean),
    sprintId: prdSprintEl?.value.trim() || '',
    taskSpecsRaw: prdTaskSpecsEl?.value.trim() || '',
  };
}

async function submitActiveChatPrdDraftReview() {
  if (!activeChatPrdDraft || !messageEl || !form) {
    return;
  }
  messageEl.textContent = 'Queueing...';
  const job = await submitPrd({
    title: prdTitleEl?.value.trim() || '',
    specification: prdSpecEl?.value.trim() || '',
    requirements: (prdReqEl?.value || '')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
    sprintId: prdSprintEl?.value.trim() || '',
    taskSpecsRaw: prdTaskSpecsEl?.value.trim() || '',
  });
  const submittedChatDraftKey = activeChatPrdDraft.key || '';
  form.reset();
  closeChatPrdReviewModal();
  clearActiveChatPrdDraft(submittedChatDraftKey);
  messageEl.textContent = buildQueuedMessage(job);
}

function restoreActiveChatPrdDraft() {
  activeChatPrdDraft = readStoredActiveChatPrdDraft();
  if (activeChatPrdDraft) {
    writeChatPrdDraftToForm(activeChatPrdDraft);
  }
  renderChatPrdDraftPanel();
  renderChatPrdReviewModal();
}

function resolveChatPrdDraftForProposalKey(proposalKey: string) {
  if (!proposalKey) {
    return null;
  }
  if (activeChatPrdDraft?.key === proposalKey) {
    return activeChatPrdDraft;
  }
  const storedDraft = readStoredActiveChatPrdDraft();
  return storedDraft?.key === proposalKey ? storedDraft : null;
}

function readStoredActiveChatPrdDraft() {
  const raw = safeLocalStorageGet(getActiveChatPrdDraftStorageKey());
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ChatPrdDraftState>;
    const proposal = normalizePrdProposal(parsed.proposal, { repoId: entranceContext.repoId });
    const key = String(parsed.key || '').trim();
    if (!proposal || !key || isChatPrdProposalDismissed(key)) {
      safeLocalStorageRemove(getActiveChatPrdDraftStorageKey());
      return null;
    }
    return {
      key,
      proposal,
      title: String(hasOwn(parsed, 'title') ? parsed.title : proposal.title || '').trim(),
      specification: String(hasOwn(parsed, 'specification') ? parsed.specification : buildPrdSubmissionFromProposal(proposal, {
        repoId: entranceContext.repoId,
      }).specification || '').trim(),
      requirements: Array.isArray(parsed.requirements)
        ? parsed.requirements.map((entry) => String(entry || '').trim()).filter(Boolean)
        : proposal.requirements,
      sprintId: String(parsed.sprintId || '').trim(),
      taskSpecsRaw: String(parsed.taskSpecsRaw || '').trim(),
      updatedAt: String(parsed.updatedAt || new Date().toISOString()),
    } satisfies ChatPrdDraftState;
  } catch {
    safeLocalStorageRemove(getActiveChatPrdDraftStorageKey());
    return null;
  }
}

function discardChatPrdDraft(proposalKey = '') {
  const key = proposalKey || activeChatPrdDraft?.key || '';
  if (key) {
    dismissChatPrdProposal(key);
  }
  if (!proposalKey || activeChatPrdDraft?.key === proposalKey) {
    activeChatPrdDraft = null;
    chatPrdReviewModalOpen = false;
    safeLocalStorageRemove(getActiveChatPrdDraftStorageKey());
    form?.reset();
    renderChatPrdDraftPanel();
    renderChatPrdReviewModal();
  }
  renderChat(latestConversations);
  if (messageEl) {
    messageEl.textContent = 'Chat PRD draft discarded.';
  }
}

function clearActiveChatPrdDraft(proposalKey = '') {
  if (proposalKey) {
    dismissChatPrdProposal(proposalKey);
  }
  activeChatPrdDraft = null;
  chatPrdReviewModalOpen = false;
  safeLocalStorageRemove(getActiveChatPrdDraftStorageKey());
  renderChatPrdDraftPanel();
  renderChatPrdReviewModal();
  renderChat(latestConversations);
}

function saveActiveChatPrdDraft() {
  if (!activeChatPrdDraft) {
    safeLocalStorageRemove(getActiveChatPrdDraftStorageKey());
    return;
  }
  safeLocalStorageSet(getActiveChatPrdDraftStorageKey(), JSON.stringify(activeChatPrdDraft));
}

function getActiveChatPrdDraftStorageKey() {
  return `${CHAT_PRD_DRAFT_STORAGE_PREFIX}.${entranceContext.repoId}.active`;
}

function getDismissedChatPrdDraftStorageKey() {
  return `${CHAT_PRD_DRAFT_STORAGE_PREFIX}.${entranceContext.repoId}.dismissed`;
}

function isChatPrdProposalDismissed(proposalKey: string) {
  return getDismissedChatPrdProposalKeys().has(proposalKey);
}

function dismissChatPrdProposal(proposalKey: string) {
  if (!proposalKey) {
    return;
  }
  const keys = getDismissedChatPrdProposalKeys();
  keys.add(proposalKey);
  safeLocalStorageSet(getDismissedChatPrdDraftStorageKey(), JSON.stringify(Array.from(keys)));
}

function getDismissedChatPrdProposalKeys() {
  try {
    const raw = safeLocalStorageGet(getDismissedChatPrdDraftStorageKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map((entry) => String(entry || '').trim()).filter(Boolean) : []);
  } catch {
    return new Set<string>();
  }
}

function safeLocalStorageGet(key: string) {
  try {
    return window.localStorage?.getItem(key) || '';
  } catch {
    return '';
  }
}

function safeLocalStorageSet(key: string, value: string) {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Ignore storage failures; the server-backed chat proposal still remains available.
  }
}

function safeLocalStorageRemove(key: string) {
  try {
    window.localStorage?.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function handleDeploy(repoId: string) {
  if (!repoId || deployingRepoIds.has(repoId)) {
    return;
  }

  deployingRepoIds = new Set(deployingRepoIds).add(repoId);
  if (messageEl) {
    messageEl.textContent = `Queueing deploy for ${repoId}...`;
  }

  try {
    await requestJson(`/api/repos/${encodeURIComponent(repoId)}/deploy`, {
      method: 'POST',
      body: JSON.stringify({ repoId }),
    });
    await refresh();
    if (messageEl) {
      messageEl.textContent = `Deploy queued for ${repoId}.`;
    }
  } finally {
    const next = new Set(deployingRepoIds);
    next.delete(repoId);
    deployingRepoIds = next;
  }
}

async function handlePackageUpdate(repoId: string) {
  if (!repoId || updatingPackageRepoIds.has(repoId)) {
    return;
  }

  updatingPackageRepoIds = new Set(updatingPackageRepoIds).add(repoId);
  if (messageEl) {
    messageEl.textContent = `Queueing package update for ${repoId}...`;
  }

  try {
    await requestJson(`/api/repos/${encodeURIComponent(repoId)}/package-update`, {
      method: 'POST',
      body: JSON.stringify({ repoId }),
    });
    await refresh();
    if (messageEl) {
      messageEl.textContent = `Package update queued for ${repoId}.`;
    }
  } finally {
    const next = new Set(updatingPackageRepoIds);
    next.delete(repoId);
    updatingPackageRepoIds = next;
  }
}

async function handleRestart(repoId: string) {
  if (!repoId || restartingRepoIds.has(repoId)) {
    return;
  }

  restartingRepoIds = new Set(restartingRepoIds).add(repoId);
  if (messageEl) {
    messageEl.textContent = `Queueing restart for ${repoId}...`;
  }

  try {
    await requestJson(`/api/repos/${encodeURIComponent(repoId)}/restart`, {
      method: 'POST',
      body: JSON.stringify({ repoId }),
    });
    await refresh();
    if (messageEl) {
      messageEl.textContent = `Restart queued for ${repoId}.`;
    }
  } finally {
    const next = new Set(restartingRepoIds);
    next.delete(repoId);
    restartingRepoIds = next;
  }
}

async function handlePrdReset(repoId: string) {
  if (!repoId || resettingPrdRepoIds.has(repoId)) {
    return;
  }

  const repo = findRepoSummary(repoId);
  const activePrd = repo && repo.activePrd ? repo.activePrd : null;
  const activePrdId = String(activePrd && activePrd.id || '').trim();
  if (!activePrdId) {
    throw new Error(`No active PRD to reset for ${repoId}.`);
  }

  const repoLabel = String(repo && (repo.label || repo.repoId) || repoId);
  const confirmed = window.confirm(
    `Reset active PRD ${activePrdId} for ${repoLabel}? This clears repo-local autonomy state and moves the PRD into history.`
  );
  if (!confirmed) {
    return;
  }

  resettingPrdRepoIds = new Set(resettingPrdRepoIds).add(repoId);
  preferredHistoryPrdId = activePrdId;
  if (messageEl) {
    messageEl.textContent = `Queueing PRD reset for ${repoId}...`;
  }

  try {
    await requestJson(`/api/repos/${encodeURIComponent(repoId)}/reset-prds`, {
      method: 'POST',
      body: JSON.stringify({
        repoId,
        confirmPrdId: activePrdId,
      }),
    });
    await refresh();
    if (messageEl) {
      messageEl.textContent = `PRD reset queued for ${repoId}.`;
    }
  } finally {
    const next = new Set(resettingPrdRepoIds);
    next.delete(repoId);
    resettingPrdRepoIds = next;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiUrl(url), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init && init.headers ? init.headers : {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }

  return response.json() as Promise<T>;
}

async function checkForUiReload() {
  const payload = await requestJson<{ devMode?: boolean; devToken?: string }>('/api/dev-meta', {
    headers: {},
  });
  if (payload.devMode !== true) {
    return;
  }
  const nextToken = String(payload.devToken || '');
  if (!devUiToken) {
    devUiToken = nextToken;
    return;
  }
  if (nextToken && nextToken !== devUiToken) {
    window.location.reload();
  }
}

function renderRepos(repos: RepoRecord[]) {
  latestRepos = Array.isArray(repos) ? repos.slice() : [];
  if (repoSelect) {
    const previous = repoSelect.value;
    repoSelect.innerHTML = renderToHtml(<RepoOptions repos={latestRepos} />);

    if (previous && latestRepos.some((repo) => repo.repoId === previous)) {
      repoSelect.value = previous;
    } else if (!repoSelect.value && latestRepos.length > 0) {
      repoSelect.value = latestRepos[0].repoId;
    }

    repoSelect.disabled = latestRepos.length === 0;
  }

  if (fixedRepoIdEl) {
    const activeRepo = latestRepos.find((repo) => repo.repoId === entranceContext.repoId);
    fixedRepoIdEl.textContent = activeRepo
      ? `${activeRepo.label}${activeRepo.description ? ` - ${activeRepo.description}` : ''}`
      : entranceContext.repoId || 'Unknown repo';
  }
}

function renderDashboard(dashboard: DashboardSummary) {
  latestDashboard = dashboard || {};
  if (!dashboardReposEl || !dashboardSummaryNoteEl) {
    return;
  }

  const deployableRepoCount = resolveDeployableRepoCount(dashboard);
  const deployableRepoLabel = `${deployableRepoCount} deployable repo${deployableRepoCount === 1 ? '' : 's'}`;
  if (dashboardMetricsEl) {
    dashboardMetricsEl.innerHTML = renderToHtml(<MetricGrid dashboard={dashboard} />);
  }
  dashboardSummaryNoteEl.textContent = entranceContext.entrance === 'manager'
    ? (
      dashboard.repoCount && dashboard.repoCount > 0
        ? `${dashboard.repoCount} repo${dashboard.repoCount === 1 ? '' : 's'} visible`
        : 'No repo snapshots yet'
    )
    : dashboard.repoCount && dashboard.repoCount > 0
      ? `${dashboard.repoCount} repo${dashboard.repoCount === 1 ? '' : 's'} visible · ${deployableRepoLabel}`
      : `Repo ${entranceContext.repoId || ''} is not registered yet.`;
  dashboardReposEl.innerHTML = renderToHtml(
    <RepoStack
      repos={dashboard.repos || []}
      emptyMessage={entranceContext.entrance === 'project'
        ? `Repo ${entranceContext.repoId || 'unknown'} is unavailable or has not registered yet.`
        : 'No repository snapshots yet.'}
    />
  );
  if (dashboardJobsEl) {
    dashboardJobsEl.innerHTML = renderToHtml(<JobStack jobs={dashboard.jobs || []} />);
  }
  renderPrdHistory(dashboard);
}

function renderControlPlaneHeartbeats(dashboard: DashboardSummary) {
  if (!controlPlaneHeartbeatsEl) {
    return;
  }

  controlPlaneHeartbeatsEl.innerHTML = renderToHtml(
    <HeartbeatStrip
      controlPlane={{
        overallStatus: dashboard.overallHeartbeatStatus,
        statusLabel: dashboard.statusLabel,
        server: dashboard.serverHeartbeat,
        bridge: dashboard.bridgeHeartbeat,
      }}
    />
  );
}

function renderProjectMain(dashboard: DashboardSummary) {
  if (entranceContext.entrance !== 'project') {
    return;
  }

  const repo = (dashboard.repos || []).find((entry) => String(entry && entry.repoId || '') === entranceContext.repoId) || null;
  const repoLabel = String(repo && (repo.label || repo.repoId) || entranceContext.repoId || 'this repo');
  if (mainHeroActionLabelEl) {
    mainHeroActionLabelEl.textContent = `Make a change to ${repoLabel}`;
  }

  const progress = resolveProjectProgress(repo);
  if (mainProgressTitleEl) {
    mainProgressTitleEl.textContent = progress.title;
  }
  if (mainProgressDetailEl) {
    mainProgressDetailEl.textContent = progress.detail;
  }
  if (mainProgressStatsEl) {
    mainProgressStatsEl.textContent = progress.stats;
  }
  if (mainProgressFillEl) {
    mainProgressFillEl.style.width = `${progress.percent}%`;
  }
  if (mainProgressStepsEl) {
    mainProgressStepsEl.innerHTML = renderToHtml(<PrdRunSteps run={repo && repo.prdRun ? repo.prdRun : null} />);
  }
  if (mainProgressActionsEl) {
    mainProgressActionsEl.innerHTML = renderToHtml(<ProjectMainProgressActions progress={progress} />);
  }
  if (mainDeployActionsEl) {
    mainDeployActionsEl.innerHTML = renderToHtml(<ProjectMainDeployActions repo={repo} />);
  }
}

function renderPrdHistory(dashboard: DashboardSummary) {
  if (
    entranceContext.entrance !== 'project'
    || !prdHistorySummaryEl
    || !prdHistoryListEl
    || !prdHistoryDetailEl
  ) {
    return;
  }

  const repo = (dashboard.repos || []).find((entry) => String(entry && entry.repoId || '') === entranceContext.repoId) || null;
  const history = repo && Array.isArray(repo.prdHistory) ? repo.prdHistory : [];
  const historySelection = resolveSelectedHistoryState(history, selectedHistoryPrdId, preferredHistoryPrdId);
  selectedHistoryPrdId = historySelection.selectedPrdId;
  preferredHistoryPrdId = historySelection.preferredPrdId;
  const selectedPrd = history.find((prd) => String(prd.id || '') === selectedHistoryPrdId) || null;

  prdHistorySummaryEl.textContent = history.length > 0
    ? `${history.length} finished PRD${history.length === 1 ? '' : 's'}`
    : 'History populates after a PRD finishes.';
  prdHistoryListEl.innerHTML = renderToHtml(
    <PrdHistoryList history={history} selectedPrdId={selectedHistoryPrdId} />
  );
  const continueChatMessage = selectedPrd
    && prdHistoryContinueMessagePrdId === String(selectedPrd.id || '')
    ? prdHistoryContinueMessage
    : '';
  prdHistoryDetailEl.innerHTML = renderToHtml(
    <PrdHistoryDetail prd={selectedPrd} continueChatMessage={continueChatMessage} />
  );
}

function findHistoryPrdById(dashboard: DashboardSummary, prdId: string) {
  const repo = (dashboard.repos || []).find((entry) => String(entry && entry.repoId || '') === entranceContext.repoId) || null;
  const history = repo && Array.isArray(repo.prdHistory) ? repo.prdHistory : [];
  return history.find((prd) => String(prd.id || '') === prdId) || null;
}

function findRepoSummary(repoId: string) {
  return (latestDashboard.repos || []).find((entry) => String(entry && entry.repoId || '').trim() === repoId) || null;
}

function resolveSelectedHistoryState(history: PrdSummary[], selectedPrdId: string, preferredPrdId: string) {
  const historyIds = new Set(history.map((prd) => String(prd.id || '').trim()).filter(Boolean));
  const preferred = String(preferredPrdId || '').trim();
  if (preferred && historyIds.has(preferred)) {
    return {
      selectedPrdId: preferred,
      preferredPrdId: '',
    };
  }

  const selected = String(selectedPrdId || '').trim();
  if (selected && historyIds.has(selected)) {
    return {
      selectedPrdId: selected,
      preferredPrdId: preferred,
    };
  }

  return {
    selectedPrdId: history.length > 0 ? String(history[0].id || '') : '',
    preferredPrdId: preferred,
  };
}

function continueSourceChatFromPrd(
  prd: PrdSummary | null,
  conversations: ChatConversationSummary[] = latestConversations
) {
  const result = resolvePrdHistoryContinueChat(prd, conversations, entranceContext.repoId);
  if (!result.conversation) {
    prdHistoryContinueMessagePrdId = String(prd && prd.id || selectedHistoryPrdId || '');
    prdHistoryContinueMessage = 'chat not available';
    renderPrdHistory(latestDashboard);
    return result;
  }

  selectedChatConversationId = String(result.conversation.id || '');
  prdHistoryContinueMessagePrdId = '';
  prdHistoryContinueMessage = '';
  forceChatScrollToLatest = true;
  renderChat(conversations);
  setActiveTab('chat');
  window.setTimeout(() => {
    scrollChatToLatest();
    chatInputEl?.focus();
  }, 0);
  return result;
}

function resolvePrdHistoryContinueChat(
  prd: PrdSummary | null,
  conversations: ChatConversationSummary[],
  repoId = entranceContext.repoId
) {
  const sourceChat = normalizePrdSourceChatSummary(prd && prd.sourceChat);
  const conversationId = String(sourceChat && sourceChat.conversationId || '').trim();
  if (!conversationId) {
    return {
      status: 'unavailable',
      message: 'chat not available',
      sourceChat,
      conversation: null,
    };
  }

  const conversation = (conversations || []).find((entry) => {
    const entryId = String(entry && entry.id || '').trim();
    const entryRepoId = String(entry && entry.repoId || '').trim();
    return entryId === conversationId && (!entryRepoId || !repoId || entryRepoId === repoId);
  }) || null;

  if (!conversation) {
    return {
      status: 'unavailable',
      message: 'chat not available',
      sourceChat,
      conversation: null,
    };
  }

  return {
    status: 'available',
    message: '',
    sourceChat,
    conversation,
  };
}

function normalizePrdSourceChatSummary(value: unknown): PrdSourceChatSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as PrdSourceChatSummary;
  const sourceChat: PrdSourceChatSummary = {
    repoId: String(record.repoId || '').trim(),
    conversationId: String(record.conversationId || '').trim(),
    managerMessageId: String(record.managerMessageId || '').trim(),
    agentMessageId: String(record.agentMessageId || '').trim(),
    createdAt: String(record.createdAt || '').trim(),
  };
  const normalized = Object.fromEntries(
    Object.entries(sourceChat).filter(([, entry]) => entry)
  ) as PrdSourceChatSummary;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function renderChat(conversations: ChatConversationSummary[]) {
  if (
    entranceContext.entrance !== 'project'
    || !chatConversationSelect
    || !chatThreadEl
  ) {
    return;
  }

  const scrollSnapshot = captureChatScrollSnapshot(chatThreadEl);
  const previousConversationId = lastRenderedChatConversationId;
  const previousFingerprint = lastRenderedChatFingerprint;

  latestConversations = Array.isArray(conversations) ? conversations.slice() : [];
  if (
    selectedChatConversationId !== NEW_CHAT_VALUE
    && (!selectedChatConversationId || !latestConversations.some((conversation) => conversation.id === selectedChatConversationId))
  ) {
    selectedChatConversationId = latestConversations.length > 0
      ? String(latestConversations[0].id || '')
      : NEW_CHAT_VALUE;
  }

  chatConversationSelect.innerHTML = renderToHtml(<ChatConversationOptions conversations={latestConversations} />);
  chatConversationSelect.value = selectedChatConversationId || NEW_CHAT_VALUE;

  const selectedConversation = selectedChatConversationId === NEW_CHAT_VALUE
    ? null
    : latestConversations.find((conversation) => conversation.id === selectedChatConversationId) || null;
  const nextConversationId = selectedConversation
    ? String(selectedConversation.id || '')
    : selectedChatConversationId || NEW_CHAT_VALUE;
  const nextFingerprint = getChatConversationFingerprint(selectedConversation);
  const scrollDecision = resolveChatScrollDecision(scrollSnapshot, {
    forceScrollToLatest: forceChatScrollToLatest || previousConversationId !== nextConversationId,
    previousFingerprint,
    nextFingerprint,
    keepJumpToLatestVisible: chatJumpLatestVisible,
  });

  chatThreadEl.innerHTML = renderToHtml(<ChatThread conversation={selectedConversation} />);
  applyChatScrollDecision(chatThreadEl, scrollDecision);
  lastRenderedChatConversationId = nextConversationId;
  lastRenderedChatFingerprint = nextFingerprint;
  forceChatScrollToLatest = false;
}

type ChatScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

type ChatScrollSnapshot = ChatScrollMetrics & {
  nearBottom: boolean;
};

type ChatScrollDecision = {
  scrollToLatest: boolean;
  preserveScrollTop: number;
  showJumpToLatest: boolean;
};

function captureChatScrollSnapshot(element: ChatScrollMetrics): ChatScrollSnapshot {
  return {
    scrollTop: Math.max(0, Number(element.scrollTop) || 0),
    scrollHeight: Math.max(0, Number(element.scrollHeight) || 0),
    clientHeight: Math.max(0, Number(element.clientHeight) || 0),
    nearBottom: isChatNearBottom(element),
  };
}

function isChatNearBottom(element: ChatScrollMetrics, thresholdPx = CHAT_NEAR_BOTTOM_THRESHOLD_PX) {
  const scrollHeight = Math.max(0, Number(element.scrollHeight) || 0);
  const scrollTop = Math.max(0, Number(element.scrollTop) || 0);
  const clientHeight = Math.max(0, Number(element.clientHeight) || 0);
  const remaining = scrollHeight - scrollTop - clientHeight;
  return remaining <= thresholdPx;
}

function resolveChatScrollDecision(
  snapshot: ChatScrollSnapshot,
  options: {
    forceScrollToLatest?: boolean;
    previousFingerprint?: string;
    nextFingerprint?: string;
    keepJumpToLatestVisible?: boolean;
  }
): ChatScrollDecision {
  const previousFingerprint = String(options.previousFingerprint || '');
  const nextFingerprint = String(options.nextFingerprint || '');
  const contentChanged = previousFingerprint !== nextFingerprint && Boolean(previousFingerprint || nextFingerprint);
  if (options.forceScrollToLatest || snapshot.nearBottom) {
    return {
      scrollToLatest: true,
      preserveScrollTop: snapshot.scrollTop,
      showJumpToLatest: false,
    };
  }

  return {
    scrollToLatest: false,
    preserveScrollTop: snapshot.scrollTop,
    showJumpToLatest: Boolean(options.keepJumpToLatestVisible || contentChanged),
  };
}

function applyChatScrollDecision(element: HTMLElement, decision: ChatScrollDecision) {
  if (decision.scrollToLatest) {
    element.scrollTop = element.scrollHeight;
  } else {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.min(Math.max(0, decision.preserveScrollTop), maxScrollTop);
  }
  setChatJumpLatestVisible(decision.showJumpToLatest);
}

function scrollChatToLatest() {
  if (!chatThreadEl) {
    return;
  }
  chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
}

function setChatJumpLatestVisible(visible: boolean) {
  chatJumpLatestVisible = visible;
  if (chatJumpLatestButton) {
    chatJumpLatestButton.hidden = !visible;
  }
}

function getChatConversationFingerprint(conversation: ChatConversationSummary | null) {
  const messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
  return JSON.stringify(messages.map((message) => ({
    id: message.id || '',
    role: message.role || '',
    status: message.status || '',
    content: message.content || '',
    updatedAt: message.updatedAt || '',
    error: message.error || '',
    prdProposal: message.prdProposal ? getPrdProposalStableKey(message.prdProposal, message.id || '') : '',
  })));
}

function extractRepoConversations(state: StateSnapshot) {
  if (entranceContext.entrance !== 'project') {
    return [];
  }
  const conversationsByRepo = state.conversations || {};
  const conversations = conversationsByRepo[entranceContext.repoId] || [];
  return conversations
    .slice()
    .sort((left, right) => {
      const leftTime = Date.parse(String(left.updatedAt || left.createdAt || '')) || 0;
      const rightTime = Date.parse(String(right.updatedAt || right.createdAt || '')) || 0;
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return String(left.id || '').localeCompare(String(right.id || ''));
    });
}

function renderAdvanced(state: StateSnapshot) {
  if (!rawStateEl || !rawDashboardEl || !rawJobsEl || !rawReposEl) {
    return;
  }

  rawStateEl.textContent = JSON.stringify(state, null, 2);
  rawDashboardEl.textContent = JSON.stringify(state.dashboard || {}, null, 2);
  rawJobsEl.textContent = JSON.stringify(state.jobs || [], null, 2);
  rawReposEl.textContent = JSON.stringify(
    latestRepos.map((repo) => ({
      repoId: repo.repoId,
      label: repo.label,
      description: repo.description || '',
      default: Boolean(repo.default),
    })),
    null,
    2
  );
}

function setActiveTab(tabName: string) {
  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  Object.entries(panels).forEach(([name, panel]) => {
    if (panel) {
      panel.classList.toggle('active', name === tabName);
    }
  });
}

function resolveProjectProgress(repo: RepoSummary | null) {
  const activePrd = repo && repo.activePrd ? repo.activePrd : null;
  const prdRun = repo && repo.prdRun ? repo.prdRun : null;
  const pullRequestAction = resolveProjectProgressPullRequestAction(repo);
  if (activePrd) {
    const totalTasks = Number(activePrd.plannedTaskCount || 0);
    const completedTasks = Math.min(totalTasks, Number(activePrd.completedTaskCount || 0));
    const remainingTasks = Math.max(0, Number(
      typeof activePrd.remainingTaskCount === 'number'
        ? activePrd.remainingTaskCount
        : totalTasks - completedTasks
    ));
    const percent = Math.max(
      0,
      Math.min(100, Number(
        typeof activePrd.progressPercent === 'number'
          ? activePrd.progressPercent
          : totalTasks > 0
            ? Math.round((completedTasks / totalTasks) * 100)
            : 0
      ))
    );
    return {
      title: activePrd.title || 'Current run',
      detail: prdRun && prdRun.currentStepLabel
        ? `${prdRun.currentStepLabel}: ${prdRun.detail || activePrd.stateLabel || 'In progress'}`
        : activePrd.stateLabel || 'In progress',
      stats: totalTasks > 0
        ? `${completedTasks} complete · ${remainingTasks} remaining`
        : 'Waiting for planned tasks',
      percent,
      pullRequestAction,
    };
  }

  if (repo && repo.queuedPrds && repo.queuedPrds.length > 0) {
    return {
      title: repo.queuedPrds[0].title || 'Queued PRD',
      detail: prdRun && prdRun.detail ? prdRun.detail : 'Queued and waiting to start',
      stats: `${repo.queuedPrds.length} PRD${repo.queuedPrds.length === 1 ? '' : 's'} in queue`,
      percent: 0,
      pullRequestAction: null,
    };
  }

  return {
    title: 'Ready for a new run',
    detail: 'No active PRD is working through tasks right now.',
    stats: '0 complete · 0 remaining',
    percent: 0,
    pullRequestAction: null,
  };
}

function resolveProjectProgressPullRequestAction(repo: RepoSummary | null): ProjectProgressPullRequestAction | null {
  const activePrd = repo && repo.activePrd ? repo.activePrd : null;
  const pullRequestStatus = selectActivePullRequestStatusForPrd(
    activePrd,
    repo && Array.isArray(repo.pullRequestStatuses) ? repo.pullRequestStatuses : [],
    repo && Array.isArray(repo.queuedPrds) ? repo.queuedPrds : []
  );
  const href = String(pullRequestStatus && pullRequestStatus.url || '').trim();
  if (!href) {
    return null;
  }
  return {
    href,
    label: formatProjectProgressPullRequestLabel(pullRequestStatus),
  };
}

function formatProjectProgressPullRequestLabel(pullRequestStatus: PullRequestSummary | null) {
  const number = Number(pullRequestStatus && pullRequestStatus.number);
  if (Number.isFinite(number) && number > 0) {
    return `Open pull request #${number}`;
  }
  return 'Open active pull request';
}

function ProjectMainProgressActions(
  { progress }: { progress: ReturnType<typeof resolveProjectProgress> }
) {
  if (!progress.pullRequestAction) {
    return null;
  }
  return (
    <a
      className="action-link"
      href={progress.pullRequestAction.href}
      target="_blank"
      rel="noreferrer"
    >
      {progress.pullRequestAction.label}
    </a>
  );
}

function ProjectMainDeployActions({ repo }: { repo: RepoSummary | null }) {
  const deployment = repo && repo.deployment ? repo.deployment : null;
  const deployButtonState = buildDeployButtonState(repo);
  const showDeployButton = Boolean(repo && repo.repoId && (deployButtonState.active || deployment && deployment.hasChanges));

  return (
    <>
      {showDeployButton ? (
        <button
          type="button"
          className={`primary deploy-button${deployButtonState.busy ? ' is-loading' : ''}`}
          data-action="deploy"
          data-repo-id={repo && repo.repoId ? repo.repoId : ''}
          disabled={deployButtonState.disabled}
          aria-busy={deployButtonState.busy}
        >
          {deployButtonState.busy ? <span className="deploy-spinner" aria-hidden="true" /> : null}
          <span>{deployButtonState.label}</span>
        </button>
      ) : null}
      {repo && repo.deploymentUrl ? (
        <a
          className="action-link"
          href={repo.deploymentUrl}
          target="_blank"
          rel="noreferrer"
        >
          {repo.deploymentLabel || 'Deployment site'}
        </a>
      ) : null}
    </>
  );
}

function PrdRunSteps({ run }: { run: PrdRunSummary | null }) {
  const steps = run && Array.isArray(run.steps) && run.steps.length > 0
    ? run.steps
    : [
        { id: 'planning', label: 'Planning', state: 'pending', detail: 'Waiting' },
        { id: 'implementing', label: 'Implementing', state: 'pending', detail: 'Waiting' },
        { id: 'reviewing', label: 'Reviewing', state: 'pending', detail: 'Waiting' },
      ];

  return (
    <>
      {steps.map((step) => (
        <div className={`progress-step ${step.state || 'pending'}`}>
          <div className="progress-step-marker" aria-hidden="true" />
          <div className="progress-step-copy">
            <strong>{step.label || step.id || 'Step'}</strong>
            <span>{step.detail || 'Waiting'}</span>
          </div>
        </div>
      ))}
    </>
  );
}

function PrdHistoryList({ history, selectedPrdId }: { history: PrdSummary[]; selectedPrdId: string }) {
  if (!history.length) {
    return <div className="muted">No finished PRDs yet.</div>;
  }

  return (
    <>
      {history.map((prd) => {
        const prdId = String(prd.id || '');
        const selected = prdId === selectedPrdId;
        return (
          <button
            type="button"
            className={`history-item${selected ? ' selected' : ''}`}
            data-action="select-prd-history"
            data-prd-id={prdId}
            aria-pressed={selected ? 'true' : 'false'}
          >
            <span className="history-item-title">{prd.title || prd.id || 'Untitled PRD'}</span>
            <span className="history-item-meta">
              {prd.updatedAt || prd.createdAt ? formatTimestamp(prd.updatedAt || prd.createdAt) : 'Finished PRD'}
            </span>
          </button>
        );
      })}
    </>
  );
}

function PrdHistoryDetail({
  prd,
  continueChatMessage = '',
}: {
  prd: PrdSummary | null;
  continueChatMessage?: string;
}) {
  if (!prd) {
    return <div className="muted">Select a finished PRD to inspect its details.</div>;
  }

  const requirements = Array.isArray(prd.requirements) ? prd.requirements.filter(Boolean) : [];
  const tasks = Array.isArray(prd.tasks) ? prd.tasks : [];
  const sourceChat = normalizePrdSourceChatSummary(prd.sourceChat);
  const sourceChatDetail = sourceChat ? [
    sourceChat.repoId ? `Repo ${sourceChat.repoId}` : '',
    sourceChat.conversationId ? `Conversation ${sourceChat.conversationId}` : '',
    sourceChat.managerMessageId ? `Manager message ${sourceChat.managerMessageId}` : '',
    sourceChat.agentMessageId ? `Agent message ${sourceChat.agentMessageId}` : '',
    sourceChat.createdAt ? `Created ${formatTimestamp(sourceChat.createdAt)}` : '',
  ].filter(Boolean).join(' | ') : '';
  const timestamps = [
    prd.createdAt ? `Created ${formatTimestamp(prd.createdAt)}` : '',
    prd.updatedAt ? `Updated ${formatTimestamp(prd.updatedAt)}` : '',
    prd.archivePath ? `Archived at ${prd.archivePath}` : '',
  ].filter(Boolean).join(' | ');

  return (
    <div className="history-detail-card">
      <div className="item-head">
        <div>
          <div className="pill">{prd.stateLabel || 'Completed'}</div>
          <h3 className="history-detail-title">{prd.title || prd.id || 'Untitled PRD'}</h3>
        </div>
      </div>
      <div className="queue-detail">{prd.id || 'unknown PRD'}{timestamps ? ` | ${timestamps}` : ''}</div>
      {sourceChat ? (
        <div className="history-block source-chat-block">
          <h4>Source Chat</h4>
          {sourceChatDetail ? <div className="queue-detail">{sourceChatDetail}</div> : null}
          <div className="history-actions">
            <button
              type="button"
              className="secondary"
              data-action="continue-prd-source-chat"
              data-prd-id={prd.id || ''}
              data-conversation-id={sourceChat.conversationId || ''}
            >
              Continue source chat
            </button>
          </div>
          {continueChatMessage ? (
            <div className="list-note" role="status">{continueChatMessage}</div>
          ) : null}
        </div>
      ) : null}
      {prd.specification ? (
        <div className="history-block">
          <h4>Specification</h4>
          <p>{prd.specification}</p>
        </div>
      ) : null}
      <div className="history-block">
        <h4>Requirements</h4>
        {requirements.length > 0 ? (
          <ul className="history-list">
            {requirements.map((requirement) => <li>{requirement}</li>)}
          </ul>
        ) : <div className="list-note">No requirements recorded.</div>}
      </div>
      <div className="history-block">
        <h4>Tasks</h4>
        {tasks.length > 0 ? (
          <div className="history-task-stack">
            {tasks.map((task) => <PrdHistoryTask task={task} />)}
          </div>
        ) : <div className="list-note">No task specs recorded.</div>}
      </div>
      <div className="history-block">
        <h4>Raw PRD Info</h4>
        <pre>{JSON.stringify(prd, null, 2)}</pre>
      </div>
    </div>
  );
}

function PrdHistoryTask({ task }: { task: PrdTaskSummary }) {
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance.filter(Boolean) : [];
  const meta = [task.agentId, task.sprintId ? `sprint ${task.sprintId}` : ''].filter(Boolean).join(' | ');

  return (
    <div className="history-task">
      <div className="queue-title">{task.title || task.id || 'Untitled task'}</div>
      {meta ? <div className="queue-detail">{meta}</div> : null}
      {task.description ? <div className="queue-detail">{task.description}</div> : null}
      {acceptance.length > 0 ? (
        <ul className="history-list">
          {acceptance.map((item) => <li>{item}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function RepoOptions({ repos }: { repos: RepoRecord[] }) {
  return (
    <>
      {repos.map((repo) => {
        const label = repo.description ? `${repo.label} - ${repo.description}` : repo.label;
        return <option value={repo.repoId}>{label}</option>;
      })}
    </>
  );
}

function ChatConversationOptions({ conversations }: { conversations: ChatConversationSummary[] }) {
  return (
    <>
      <option value={NEW_CHAT_VALUE}>New conversation</option>
      {conversations.map((conversation) => (
        <option value={conversation.id || ''}>
          {conversation.title || conversation.id || 'Repo conversation'}
        </option>
      ))}
    </>
  );
}

function ChatThread({ conversation }: { conversation: ChatConversationSummary | null }) {
  const messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
  if (!conversation) {
    return <div className="muted">Start a new conversation with the repo agent.</div>;
  }
  if (!messages.length) {
    return <div className="muted">No messages in this conversation yet.</div>;
  }

  return (
    <>
      {messages.map((message) => <ChatMessage message={message} />)}
    </>
  );
}

function ChatPrdReviewSummary({ draft }: { draft: ChatPrdDraftState }) {
  const summary = buildChatPrdReviewSummaryState(draft);
  const meta = [
    summary.priority ? `Priority ${summary.priority}` : '',
    draft.proposal.source?.repoId ? `Repo ${draft.proposal.source.repoId}` : '',
  ].filter(Boolean).join(' | ');
  return (
    <div className="chat-prd-review-summary">
      <div className="chat-prd-review-hero">
        <div className="pill">PRD proposal</div>
        <div className="chat-prd-review-title">{summary.title || 'Untitled PRD proposal'}</div>
        {meta ? <div className="chat-prd-proposal-detail">{meta}</div> : null}
      </div>
      <div className="chat-prd-review-grid">
        {summary.problem ? (
          <section className="chat-prd-review-card">
            <h3>Problem</h3>
            <p>{summary.problem}</p>
          </section>
        ) : null}
        {summary.goal ? (
          <section className="chat-prd-review-card">
            <h3>Goal</h3>
            <p>{summary.goal}</p>
          </section>
        ) : null}
        {summary.requirements.length > 0 ? (
          <section className="chat-prd-review-card wide">
            <h3>Requirements</h3>
            <ul className="chat-prd-review-list">
              {summary.requirements.map((requirement) => <li>{requirement}</li>)}
            </ul>
          </section>
        ) : null}
        {summary.acceptanceCriteria.length > 0 ? (
          <section className="chat-prd-review-card">
            <h3>Acceptance Criteria</h3>
            <ul className="chat-prd-review-list">
              {summary.acceptanceCriteria.map((item) => <li>{item}</li>)}
            </ul>
          </section>
        ) : null}
        {summary.verification.length > 0 ? (
          <section className="chat-prd-review-card">
            <h3>Verification</h3>
            <ul className="chat-prd-review-list">
              {summary.verification.map((item) => <li>{item}</li>)}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function buildChatPrdReviewSummaryState(draft: ChatPrdDraftState) {
  const parsed = parsePrdSpecificationSummary(draft.specification);
  return {
    title: draft.title || parsed.title || draft.proposal.title || '',
    priority: parsed.priority,
    problem: parsed.problem,
    goal: parsed.goal,
    requirements: draft.requirements,
    acceptanceCriteria: parsed.acceptanceCriteria,
    verification: parsed.verification,
  };
}

function parsePrdSpecificationSummary(specification: string) {
  const lines = String(specification || '').split(/\r?\n/);
  let title = '';
  let priority = '';
  let currentSection = '';
  let currentBuffer: string[] = [];
  const sections: Record<string, string[]> = {};

  const commitSection = () => {
    if (!currentSection) {
      currentBuffer = [];
      return;
    }
    const values = currentBuffer
      .map((line) => line.trim())
      .filter(Boolean);
    sections[currentSection] = values;
    currentBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (currentSection) {
        currentBuffer.push('');
      }
      continue;
    }
    if (!title) {
      const titleMatch = line.match(/^#\s*PRD:\s*(.+)$/i);
      if (titleMatch) {
        title = titleMatch[1].trim();
        continue;
      }
    }
    if (!priority) {
      const priorityMatch = line.match(/^Priority:\s*(.+)$/i);
      if (priorityMatch) {
        priority = priorityMatch[1].trim();
        continue;
      }
    }
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      commitSection();
      currentSection = normalizePrdSectionName(sectionMatch[1]);
      continue;
    }
    if (currentSection) {
      currentBuffer.push(line);
    }
  }
  commitSection();

  return {
    title,
    priority,
    problem: sections.problem?.join(' ').trim() || '',
    goal: sections.goal?.join(' ').trim() || '',
    acceptanceCriteria: normalizePrdSectionList(sections.acceptanceCriteria),
    verification: normalizePrdSectionList(sections.verification),
  };
}

function normalizePrdSectionName(sectionHeading: string) {
  const normalized = String(sectionHeading || '').trim().toLowerCase();
  if (normalized === 'acceptance criteria') {
    return 'acceptanceCriteria';
  }
  return normalized;
}

function normalizePrdSectionList(lines: string[] | undefined) {
  return Array.isArray(lines)
    ? lines
      .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
      .filter(Boolean)
    : [];
}

function ChatMessage({ message }: { message: ChatMessageSummary }) {
  const role = message.role === 'agent' ? 'agent' : 'manager';
  const status = String(message.status || 'complete');
  const proposal = role === 'agent' && status === 'complete' ? resolveMessagePrdProposal(message) : null;
  const proposalKey = proposal ? getPrdProposalStableKey(proposal, message.id || '') : '';
  const showProposal = Boolean(proposal && proposalKey && !isChatPrdProposalDismissed(proposalKey));
  const meta = [
    role === 'agent' ? 'Repo agent' : 'Manager',
    status === 'complete' ? '' : status,
    message.updatedAt || message.createdAt ? formatTimestamp(message.updatedAt || message.createdAt) : '',
  ].filter(Boolean).join(' | ');

  return (
    <div className={`chat-message ${role} ${status}`}>
      <div className="chat-message-head">
        <span>{meta || (role === 'agent' ? 'Repo agent' : 'Manager')}</span>
      </div>
      <div className="chat-message-body">{message.content || ''}</div>
      {showProposal && proposal ? (
        <ChatPrdProposalCard
          messageId={message.id || ''}
          proposal={proposal}
          proposalKey={proposalKey}
        />
      ) : null}
    </div>
  );
}

function ChatPrdProposalCard({
  messageId,
  proposal,
  proposalKey,
}: {
  messageId: string;
  proposal: ControlPlanePrdProposal;
  proposalKey: string;
}) {
  const active = Boolean(activeChatPrdDraft && activeChatPrdDraft.key === proposalKey);
  const detail = [
    proposal.requirements.length ? `${proposal.requirements.length} requirement${proposal.requirements.length === 1 ? '' : 's'}` : '',
    proposal.acceptanceCriteria.length ? `${proposal.acceptanceCriteria.length} acceptance item${proposal.acceptanceCriteria.length === 1 ? '' : 's'}` : '',
    proposal.verification.length ? `${proposal.verification.length} verification step${proposal.verification.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' | ') || 'Structured PRD proposal';

  return (
    <div className="chat-prd-proposal">
      <div>
        <div className="pill">PRD proposal</div>
        <div className="chat-prd-proposal-title">{proposal.title}</div>
      </div>
      <div className="chat-prd-proposal-detail">{detail}</div>
      <div className="row">
        <button
          type="button"
          className="primary"
          data-action="review-chat-prd"
          data-message-id={messageId}
          data-proposal-key={proposalKey}
          data-prd-proposal={JSON.stringify(proposal)}
        >
          {active ? 'Resume review' : 'Review PRD draft'}
        </button>
        <button
          type="button"
          className="secondary"
          data-action="discard-chat-prd"
          data-proposal-key={proposalKey}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function resolveMessagePrdProposal(message: ChatMessageSummary) {
  return normalizePrdProposal(message.prdProposal, {
    repoId: entranceContext.repoId,
    responseMessageId: message.id,
    createdAt: message.updatedAt || message.createdAt,
  }) || extractPrdProposalFromText(String(message.content || ''), {
    repoId: entranceContext.repoId,
    responseMessageId: message.id,
    createdAt: message.updatedAt || message.createdAt,
  });
}

function MetricGrid({ dashboard }: { dashboard: DashboardSummary }) {
  const deployableRepoCount = resolveDeployableRepoCount(dashboard);
  const metrics = [
    ['Repos', dashboard.repoCount || 0],
    ['Active PRDs', dashboard.activePrdCount || 0],
    ['Queued PRDs', dashboard.queuedPrdCount || 0],
    ['Deployable repos', deployableRepoCount],
    ['Bridge jobs', dashboard.pendingJobCount || 0],
    ['Agents running', dashboard.runningAgentCount || 0],
    ['PRs awaiting action', dashboard.activePullRequestCount || 0],
  ] as const;

  return (
    <>
      {metrics.map(([label, value]) => (
        <div className="metric">
          <span>{label}</span>
          <strong>{String(value)}</strong>
        </div>
      ))}
    </>
  );
}

function HeartbeatStrip({
  controlPlane,
}: {
  controlPlane: ControlPlaneHeartbeatSummary;
}) {
  const server = controlPlane.server || {};
  const bridge = controlPlane.bridge || {};
  if (entranceContext.entrance === 'project') {
    const aggregate = resolveProjectHeartbeat(controlPlane);
    return (
      <div className={`status-chip ${statusClass(aggregate.status)}`}>
        <span className="status-dot" />
        <span>{aggregate.label}</span>
      </div>
    );
  }
  return (
    <>
      <div className={`status-chip ${statusClass(controlPlane.overallStatus)}`}>
        <span className="status-dot" />
        <span>Control plane: {controlPlane.statusLabel || 'Offline'}</span>
      </div>
      <div className="status-stack">
        <div className={`status-chip ${statusClass(server.status)}`}>
          <span className="status-dot" />
          <span>{server.label || 'Server'}: {server.statusLabel || 'Offline'}</span>
        </div>
        <div className={`status-chip ${statusClass(bridge.status)}`}>
          <span className="status-dot" />
          <span>{bridge.label || 'Bridge'}: {bridge.statusLabel || 'Offline'}</span>
        </div>
      </div>
    </>
  );
}

function buildQueuedMessage(job: { payload?: { id?: string; title?: string } } | null | undefined) {
  const generatedTitle = String(job && job.payload && job.payload.title || '').trim();
  const generatedId = String(job && job.payload && job.payload.id || '').trim();
  return generatedTitle || generatedId
    ? `Queued ${generatedTitle || 'PRD'}${generatedId ? ` (${generatedId})` : ''}.`
    : 'Queued.';
}

function openPrdModal() {
  if (!prdModalEl) {
    return;
  }
  prdModalEl.hidden = false;
  if (quickFormMessageEl) {
    quickFormMessageEl.textContent = '';
  }
  window.setTimeout(() => {
    quickPrdSpecEl?.focus();
  }, 0);
}

function closePrdModal() {
  if (!prdModalEl) {
    return;
  }
  prdModalEl.hidden = true;
}

function resolveProjectHeartbeat(controlPlane: ControlPlaneHeartbeatSummary) {
  const statuses = [
    String(controlPlane.server && controlPlane.server.status || 'offline'),
    String(controlPlane.bridge && controlPlane.bridge.status || 'offline'),
  ];
  if (statuses.every((status) => status === 'online')) {
    return { status: 'online', label: 'Online' };
  }
  if (statuses.includes('stale')) {
    return { status: 'stale', label: 'Stale' };
  }
  return { status: 'offline', label: 'Offline' };
}

function statusClass(status?: string) {
  return String(status || 'offline');
}

function resolveDeployableRepoCount(dashboard: DashboardSummary) {
  if (typeof dashboard.deployableRepoCount === 'number') {
    return dashboard.deployableRepoCount;
  }
  return countDeployableRepos(dashboard.repos || []);
}

function countDeployableRepos(repos: RepoSummary[]) {
  return repos.filter((repo) => Boolean(repo && repo.deployment && (repo.deployment.hasChanges || repo.deployment.deployable))).length;
}

function resolveApiUrl(pathname: string) {
  const normalizedPath = String(pathname || '').trim();
  if (!normalizedPath) {
    return normalizedPath;
  }
  if (/^https?:\/\//i.test(normalizedPath)) {
    return normalizedPath;
  }
  if (normalizedPath === '/api/dev-meta') {
    return normalizedPath;
  }
  return apiBaseUrl ? `${apiBaseUrl}${normalizedPath}` : normalizedPath;
}

function RepoStack({ repos, emptyMessage }: { repos: RepoSummary[]; emptyMessage: string }) {
  if (!repos.length) {
    return <div className="muted">{emptyMessage}</div>;
  }

  return (
    <>
      {repos.map((repo) => (
        entranceContext.entrance === 'manager'
          ? <ManagerRepoCard repo={repo} />
          : <ProjectRepoCard repo={repo} />
      ))}
    </>
  );
}

function ManagerRepoCard({ repo }: { repo: RepoSummary }) {
  const updated = repo.updatedAt ? `Updated ${formatTimestamp(repo.updatedAt)}` : 'No status snapshot yet';
  const freshnessStatus = String(repo.freshnessStatus || 'offline');
  const freshnessLabel = repo.freshnessStatusLabel || 'Offline';
  const deployment = repo.deployment || null;
  const projectUrl = repo.repoId ? `/project/${encodeURIComponent(repo.repoId)}` : '';
  const restartEvidence = repo.restartJob && repo.restartJob.restartEvidence ? repo.restartJob.restartEvidence : null;
  const latestHistoryPrd = Array.isArray(repo.prdHistory) && repo.prdHistory.length > 0 ? repo.prdHistory[0] : null;

  return (
    <article className="repo">
      <div className="repo-head">
        <div>
          <h3>{repo.label || repo.repoId || 'Repository'}</h3>
          <div className="muted">{repo.description || repo.repoId || ''}</div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', flex: '0 0 auto' }}>
          <div className={`status-chip ${statusClass(freshnessStatus)}`}>
            <span className="status-dot" />
            <span>{freshnessLabel}</span>
          </div>
          <span className="pill">{updated}</span>
        </div>
      </div>
      <p className="overview">{repo.freshnessDetail || repo.overview || 'No status snapshot yet'}</p>
      <div className="section-row">
        <RepoSection title="Repo">
          <div className="list-note">ID: {repo.repoId || 'unknown'}</div>
          {projectUrl ? (
            <a className="action-link" href={projectUrl}>
              Open repo control page
            </a>
          ) : null}
        </RepoSection>
        <RepoSection title="Version">
          <VersionStatus versionStatus={repo.versionStatus || null} />
        </RepoSection>
        <RepoSection title="Package">
          <PackageStatus packageStatus={repo.packageStatus || null} />
          <PackageUpdateButton repo={repo} />
        </RepoSection>
        <RepoSection title="PRD">
          {repo.activePrd ? (
            <div className="queued-prd">
              <div className="item-head">
                <div>
                  <div className="pill">{repo.activePrd.stateLabel || repo.activePrd.status || 'Active PRD'}</div>
                  <div className="queue-title" style={{ marginTop: '8px' }}>
                    {repo.activePrd.title || repo.activePrd.id || 'Active PRD'}
                  </div>
                </div>
              </div>
              <div className="queue-detail">
                {repo.activePrd.id || 'unknown PRD'}
                {repo.activePrd.detail ? ` | ${repo.activePrd.detail}` : ''}
              </div>
              {repo.prdResetJob ? (
                <div className="queue-detail" style={{ marginTop: '8px' }}>
                  Latest reset job: {repo.prdResetJob.statusLabel || repo.prdResetJob.status || 'queued'}
                  {repo.prdResetJob.detail ? ` | ${repo.prdResetJob.detail}` : ''}
                </div>
              ) : null}
              <PrdResetButton repo={repo} />
            </div>
          ) : latestHistoryPrd ? (
            <div className="queued-prd">
              <div className="item-head">
                <div>
                  <div className="pill">{latestHistoryPrd.stateLabel || latestHistoryPrd.status || 'Finished PRD'}</div>
                  <div className="queue-title" style={{ marginTop: '8px' }}>
                    {latestHistoryPrd.title || latestHistoryPrd.id || 'Latest history item'}
                  </div>
                </div>
              </div>
              <div className="queue-detail">
                {latestHistoryPrd.id || 'unknown PRD'}
                {latestHistoryPrd.detail ? ` | ${latestHistoryPrd.detail}` : ''}
              </div>
            </div>
          ) : (
            <div className="list-note">No active or finished PRDs recorded yet.</div>
          )}
        </RepoSection>
        <RepoSection title="Restart">
          <ManagerRestartSummary repo={repo} restartEvidence={restartEvidence} />
        </RepoSection>
        <RepoSection title="Deployment">
          <div className={`status-chip ${statusClass(deployment && deployment.status)}`}>
            <span className="status-dot" />
            <span>{deployment && deployment.statusLabel ? deployment.statusLabel : 'Deployment status unavailable'}</span>
          </div>
          <div className="list-note" style={{ marginTop: '8px' }}>
            {deployment && deployment.detail ? deployment.detail : 'No deployment status snapshot yet.'}
          </div>
          {repo.deploymentUrl ? (
            <a
              className="action-link"
              href={repo.deploymentUrl}
              target="_blank"
              rel="noreferrer"
            >
              {repo.deploymentLabel || 'Deployment site'}
            </a>
          ) : null}
        </RepoSection>
      </div>
    </article>
  );
}

function ProjectRepoCard({ repo }: { repo: RepoSummary }) {
  const updated = repo.updatedAt ? `Updated ${formatTimestamp(repo.updatedAt)}` : 'No status snapshot yet';
  const deployment = repo.deployment || null;
  const deployButtonState = buildDeployButtonState(repo);
  const showDeployButton = Boolean(repo.repoId && (deployButtonState.active || deployment && deployment.hasChanges));
  const deploymentStatus = deployment ? deployment.status : null;
  const restartEvidence = repo.restartJob && repo.restartJob.restartEvidence ? repo.restartJob.restartEvidence : null;

  return (
    <article className="repo">
      <div className="repo-head">
        <div>
          <h3>{repo.label || repo.repoId || 'Repository'}</h3>
          <div className="muted">{repo.description || repo.repoId || ''}</div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', flex: '0 0 auto' }}>
          {repo.default ? <span className="pill">Default repo</span> : null}
          <span className="pill">{updated}</span>
        </div>
      </div>
      <p className="overview">{repo.overview || 'No status snapshot yet'}</p>
      <div className="section-row">
        <RepoSection title="Active PRD">
          {repo.activePrd ? <PrdCard prd={repo.activePrd} label="Active PRD" /> : <div className="list-note">No active PRD yet.</div>}
        </RepoSection>
        <RepoSection title="Queued PRDs">
          {repo.queuedPrds && repo.queuedPrds.length > 0
            ? repo.queuedPrds.map((prd) => <PrdCard prd={prd} label="Queued PRD" />)
            : <div className="list-note">No queued PRDs.</div>}
        </RepoSection>
        <RepoSection title="Agents">
          {repo.agentStatuses && repo.agentStatuses.length > 0
            ? repo.agentStatuses.map((agent) => <AgentCard agent={agent} />)
            : <div className="list-note">No agent status yet.</div>}
        </RepoSection>
        <RepoSection title="Pull Requests">
          {repo.pullRequestStatuses && repo.pullRequestStatuses.length > 0
            ? repo.pullRequestStatuses.map((pullRequest) => <PullRequestCard pullRequest={pullRequest} />)
            : <div className="list-note">No pull requests awaiting action.</div>}
        </RepoSection>
        <RepoSection title="Autonomy v2">
          <PackageStatus packageStatus={repo.packageStatus || null} />
          <PackageUpdateButton repo={repo} />
        </RepoSection>
        <RepoSection title="Restart Evidence">
          <ProjectRestartPanel repo={repo} restartEvidence={restartEvidence} />
        </RepoSection>
        <RepoSection title="Deployment">
          <div className="queued-prd">
            <div className="item-head">
              <div>
                <div className={`status-chip ${statusClass(deploymentStatus)}`}>
                  <span className="status-dot" />
                  <span>{deployment && deployment.statusLabel ? deployment.statusLabel : 'Deploy status unavailable'}</span>
                </div>
                <div className="queue-title">
                  {deployment
                    ? `${deployment.sourceBranch || 'dev'} -> ${deployment.targetBranch || 'main'}`
                    : 'Deployment status'}
                </div>
              </div>
            </div>
            <div className="queue-detail">
              {deployment && deployment.detail ? deployment.detail : 'No deployment status snapshot yet.'}
            </div>
            {repo.deployJob ? (
              <div className="queue-detail" style={{ marginTop: '8px' }}>
                Latest deploy job: {repo.deployJob.statusLabel || repo.deployJob.status || 'queued'}
                {repo.deployJob.detail ? ` | ${repo.deployJob.detail}` : ''}
              </div>
            ) : null}
            <div className="repo-actions" style={{ marginTop: '12px' }}>
              {showDeployButton ? (
                <button
                  type="button"
                  className={`primary deploy-button${deployButtonState.busy ? ' is-loading' : ''}`}
                  data-action="deploy"
                  data-repo-id={repo.repoId || ''}
                  disabled={deployButtonState.disabled}
                  aria-busy={deployButtonState.busy}
                >
                  {deployButtonState.busy ? <span className="deploy-spinner" aria-hidden="true" /> : null}
                  <span>{deployButtonState.label}</span>
                </button>
              ) : null}
              {repo.deploymentUrl ? (
                <a
                  className="action-link"
                  href={repo.deploymentUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {repo.deploymentLabel || 'Deployment site'}
                </a>
              ) : null}
            </div>
          </div>
        </RepoSection>
      </div>
    </article>
  );
}

function RepoSection({ title, children }: { title: string; children: JSX.Element | JSX.Element[] }) {
  return (
    <div className="repo-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function ManagerRestartSummary({
  repo,
  restartEvidence,
}: {
  repo: RepoSummary;
  restartEvidence: RestartEvidenceSummary | null;
}) {
  if (!repo.restartJob) {
    return <div className="list-note">No restart job recorded yet.</div>;
  }
  if (!restartEvidence) {
    return <div className="list-note">{repo.restartJob.detail || 'Restart state unavailable.'}</div>;
  }
  const summary = buildManagerRestartSummary(restartEvidence);
  return (
    <div className="queued-prd">
      <div className="item-head">
        <div>
          <div className={`status-chip ${statusClass(restartEvidence.status)}`}>
            <span className="status-dot" />
            <span>{restartEvidence.statusLabel || 'Restart status unavailable'}</span>
          </div>
          <div className="queue-title">{summary.headline}</div>
        </div>
        {restartEvidence.completedAt ? <span className="pill">{formatTimestamp(restartEvidence.completedAt)}</span> : null}
      </div>
      <div className="queue-detail">{summary.detail}</div>
      {restartEvidence.compactSummary ? (
        <div className="queue-detail" style={{ marginTop: '8px' }}>{restartEvidence.compactSummary}</div>
      ) : null}
    </div>
  );
}

function ProjectRestartPanel({
  repo,
  restartEvidence,
}: {
  repo: RepoSummary;
  restartEvidence: RestartEvidenceSummary | null;
}) {
  if (!repo.restartJob) {
    return <div className="list-note">No restart job recorded yet.</div>;
  }
  if (!restartEvidence) {
    return <div className="list-note">{repo.restartJob.detail || 'Restart state unavailable.'}</div>;
  }
  const targets = Array.isArray(restartEvidence.targets) ? restartEvidence.targets : [];
  return (
    <div className="queued-prd">
      <div className="item-head">
        <div>
          <div className={`status-chip ${statusClass(restartEvidence.status)}`}>
            <span className="status-dot" />
            <span>{restartEvidence.statusLabel || 'Restart status unavailable'}</span>
          </div>
          <div className="queue-title">Latest restart</div>
        </div>
        {restartEvidence.completedAt ? <span className="pill">{formatTimestamp(restartEvidence.completedAt)}</span> : null}
      </div>
      <div className="queue-detail">
        {repo.restartJob.statusLabel || repo.restartJob.status || 'Restart recorded'}
        {repo.restartJob.detail ? ` | ${repo.restartJob.detail}` : ''}
      </div>
      {targets.length > 0 ? (
        targets.map((target) => <RestartTargetRow target={target} />)
      ) : (
        <div className="list-note" style={{ marginTop: '8px' }}>No per-target restart evidence recorded.</div>
      )}
    </div>
  );
}

function RestartTargetRow({ target }: { target: RestartEvidenceTargetSummary }) {
  const heartbeat = resolveTargetHeartbeat(target.target);
  const detailParts = [
    target.modeLabel ? `mode ${target.modeLabel.toLowerCase()}` : '',
    target.recordedAt ? `recorded ${formatTimestamp(target.recordedAt)}` : 'recorded time missing',
    target.completedAt ? `completed ${formatTimestamp(target.completedAt)}` : 'completion time missing',
    heartbeat ? `${heartbeat.label || 'Heartbeat'} ${heartbeat.statusLabel || 'Offline'}` : '',
  ].filter(Boolean);
  const secondaryParts = [
    buildTargetLifecycleLabel(target),
    target.reasonLabel ? `reason ${target.reasonLabel}` : '',
    target.pidChanged === true ? 'pid changed' : target.pidChanged === false ? 'pid unchanged' : 'pid change unknown',
    target.error || '',
  ].filter(Boolean);

  return (
    <div className="agent" style={{ marginTop: '12px' }}>
      <div className="agent-head">
        <div>
          <div className={`status-chip ${statusClass(target.status)}`}>
            <span className="status-dot" />
            <span>{target.statusLabel || target.status || 'Unknown'}</span>
          </div>
          <div className="agent-title">{target.compactLabel || buildTargetLifecycleLabel(target)}</div>
        </div>
        <div className={`status-chip ${statusClass(heartbeat && heartbeat.status)}`}>
          <span className="status-dot" />
          <span>{heartbeat ? `${heartbeat.label || 'Heartbeat'} ${heartbeat.statusLabel || 'Offline'}` : 'Heartbeat unavailable'}</span>
        </div>
      </div>
      <div className="agent-detail">{detailParts.join(' | ')}</div>
      {secondaryParts.length > 0 ? <div className="agent-detail" style={{ marginTop: '6px' }}>{secondaryParts.join(' | ')}</div> : null}
    </div>
  );
}

function PrdCard({ prd, label }: { prd: PrdSummary; label: string }) {
  const headline = prd.title || prd.id || 'Untitled PRD';
  const meta = [prd.stateLabel, prd.detail].filter(Boolean).join(' | ');

  return (
    <div className="queued-prd">
      <div className="item-head">
        <div>
          <div className="pill">{label}</div>
          <div className="queue-title">{headline}</div>
        </div>
        {prd.updatedAt ? <span className="pill">{formatTimestamp(prd.updatedAt)}</span> : null}
      </div>
      {meta ? <div className="queue-detail">{meta}</div> : null}
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentSummary }) {
  const details = [agent.workerStatus, agent.detail].filter(Boolean).join(' | ');

  return (
    <div className="agent">
      <div className="agent-head">
        <div>
          <div className="pill">{agent.role || agent.agentId || 'Agent'}</div>
          <div className="agent-title">{agent.agentId || 'unknown agent'}</div>
        </div>
        <span className="pill">{agent.pid ? `pid ${agent.pid}` : 'pid -'}</span>
      </div>
      {details ? <div className="agent-detail">{details}</div> : null}
    </div>
  );
}

function PullRequestCard({ pullRequest }: { pullRequest: PullRequestSummary }) {
  const statusLabel = pullRequest.statusLabel || pullRequest.status || 'Pull request';
  const details = [pullRequest.action, pullRequest.branch ? `branch ${pullRequest.branch}` : '']
    .filter(Boolean)
    .join(' | ');
  const title = pullRequest.title || pullRequest.prId || 'Untitled PR';

  return (
    <div className="pull-request">
      <div className="item-head">
        <div>
          <div className={`status-chip ${statusClass(pullRequestStatusClass(pullRequest))}`}>
            <span className="status-dot" />
            <span>{statusLabel}</span>
          </div>
          {pullRequest.url ? (
            <a
              className="pull-request-title pull-request-link"
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
            >
              {title}
            </a>
          ) : (
            <div className="pull-request-title">{title}</div>
          )}
        </div>
        {pullRequest.updatedAt ? <span className="pill">{formatTimestamp(pullRequest.updatedAt)}</span> : null}
      </div>
      {details ? <div className="pull-request-detail">{details}</div> : null}
    </div>
  );
}

function pullRequestStatusClass(pullRequest: PullRequestSummary) {
  const mergeState = String(pullRequest.mergeState || '').toLowerCase();
  const statusLabel = String(pullRequest.statusLabel || '').toLowerCase();
  if (mergeState === 'blocked' || statusLabel === 'blocked from merge') {
    return 'blocked';
  }
  if (mergeState === 'waiting' || statusLabel === 'approved waiting merge') {
    return 'waiting';
  }
  return 'online';
}

function PackageUpdateButton({ repo }: { repo: RepoSummary }) {
  const updateState = buildPackageUpdateButtonState(repo);
  const restartState = buildRestartButtonState(repo);
  if (!repo.repoId) {
    return null;
  }
  return (
    <div className="repo-actions" style={{ marginTop: '12px' }}>
      <button
        type="button"
        className={`secondary deploy-button${updateState.busy ? ' is-loading' : ''}`}
        data-action="package-update"
        data-repo-id={repo.repoId || ''}
        disabled={updateState.disabled}
        aria-busy={updateState.busy}
      >
        {updateState.busy ? <span className="deploy-spinner" aria-hidden="true" /> : null}
        <span>{updateState.label}</span>
      </button>
      <button
        type="button"
        className={`secondary deploy-button${restartState.busy ? ' is-loading' : ''}`}
        data-action="restart"
        data-repo-id={repo.repoId || ''}
        disabled={restartState.disabled}
        aria-busy={restartState.busy}
      >
        {restartState.busy ? <span className="deploy-spinner" aria-hidden="true" /> : null}
        <span>{restartState.label}</span>
      </button>
    </div>
  );
}

function PrdResetButton({ repo }: { repo: RepoSummary }) {
  const resetState = buildPrdResetButtonState(repo);
  if (!repo.repoId || !repo.activePrd) {
    return null;
  }
  return (
    <div className="repo-actions" style={{ marginTop: '12px' }}>
      <button
        type="button"
        className={`secondary deploy-button${resetState.busy ? ' is-loading' : ''}`}
        data-action="reset-prds"
        data-repo-id={repo.repoId || ''}
        disabled={resetState.disabled}
        aria-busy={resetState.busy}
      >
        {resetState.busy ? <span className="deploy-spinner" aria-hidden="true" /> : null}
        <span>{resetState.label}</span>
      </button>
    </div>
  );
}

function JobStack({ jobs }: { jobs: JobSummary[] }) {
  if (!jobs.length) {
    return <div className="muted">No bridge jobs queued yet.</div>;
  }

  return (
    <>
      {jobs.map((job) => <JobCard job={job} />)}
    </>
  );
}

function JobCard({ job }: { job: JobSummary }) {
  const details = [job.repoLabel, job.detail].filter(Boolean).join(' | ');

  return (
    <div className="job">
      <div className="job-head">
        <div>
          <div className="pill">{job.statusLabel || job.status || 'queued'}</div>
          <h3 style={{ marginTop: '8px' }}>{job.title || job.id || 'Untitled job'}</h3>
        </div>
        {job.updatedAt ? <span className="pill">{formatTimestamp(job.updatedAt)}</span> : null}
      </div>
      <div className="job-detail">{job.repoId || ''}{details ? ` | ${details}` : ''}</div>
    </div>
  );
}

function buildDeployButtonState(repo: RepoSummary | null) {
  const repoId = String(repo && repo.repoId || '').trim();
  const deployment = repo && repo.deployment ? repo.deployment : null;
  const jobStatus = String(repo && repo.deployJob && repo.deployJob.status || '').trim();
  const queueing = Boolean(repoId && deployingRepoIds.has(repoId));
  const deploying = jobStatus === 'claimed' || jobStatus === 'running';
  const queued = jobStatus === 'queued';
  const sourceBranch = deployment && deployment.sourceBranch ? deployment.sourceBranch : 'dev';
  const targetBranch = deployment && deployment.targetBranch ? deployment.targetBranch : 'main';

  if (queueing) {
    return {
      label: 'Queueing deploy...',
      disabled: true,
      busy: true,
      active: true,
    };
  }

  if (deploying) {
    return {
      label: 'Deploying...',
      disabled: true,
      busy: true,
      active: true,
    };
  }

  if (queued) {
    return {
      label: 'Deploy queued',
      disabled: true,
      busy: false,
      active: true,
    };
  }

  return {
    label: `Deploy ${sourceBranch} to ${targetBranch}`,
    disabled: false,
    busy: false,
    active: false,
  };
}

function buildPackageUpdateButtonState(repo: RepoSummary | null) {
  const repoId = String(repo && repo.repoId || '').trim();
  const jobStatus = String(repo && repo.packageUpdateJob && repo.packageUpdateJob.status || '').trim();
  const queueing = Boolean(repoId && updatingPackageRepoIds.has(repoId));
  const updating = jobStatus === 'claimed' || jobStatus === 'running';
  const queued = jobStatus === 'queued';

  if (queueing) {
    return {
      label: 'Queueing update...',
      disabled: true,
      busy: true,
    };
  }

  if (updating) {
    return {
      label: 'Updating package...',
      disabled: true,
      busy: true,
    };
  }

  if (queued) {
    return {
      label: 'Update queued',
      disabled: true,
      busy: false,
    };
  }

  return {
    label: 'Update package',
    disabled: false,
    busy: false,
  };
}

function buildPrdResetButtonState(repo: RepoSummary | null) {
  const repoId = String(repo && repo.repoId || '').trim();
  const jobStatus = String(repo && repo.prdResetJob && repo.prdResetJob.status || '').trim();
  const queueing = Boolean(repoId && resettingPrdRepoIds.has(repoId));
  const resetting = jobStatus === 'claimed' || jobStatus === 'running';
  const queued = jobStatus === 'queued';

  if (queueing) {
    return {
      label: 'Queueing reset...',
      disabled: true,
      busy: true,
    };
  }

  if (resetting) {
    return {
      label: 'Resetting PRD...',
      disabled: true,
      busy: true,
    };
  }

  if (queued) {
    return {
      label: 'Reset queued',
      disabled: true,
      busy: false,
    };
  }

  return {
    label: 'Reset PRD',
    disabled: false,
    busy: false,
  };
}

function buildRestartButtonState(repo: RepoSummary | null) {
  const repoId = String(repo && repo.repoId || '').trim();
  const jobStatus = String(repo && repo.restartJob && repo.restartJob.status || '').trim();
  const queueing = Boolean(repoId && restartingRepoIds.has(repoId));
  const restarting = jobStatus === 'claimed' || jobStatus === 'running';
  const queued = jobStatus === 'queued';

  if (queueing) {
    return {
      label: 'Queueing restart...',
      disabled: true,
      busy: true,
    };
  }

  if (restarting) {
    return {
      label: 'Restarting services...',
      disabled: true,
      busy: true,
    };
  }

  if (queued) {
    return {
      label: 'Restart queued',
      disabled: true,
      busy: false,
    };
  }

  return {
    label: 'Restart services',
    disabled: false,
    busy: false,
  };
}

function buildManagerRestartSummary(restartEvidence: RestartEvidenceSummary) {
  const targets = Array.isArray(restartEvidence.targets) ? restartEvidence.targets : [];
  const relaunched = targets.filter((target) => target.status === 'restarted').length;
  const changed = targets.filter((target) => target.pidChanged === true).length;
  const headline = restartEvidence.allTargetsChangedPid
    ? 'Both targets relaunched with new PIDs'
    : restartEvidence.allTargetsRelaunched
      ? 'Both targets relaunched'
      : `${relaunched}/${targets.length || 0} targets relaunched`;
  const detail = targets.length > 0
    ? `${changed}/${targets.length} targets changed PID`
    : 'No target evidence recorded';
  return { headline, detail };
}

function buildTargetLifecycleLabel(target: RestartEvidenceTargetSummary) {
  const pre = target.preRestartPid == null ? 'missing' : String(target.preRestartPid);
  const post = target.postRestartPid == null ? 'missing' : String(target.postRestartPid);
  return `${target.label || target.target || 'target'} pid ${pre} -> ${post}`;
}

function resolveTargetHeartbeat(target?: string) {
  const dashboard = latestDashboard || {};
  if (target === 'server') {
    return dashboard.serverHeartbeat || null;
  }
  if (target === 'controlBridge') {
    return dashboard.bridgeHeartbeat || null;
  }
  return null;
}

function formatTimestamp(value: string | null | undefined) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) {
    return String(value || 'unknown time');
  }

  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || 'Unexpected error');
}

function readEntranceContext(): EntranceContext {
  const body = document.body;
  const entrance = String(body?.dataset.controlPlaneEntrance || 'manager').trim() === 'project'
    ? 'project'
    : 'manager';
  return {
    entrance,
    repoId: String(body?.dataset.controlPlaneRepoId || '').trim(),
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountControlPlane();
}

export {
  ChatMessage,
  ChatPrdReviewSummary,
  ManagerRepoCard,
  ChatPrdProposalCard,
  PackageUpdateButton,
  ProjectMainProgressActions,
  PrdHistoryDetail,
  ProjectRepoCard,
  buildChatPrdDraftFormState,
  captureChatScrollSnapshot,
  closeChatPrdReviewModal,
  continueSourceChatFromPrd,
  isChatNearBottom,
  mountControlPlane,
  openChatPrdReviewModal,
  resolveProjectProgress,
  resolveSelectedHistoryState,
  resolveChatScrollDecision,
  resolvePrdHistoryContinueChat,
  submitActiveChatPrdDraftReview,
};
