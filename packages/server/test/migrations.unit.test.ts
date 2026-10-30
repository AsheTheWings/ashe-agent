import { describe, expect, test } from "bun:test"
import { discoverMigrations, migrationStatus, MigrationError, type LedgerEntry } from "../src/store/migrations.ts"

const files = [
  { file: "0002_two.sql", sql: "CREATE TABLE b (x INTEGER);" },
  { file: "0001_one.sql", sql: "CREATE TABLE a (x INTEGER);" },
]

const kindOf = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    if (error instanceof MigrationError) return error.kind
    throw error
  }
  return "none"
}

describe("discovery", () => {
  test("orders migrations by position and hashes their SQL", () => {
    const migrations = discoverMigrations(files)
    expect(migrations.map((m) => m.name)).toEqual(["0001_one.sql", "0002_two.sql"])
    expect(migrations[0]!.sha256).toBe(new Bun.CryptoHasher("sha256").update(files[1]!.sql).digest("hex"))
  })

  test("refuses a misnamed file, a gap, and a repeated position", () => {
    expect(kindOf(() => discoverMigrations([{ file: "one.sql", sql: "" }]))).toBe("directory")
    expect(kindOf(() => discoverMigrations([{ file: "0002_two.sql", sql: "" }]))).toBe("gap")
    expect(
      kindOf(() => discoverMigrations([...files, { file: "0002_again.sql", sql: "" }])),
    ).toBe("duplicate")
  })
})

describe("status", () => {
  const migrations = discoverMigrations(files)
  const entry = (index: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
    position: migrations[index]!.position,
    name: migrations[index]!.name,
    sha256: migrations[index]!.sha256,
    appliedAt: 0,
    ...overrides,
  })

  test("lists the migrations after the ledger as pending", () => {
    expect(migrationStatus([], migrations).pending).toHaveLength(2)
    expect(migrationStatus([entry(0)], migrations).pending.map((m) => m.name)).toEqual(["0002_two.sql"])
    expect(migrationStatus([entry(0), entry(1)], migrations).pending).toEqual([])
  })

  test("refuses drift, gaps, repeats, and unknown migrations", () => {
    expect(kindOf(() => migrationStatus([entry(0, { sha256: "0".repeat(64) })], migrations))).toBe("drift")
    expect(kindOf(() => migrationStatus([entry(0, { name: "0001_other.sql" })], migrations))).toBe("drift")
    expect(kindOf(() => migrationStatus([entry(1)], migrations))).toBe("gap")
    expect(kindOf(() => migrationStatus([entry(0), entry(0)], migrations))).toBe("duplicate")
    expect(
      kindOf(() => migrationStatus([entry(0), entry(1), { ...entry(1), position: 3, name: "0003_x.sql" }], migrations)),
    ).toBe("unknown")
  })
})
