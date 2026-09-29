import { describe, expect, it } from 'vitest';
import {
	FINAL_TARGET_SELECTION_POLICY_VERSION,
	selectFinalTarget,
	type CandidateOutcome,
	type FinalTargetCandidate,
} from '../src/selection';
import type { DeploymentTarget } from '../src/domain';

const completedAt = '2026-09-08T12:00:00.000Z';

describe('final target selection', () => {
	it('selects Vinext when all targets pass', () => {
		const result = selectFinalTarget([
			candidate('container', { artifactBytes: 1 }),
			candidate('opennext', { artifactBytes: 2 }),
			candidate('vinext', { artifactBytes: 2 }),
		]);

		expect(result.selectedTarget).toBe('vinext');
		expect(result.rationale.eligiblePassedTargets).toEqual(['vinext', 'opennext', 'container']);
	});

	it('selects OpenNext when it is the only deploy-eligible passed target', () => {
		const result = selectFinalTarget([
			candidate('vinext', { outcome: 'incompatible', finalDeployEligible: false, artifactBytes: null }),
			candidate('opennext'),
			candidate('container', { outcome: 'failed', finalDeployEligible: false, artifactBytes: null }),
		]);

		expect(result.selectedTarget).toBe('opennext');
	});

	it('selects the container when it is the only deploy-eligible passed target', () => {
		const result = selectFinalTarget([
			candidate('vinext', { outcome: 'incompatible', finalDeployEligible: false, artifactBytes: null }),
			candidate('opennext', { outcome: 'incompatible', finalDeployEligible: false, artifactBytes: null }),
			candidate('container'),
		]);

		expect(result.selectedTarget).toBe('container');
	});

	it('does not select a passed but ineligible container', () => {
		const result = selectFinalTarget([
			candidate('container', {
				finalDeployEligible: false,
				exclusionReason: 'Artifact cannot be used for the final deployment.',
			}),
		]);

		expect(result.selectedTarget).toBeNull();
		expect(result.rationale.candidates[0]).toMatchObject({
			outcome: 'passed',
			finalDeployEligible: false,
			exclusionReason: 'Artifact cannot be used for the final deployment.',
		});
	});

	it('returns no selection for mixed terminal failures', () => {
		const result = selectFinalTarget([
			candidate('vinext', { outcome: 'failed', finalDeployEligible: false, artifactBytes: null }),
			candidate('opennext', { outcome: 'timed_out', finalDeployEligible: false, artifactBytes: null }),
			candidate('container', { outcome: 'cancelled', finalDeployEligible: false, artifactBytes: null }),
		]);

		expect(result.selectedTarget).toBeNull();
		expect(result.rationale.eligiblePassedTargets).toEqual([]);
	});

	it('is independent of input order', () => {
		const candidates = [
			candidate('container'),
			candidate('vinext', { outcome: 'incompatible', finalDeployEligible: false, artifactBytes: null }),
			candidate('opennext'),
		];

		expect(selectFinalTarget(candidates)).toEqual(selectFinalTarget([...candidates].reverse()));
	});

	it('returns a versioned deterministic rationale with candidate evidence', () => {
		const result = selectFinalTarget([
			candidate('container', {
				outcome: 'passed',
				finalDeployEligible: false,
				exclusionReason: 'Final container image was not produced.',
				artifactBytes: 8_192,
				completedAt: '2026-09-08T12:00:03.000Z',
			}),
			candidate('opennext', {
				artifactBytes: 4_096,
				completedAt: '2026-09-08T12:00:02.000Z',
			}),
			candidate('vinext', {
				outcome: 'incompatible',
				finalDeployEligible: false,
				exclusionReason: 'Compatibility checks failed.',
				artifactBytes: null,
				completedAt: '2026-09-08T12:00:01.000Z',
			}),
		]);

		expect(result).toEqual({
			selectedTarget: 'opennext',
			rationale: {
				policyVersion: FINAL_TARGET_SELECTION_POLICY_VERSION,
				ranking: ['vinext', 'opennext', 'container'],
				eligiblePassedTargets: ['opennext'],
				candidates: [
					{
						target: 'vinext',
						outcome: 'incompatible',
						finalDeployEligible: false,
						exclusionReason: 'Compatibility checks failed.',
						artifactBytes: null,
						completedAt: '2026-09-08T12:00:01.000Z',
					},
					{
						target: 'opennext',
						outcome: 'passed',
						finalDeployEligible: true,
						artifactBytes: 4_096,
						completedAt: '2026-09-08T12:00:02.000Z',
					},
					{
						target: 'container',
						outcome: 'passed',
						finalDeployEligible: false,
						exclusionReason: 'Final container image was not produced.',
						artifactBytes: 8_192,
						completedAt: '2026-09-08T12:00:03.000Z',
					},
				],
				decision: 'Selected opennext, the highest-ranked deploy-eligible passed target.',
			},
		});
	});
});

function candidate(
	target: DeploymentTarget,
	overrides: Partial<Omit<FinalTargetCandidate, 'target'>> & { outcome?: CandidateOutcome } = {},
): FinalTargetCandidate {
	return {
		target,
		outcome: 'passed',
		finalDeployEligible: true,
		artifactBytes: 1_024,
		completedAt,
		...overrides,
	};
}
