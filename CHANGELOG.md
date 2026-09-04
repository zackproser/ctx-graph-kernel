# 1.0.0

Verification receipts now express current truth. A later failure or pending
recheck replaces an earlier pass for the same evidence, source, and verifier;
repeated checks from one verifier are not distinct work for cardinality. A later
passing remediation replaces the failure. Durable input order is authoritative.

This changes evaluation results for existing inputs. Consumers must explicitly
migrate their projections, preserve historical evaluation receipts, and record
the evaluation engine version. CTX migration 053 invalidates affected cached
completion projections and re-evaluates them with engine 2. Hash serialization,
graph shape, receipt writer versions, and run transitions are unchanged.
# GitHub CI obligations

Explicit green-CI delivery requests now require independent GitHub receipts on
every targeted repository lane. Artifact delivery alone is insufficient.
Merge-only graphs with a CI prerequisite are rejected with
`ci_obligation_uncovered` until a connector can enforce that prerequisite;
they are no longer advertised as launch-ready. Existing persisted graphs keep
their shape; consumers must invalidate draft caches on this kernel pin.
