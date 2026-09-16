import type { AutomationCoordinator } from './coordinator.ts';
import { POLL_RECORD_CEILING } from './github-poller.ts';
import type { GithubCandidate, GithubPoller, GithubPollResult } from './github-poller.ts';
import { ScheduleRunner, type ScheduleLauncher } from './schedule-runner.ts';
import type { AutomationStore } from './store.ts';
import { isGithubAutomation, isScheduleAutomation, type GithubAutomationDefinition } from './types.ts';

export interface AutomationLaunchResult { runId: string }
export type AutomationLauncher = (
  definition: GithubAutomationDefinition,
  candidate: GithubCandidate,
  receiptId: string,
) => Promise<AutomationLaunchResult>;

/**
 * One project as the schedulers see it. `github` is present only for a project whose remote is
 * on github.com (spec 2026-09-14-automations-redesign): a project without it still gets a
 * handle, so its scheduled automations fire — only the poll kind is skipped.
 */
export interface ProjectAutomationHandle {
  projectId: string;
  store: AutomationStore;
  /** The zone every schedule is evaluated in — the server's own. */
  timeZone: string;
  github?: { owner: string; repo: string; poller: GithubPoller };
  launch?: AutomationLauncher;
  launchSchedule?: ScheduleLauncher;
  onChange?: (automationId: string, revision: number) => void;
  now?: () => number;
}

/** One request chain process-wide. The promise tail also prevents a failed request from
 * poisoning later projects. */
class GithubRequestArbiter {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.tail.then(operation, operation);
    this.tail = current.catch(() => undefined);
    return current;
  }
}
const githubRequests = new GithubRequestArbiter();

export class ProjectAutomationScheduler {
  constructor(private readonly handle: ProjectAutomationHandle) {}

