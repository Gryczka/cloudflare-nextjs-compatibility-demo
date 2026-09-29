/** Deterministic candidate ranking for the disabled arbitrary-upload prototype. */
import type { DeploymentTarget } from './domain';

export const FINAL_TARGET_SELECTION_POLICY_VERSION = 'final-target-v1' as const;

export type CandidateOutcome = 'passed' | 'incompatible' | 'failed' | 'timed_out' | 'cancelled';

export interface FinalTargetCandidate {
	target: DeploymentTarget;
	outcome: CandidateOutcome;
	finalDeployEligible: boolean;
	exclusionReason?: string;
	artifactBytes: number | null;
	completedAt: string;
}

export interface FinalTargetSelection {
	selectedTarget: DeploymentTarget | null;
	rationale: {
		policyVersion: typeof FINAL_TARGET_SELECTION_POLICY_VERSION;
		ranking: DeploymentTarget[];
		eligiblePassedTargets: DeploymentTarget[];
		candidates: FinalTargetCandidate[];
		decision: string;
	};
}

const TARGET_RANKING: DeploymentTarget[] = ['vinext', 'opennext', 'container'];

/** Select the lightest successfully verified candidate, independent of input order.
 * @param candidates - Completed build candidates, including exclusions.
 * @returns Ranked evidence and the selected target (or null).
 */
export function selectFinalTarget(candidates: readonly FinalTargetCandidate[]): FinalTargetSelection {
	const orderedCandidates = candidates.map(copyCandidate).sort(compareCandidates);
	const eligiblePassedTargets = TARGET_RANKING.filter((target) =>
		orderedCandidates.some((candidate) => candidate.target === target && candidate.outcome === 'passed' && candidate.finalDeployEligible),
	);
	const selectedTarget = eligiblePassedTargets[0] ?? null;

	return {
		selectedTarget,
		rationale: {
			policyVersion: FINAL_TARGET_SELECTION_POLICY_VERSION,
			ranking: [...TARGET_RANKING],
			eligiblePassedTargets,
			candidates: orderedCandidates,
			decision: selectedTarget
				? `Selected ${selectedTarget}, the highest-ranked deploy-eligible passed target.`
				: 'No target selected because no candidate both passed and was final-deploy eligible.',
		},
	};
}

function copyCandidate(candidate: FinalTargetCandidate): FinalTargetCandidate {
	return {
		target: candidate.target,
		outcome: candidate.outcome,
		finalDeployEligible: candidate.finalDeployEligible,
		...(candidate.exclusionReason === undefined ? {} : { exclusionReason: candidate.exclusionReason }),
		artifactBytes: candidate.artifactBytes,
		completedAt: candidate.completedAt,
	};
}

function compareCandidates(left: FinalTargetCandidate, right: FinalTargetCandidate): number {
	const rankDifference = TARGET_RANKING.indexOf(left.target) - TARGET_RANKING.indexOf(right.target);
	if (rankDifference !== 0) return rankDifference;

	const leftKey = JSON.stringify([
		left.outcome,
		left.finalDeployEligible,
		left.exclusionReason ?? null,
		left.artifactBytes,
		left.completedAt,
	]);
	const rightKey = JSON.stringify([
		right.outcome,
		right.finalDeployEligible,
		right.exclusionReason ?? null,
		right.artifactBytes,
		right.completedAt,
	]);
	return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
