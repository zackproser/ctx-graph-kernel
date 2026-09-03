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
