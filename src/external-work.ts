import type { CompletionGraphShapeLike } from './types.js';

/** Durable external waits use the ordinary graph; they never hold executor jobs. */
export function externalWorkGraph(caseId: string): CompletionGraphShapeLike {
  const gates = [
    ['intake', 'Source mail retained', 'ctx.mail-intake-verifier'],
    ['packet', 'Answers grounded and authorized', 'ctx.packet-verifier'],
    ['submitted', 'Provider confirmed submission', 'ctx.web-form-verifier'],
    ['booking', 'Organizer confirmed a future call', 'ctx.calendar-booking-verifier'],
    ['owner_update', 'Booking clearly recorded in CTX', 'ctx.owner-update-verifier'],
  ];
  return {
    nodes: gates.map(([key, title, verifier]) => ({
      key: key!, title: title!, description: 'Verified by the external-work controller from retained source evidence. Provider waits are durable; agent claims cannot satisfy this gate.',
      kind: 'verification_gate', policy: 'required', cardinality: { mode: 'at_least', target: 1 },
      evaluator: 'ctx.declarative', evaluator_version: '1',
      predicate: { op: 'observation_count', observation_kind: 'verification_receipt', min_count: 1,
        matches: [{ path: 'verifier_id', operator: 'eq', value: verifier },
          { path: 'case_id', operator: 'eq', value: caseId }, { path: 'passed', operator: 'eq', value: true }] },
    })),
    edges: gates.slice(1).map(([key], index) => ({ from: key!, to: gates[index]![0]!, kind: 'depends_on' })),
    initial_memberships: [],
  };
}