  async check(definition: GithubAutomationDefinition, mode: 'preview' | 'execute' = 'execute'): Promise<GithubPollResult> {
    const github = this.handle.github;
    if (!github) throw new Error('No GitHub remote is configured');
    const detectionOnly = mode === 'execute' && !this.handle.launch;
    if (detectionOnly) mode = 'preview';
    const { store } = this.handle;
    const lease = store.acquireLease();
    if (!lease) throw new Error('automation polling lease is held by another process');
    const started = Date.now();
    let completion: { result: 'preview' | 'no-match'; reason: string } | undefined;
    try {
      const state = store.state(definition.id) ?? {};
      if (state.backoffUntil && Date.parse(state.backoffUntil) > Date.now()) {
        throw new Error(`automation is backed off until ${state.backoffUntil}`);
      }
      const since = state.cursor?.timestamp ?? state.baselineAt;
      const overlapSince = since
        ? new Date(Date.parse(since) - 120_000).toISOString()
        : undefined;
      const drain = (maxRecords?: number) => githubRequests.run(() => github.poller.poll(
        github.owner,
        github.repo,
        definition,
        maxRecords === undefined ? { since: overlapSince } : { since: overlapSince, maxRecords },
      ));
      let result = await drain();
      /**
       * A poll whose whole budget lands inside the 120-second overlap band hands back the cursor
       * it was given, and the next interval derives the identical window from that same cursor:
       * the automation is pinned, logs `no-match` forever, and never fires again (#982). Only the
       * scheduler holds the stored cursor, so only it can tell "this poll made no progress" from
       * "this poll found nothing new" — and `laterCursor` answers that by reference, returning its
       * `current` argument unchanged when the observation is not later.
       */
      const pinned = (observed: GithubPollResult): boolean =>
        observed.truncated && laterCursor(state.cursor, observed.cursor) === state.cursor;
      let budget = Math.min(definition.filters.maxRecords, POLL_RECORD_CEILING);
      let exhausted = false;
      let climbedTo: number | undefined;
      /**
       * A band still saturated at the ceiling is at the search API's own limit and stays pinned,
       * so the climb is paid ONCE per pinned cursor: `pinnedCursor` records the cursor the ladder
       * failed at, and the cursor moving off it is the recovery path that clears it.
       */
      const stillPinned = sameCursor(state.pinnedCursor, state.cursor);
      if (mode === 'execute' && state.cursor && !stillPinned) {
        // Safe to widen: `poll()` evaluates a contiguous prefix and takes its cursor from the last
        // evaluated observation, so a bigger budget only reaches further into the same ordered run.
        while (pinned(result) && budget < POLL_RECORD_CEILING) {
          budget = Math.min(budget * 2, POLL_RECORD_CEILING);
          result = await drain(budget);
          climbedTo = budget;
        }
        exhausted = pinned(result);
      }
      const eligible = result.candidates.filter((candidate) => {
        if (state.baselineAt && candidate.timestamp <= state.baselineAt) return false;
        if (!state.cursor) return true;
        const overlap = Date.parse(state.cursor.timestamp) - 120_000;
        return Date.parse(candidate.timestamp) >= overlap;
      });
      if (mode === 'execute' && this.handle.launch) {
        for (const candidate of eligible) await this.launch(definition, candidate);
      }
      if (mode === 'execute') {
        const now = new Date().toISOString();
        store.setState(definition.id, (current) => {
          const cursor = laterCursor(current.cursor, result.cursor);
          return {
            ...current,
            revision: definition.revision,
            cursor,
            frozenHighWatermark: result.truncated && cursor?.tieBreaker
              ? { timestamp: cursor.timestamp, tieBreaker: cursor.tieBreaker }
              : undefined,
            pinnedCursor: exhausted
              ? cursor
              : sameCursor(current.pinnedCursor, cursor) ? current.pinnedCursor : undefined,
            lastSuccessAt: now,
            nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1_000).toISOString(),
            consecutiveFailures: 0,
            backoffUntil: undefined,
          };
        });
      } else if (detectionOnly) {
        store.setState(definition.id, (current) => ({
          ...current,
          revision: definition.revision,
          nextCheckAt: new Date(Date.now() + definition.intervalSeconds * 1_000).toISOString(),
        }));
      }
      this.handle.onChange?.(definition.id, definition.revision);
      completion = mode === 'preview'
        ? { result: 'preview', reason: `Bounded preview found ${eligible.length} match${eligible.length === 1 ? '' : 'es'}; no tasks were launched.` }
        : {
          result: 'no-match',
          reason: pollReason({
            climbedTo,
            exhausted,
            // The marker only still describes this poll if the cursor did not move after all.
            stillPinned: stillPinned && laterCursor(state.cursor, result.cursor) === state.cursor,
            cursor: state.cursor,
          }),
        };
      return { ...result, candidates: eligible };
    } catch (error) {
      if (mode === 'execute') this.recordFailure(definition, error);
      else store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'error', reason: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (completion) store.appendLog({ automationId: definition.id, revision: definition.revision, ...completion, durationMs: Date.now() - started });
      try { store.maybeCompact(); } catch { /* append-only state remains readable; next check retries */ }
      lease.release();
    }
  }

  private async launch(definition: GithubAutomationDefinition, candidate: GithubCandidate): Promise<void> {
    const receipt = this.handle.store.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId: candidate.eventId, candidate });
    if (!receipt) {
      this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event, result: 'duplicate', reason: 'A durable receipt already exists for this automation and event.', githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
      return;
    }
    try {
      const launched = await this.handle.launch!(definition, candidate, receipt.receiptId);
      this.handle.store.appendReceipt({ ...receipt, status: 'launched', runId: launched.runId, updatedAt: new Date().toISOString() });
      this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, event: candidate.event, result: 'launched', receiptId: receipt.receiptId, runId: launched.runId, githubNumber: candidate.number, githubTitle: candidate.title, githubUrl: candidate.url });
    } catch (error) {
      this.handle.store.appendReceipt({ ...receipt, status: 'launch-error', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
      throw error;
    }
  }

  private recordFailure(definition: GithubAutomationDefinition, error: unknown): void {
    this.handle.store.setState(definition.id, (current) => {
      const failures = (current.consecutiveFailures ?? 0) + 1;
      const delay = Math.min(6 * 60 * 60_000, 60_000 * 2 ** (failures - 1));
      return {
        ...current,
        consecutiveFailures: failures,
        backoffUntil: new Date(Date.now() + delay).toISOString(),
        nextCheckAt: new Date(Date.now() + delay).toISOString(),
      };
    });
    this.handle.store.appendLog({ automationId: definition.id, revision: definition.revision, result: 'error', reason: error instanceof Error ? error.message : String(error) });
    this.handle.onChange?.(definition.id, definition.revision);
  }
}

