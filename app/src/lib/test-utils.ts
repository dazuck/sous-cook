import { vi, Mock } from "vitest";

// =============================================================================
// Mock Database Utilities
// =============================================================================

export interface MockDbResult<T> {
  rows: T[];
}

/**
 * Type for mocked Drizzle database methods
 * Use this instead of `any` when mocking db.select, db.insert, etc.
 */
export interface MockDb {
  select: Mock;
  insert: Mock;
  update: Mock;
  delete: Mock;
  transaction: Mock;
}

/**
 * Cast the mocked db to a MockDb type for type-safe mock assignment
 */
export function asMockDb(db: unknown): MockDb {
  return db as MockDb;
}

/**
 * Create a mock query builder that simulates Drizzle's chained API
 */
export function createMockQueryBuilder<T>(returnData: T[]) {
  const builder = {
    _data: returnData,
    select: vi.fn(() => builder),
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    desc: vi.fn(() => builder),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve(returnData)),
      })),
      returning: vi.fn(() => Promise.resolve(returnData)),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve(returnData)),
        })),
      })),
    })),
    then: vi.fn((resolve) => resolve(returnData)),
  };
  return builder;
}

/**
 * Reset all mocks between tests
 */
export function resetMocks() {
  vi.clearAllMocks();
}
