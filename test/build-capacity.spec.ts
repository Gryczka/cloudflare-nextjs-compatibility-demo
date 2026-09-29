import { describe, expect, it } from 'vitest';
import {
	capacityRetryAfterMs,
	canGrantCapacity,
	MAX_LEASE_TTL_MS,
	MIN_LEASE_TTL_MS,
	nextCapacityExpiryAt,
	TOTAL_SANDBOX_SLOTS,
	validateCapacityAcquireRequest,
	type CapacityAcquireRequest,
} from '../src/build-capacity';

const validRequest: CapacityAcquireRequest = {
	runId: '11111111-1111-4111-8111-111111111111',
	ownerPrincipalId: 'access-user:test',
	slots: 1,
	now: 1_800_000_000_000,
	ttlMs: MIN_LEASE_TTL_MS,
};

describe('capacity request validation', () => {
	it('accepts both slot sizes and inclusive TTL bounds', () => {
		expect(validateCapacityAcquireRequest(validRequest)).toEqual(validRequest);
		expect(validateCapacityAcquireRequest({ ...validRequest, slots: 3, ttlMs: MAX_LEASE_TTL_MS })).toEqual({
			...validRequest,
			slots: 3,
			ttlMs: MAX_LEASE_TTL_MS,
		});
		expect(TOTAL_SANDBOX_SLOTS).toBe(3);
	});

	it('normalizes identity fields and rejects malformed requests', () => {
		expect(
			validateCapacityAcquireRequest({
				...validRequest,
				runId: validRequest.runId.toUpperCase(),
				ownerPrincipalId: '  access-user:test  ',
			}),
		).toEqual(validRequest);

		expect(() => validateCapacityAcquireRequest({ ...validRequest, runId: 'not-a-uuid' })).toThrow('runId must be a UUID');
		expect(() => validateCapacityAcquireRequest({ ...validRequest, ownerPrincipalId: '   ' })).toThrow('ownerPrincipalId must be nonempty');
		expect(() => validateCapacityAcquireRequest({ ...validRequest, slots: 2 as 1 })).toThrow('slots must be 1 or 3');
		expect(() => validateCapacityAcquireRequest({ ...validRequest, now: 1.5 })).toThrow('now must be nonnegative epoch milliseconds');
		expect(() => validateCapacityAcquireRequest({ ...validRequest, ttlMs: MIN_LEASE_TTL_MS - 1 })).toThrow('ttlMs must be between');
		expect(() => validateCapacityAcquireRequest({ ...validRequest, ttlMs: MAX_LEASE_TTL_MS + 1 })).toThrow('ttlMs must be between');
	});
});

describe('capacity scheduling helpers', () => {
	it('admits only the FIFO head when enough slots are free', () => {
		expect(canGrantCapacity(1, 0, 3)).toBe(true);
		expect(canGrantCapacity(1, 1, 3)).toBe(false);
		expect(canGrantCapacity(2, 1, 1)).toBe(false);
		expect(canGrantCapacity(1, 2, 1)).toBe(true);
	});

	it('retries at the next live lease or request expiry', () => {
		const now = 10_000;
		expect(nextCapacityExpiryAt([9_000, 15_000, 12_000], now)).toBe(12_000);
		expect(capacityRetryAfterMs(now, [9_000, 15_000, 12_000])).toBe(2_000);
		expect(capacityRetryAfterMs(now, [9_000, 10_000])).toBe(1);
	});
});