/**
 * What the `no-match` row says. A pinned cursor used to be invisible — the only trace anywhere was
 * `frozenHighWatermark` in `automation-state.json` (#982) — so the poll log now names it.
 */
function pollReason(poll: {
  climbedTo?: number;
  exhausted: boolean;
  stillPinned: boolean;
  cursor?: { timestamp: string };
}): string {
  if (poll.exhausted || poll.stillPinned) {
    return `The 120-second overlap band at ${poll.cursor?.timestamp} holds ${POLL_RECORD_CEILING} or more records, `
      + 'so the cursor cannot advance past it. Narrow the automation\'s filter to let it move again; '
      + 'until it does, the widening re-poll is skipped.';
  }
  if (poll.climbedTo !== undefined) {
    return `The overlap band was saturated; a ${poll.climbedTo}-record re-poll moved the cursor past it.`;
  }
  return 'Scheduled check completed.';
}

/** Cursor identity — the marker only holds while the stored cursor is still the one it recorded. */
function sameCursor(
  a: { timestamp: string; tieBreaker?: string } | undefined,
  b: { timestamp: string; tieBreaker?: string } | undefined,
): boolean {
  if (!a || !b) return false;
  return a.timestamp === b.timestamp && (a.tieBreaker ?? '') === (b.tieBreaker ?? '');
}

function laterCursor(
  current: { timestamp: string; tieBreaker?: string } | undefined,
  observed: { timestamp: string; tieBreaker: string } | undefined,
): { timestamp: string; tieBreaker?: string } | undefined {
  if (!observed) return current;
  if (!current) return observed;
  const order = observed.timestamp.localeCompare(current.timestamp)
    || observed.tieBreaker.localeCompare(current.tieBreaker ?? '');
  return order > 0 ? observed : current;
}

export interface WorkspaceAutomationSchedulerOptions {
  coordinator: AutomationCoordinator;
  handle: (projectId: string, store: AutomationStore) => ProjectAutomationHandle | undefined;
  now?: () => number;
}

/** One workspace timer, created only while at least one enabled definition exists. */
export class WorkspaceAutomationScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private scheduleGeneration = 0;
  constructor(private readonly options: WorkspaceAutomationSchedulerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.reschedule();
  }

  async reschedule(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.scheduleGeneration;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.options.coordinator.refresh();
    if (this.stopped || generation !== this.scheduleGeneration) return;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.scheduleGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  hasTimer(): boolean { return this.timer !== undefined; }

  /**
   * Arm ONE timer for the earliest due item across every project and both kinds: a poll is due
   * at its `nextCheckAt`, a schedule at its `nextRunAt` (computed and persisted on first sight by
   * `ScheduleRunner.dueAt`). A poll whose project has no GitHub remote is skipped — the handle
   * says so — and a schedule needs no remote at all.
   */
  private schedule(): void {
    if (this.stopped) return;
    const now = this.options.now?.() ?? Date.now();
    const due: Array<{ at: number; fire: () => Promise<unknown> }> = [];
    for (const projectId of this.options.coordinator.enabledProjectIds()) {
      const store = this.options.coordinator.store(projectId);
      if (!store) continue;
      const handle = this.options.handle(projectId, store);
      if (!handle) continue;
      for (const definition of store.list().filter((item) => item.enabled)) {
        if (isGithubAutomation(definition)) {
          if (!handle.github) continue;
          const scheduler = new ProjectAutomationScheduler(handle);
          due.push({ at: Date.parse(store.state(definition.id)?.nextCheckAt ?? new Date(now).toISOString()), fire: () => scheduler.check(definition) });
        } else if (isScheduleAutomation(definition)) {
          const runner = new ScheduleRunner({ ...handle, launch: handle.launchSchedule, now: this.options.now });
          const at = runner.dueAt(definition);
          if (at === null) continue;
          due.push({ at, fire: () => runner.fire(definition) });
        }
      }
    }
    if (!due.length) return;
    due.sort((a, b) => a.at - b.at);
    const next = due[0]!;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void next.fire().catch(() => undefined).finally(() => this.schedule());
    }, Math.max(0, next.at - now));
  }
}
