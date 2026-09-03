// Run lifecycle state machine. Pure.
import { WORK_RUN_STATES, type WorkRunState } from './work-contracts';

// The one run-state model. Every `update agent_jobs ... set state` below pins
// its from-states through runStatesThatMayEnter, so a hand-typed guard cannot
// drift from this table. Self-transitions (lease renewal, re-dispatch, repeated
// executor status) are legal; terminal states are additionally refused by the
// callers before this check.
const STATE_TRANSITIONS: Record<WorkRunState, readonly WorkRunState[]> = {
  queued: ['running', 'failed'],
  running: ['needs_input', 'failed', 'delivered', 'verified'],
  needs_input: ['running', 'failed', 'delivered', 'verified'],
  failed: [],
  delivered: ['verified', 'failed'],
  verified: [],
};

export function legalRunTransition(from: WorkRunState, to: WorkRunState) {
  return from === to || STATE_TRANSITIONS[from].includes(to);
}

// From-states a writer may move into `to`. `only` narrows to the writer's own
// candidates (a reconciler closes running jobs, not needs_input ones) and
// throws before touching storage if a listed state could never legally enter `to`.
export function runStatesThatMayEnter(to: WorkRunState, only?: readonly WorkRunState[]) {
  const legal = WORK_RUN_STATES.filter((from) => legalRunTransition(from, to));
  if (!only) return legal;
  const illegal = only.filter((from) => !legal.includes(from));
  if (illegal.length) throw new Error(`illegal run transition ${illegal.join(', ')} → ${to}`);
  return [...only];
}
