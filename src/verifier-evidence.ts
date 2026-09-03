// Verifier evidence contracts and their truth functions. Pure; zod only.
import { z } from 'zod';

export const HttpsUrl = z.string().url().max(2048).refine((value) => new URL(value).protocol === 'https:', {
  message: 'base_url must use HTTPS',
});

export const ErrorList = z.array(z.string().trim().min(1).max(2000)).max(50);

export const DeploymentEvidence = z.object({
  contract: z.literal('ctx.deployment-release-evidence.v1'),
  base_url: HttpsUrl,
  expected_tag: z.string().trim().min(1).max(200),
  public_health: z.object({
    contract: z.literal('ctx.health.v1'),
    ok: z.boolean(),
    release_tag: z.string().trim().min(1).max(200).nullable(),
  }),
  app_health: z.object({
    contract: z.literal('ctx.app-health.v1'),
    ok: z.boolean(),
    failed_checks: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
  }),
  failure: z.string().trim().min(1).max(2000).nullable().default(null),
});

export const BrowserFixture = z.object({
  name: z.string().trim().min(1).max(120),
  width: z.number().int().min(240).max(7680),
  height: z.number().int().min(320).max(7680),
  assertions_passed: z.number().int().nonnegative().max(10_000),
  overflow: z.boolean(),
});

export const BrowserEvidence = z.object({
  contract: z.literal('ctx.browser-smoke-evidence.v1'),
  base_url: HttpsUrl,
  fixtures: z.array(BrowserFixture).min(1).max(40),
  console_errors: ErrorList,
  page_errors: ErrorList,
  failure: z.string().trim().min(1).max(2000).nullable().default(null),
});

// The truth functions. CTX stores what these compute, never the caller's
// `passed`; the runner's assertion is only checked for agreement at the service boundary.
export function deploymentEvidencePassed(evidence: z.infer<typeof DeploymentEvidence>) {
  return evidence.public_health.ok && evidence.app_health.ok
    && evidence.public_health.release_tag === evidence.expected_tag;
}

export function browserEvidencePassed(evidence: z.infer<typeof BrowserEvidence>) {
  return evidence.fixtures.some((fixture) => fixture.width > 720)
    && evidence.fixtures.some((fixture) => fixture.width <= 480)
    && evidence.console_errors.length === 0
    && evidence.page_errors.length === 0
    && evidence.fixtures.every((fixture) => fixture.assertions_passed > 0 && !fixture.overflow);
}
