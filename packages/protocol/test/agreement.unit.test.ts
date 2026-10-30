import { describe, expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import { Arbitrary, Effect, Result, Schema } from "effect"
import { jsonSchemaRoots, toJsonSchema } from "../src/json-schema.ts"

/**
 * The generated JSON Schema and the Effect decoder must accept and reject
 * the same values. Valid values come from each schema's Arbitrary; invalid
 * candidates replace one node of a valid value, chosen uniformly among all
 * its nodes, with a boundary value or arbitrary JSON, or delete one object
 * key. ASHE_AGENT_TEST_SEED reproduces a run.
 */
declare const ASHE_AGENT_TEST_SEED: string | undefined

/** The task runner defines the seed at build time, so the test reads no process configuration. */
const seed = Number(
  typeof ASHE_AGENT_TEST_SEED === "undefined" ? Math.floor(Math.random() * 2 ** 31) : ASHE_AGENT_TEST_SEED,
)
const runs = 200

const boundaryValues: ReadonlyArray<unknown> = [0, -1, 1, 1.5, -0.5, 2 ** 53, "", " ", "x", null, true, false, [], {}, ["x"], { x: 1 }]

type Path = ReadonlyArray<string | number>

const paths = (value: unknown, prefix: Path = []): Array<Path> => {
  const own: Array<Path> = [prefix]
  if (typeof value !== "object" || value === null) return own
  const entries = Array.isArray(value) ? value.map((item, index) => [index, item] as const) : Object.entries(value)
  for (const [key, child] of entries) own.push(...paths(child, [...prefix, key]))
  return own
}

const update = (value: unknown, path: Path, change: (parent: any, key: string | number) => void): unknown => {
  if (path.length === 0) return value
  const copy: any = Array.isArray(value) ? [...(value as Array<unknown>)] : { ...(value as object) }
  const [key, ...rest] = path as [string | number, ...Array<string | number>]
  if (rest.length === 0) change(copy, key)
  else copy[key] = update(copy[key], rest, change)
  return copy
}

/** One corruption of `value`, selected by `pick` and `replacement`. */
const corrupt = (value: unknown, replacement: unknown, pick: number): unknown => {
  const all = paths(value)
  const path = all[pick % all.length]!
  const swap = (pick >> 8) % 2 === 0 ? boundaryValues[(pick >> 9) % boundaryValues.length] : replacement
  if (path.length === 0) return swap
  const removeKey = (pick >> 12) % 4 === 0 && typeof path[path.length - 1] === "string"
  return update(value, path, (parent, key) => {
    if (removeKey) delete parent[key]
    else parent[key] = swap
  })
}

const ajv = new Ajv2020({ strict: false, allErrors: false })

describe(`protocol JSON Schema and decoder agree (seed ${seed})`, () => {
  for (const [name, schema] of Object.entries(jsonSchemaRoots())) {
    const validate = ajv.compile(toJsonSchema(schema))
    const decode = Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>)
    const agree = (value: unknown) => Result.isSuccess(decode(value)) === validate(value)

    test(`${name} accepts generated values`, async () => {
      const values = Arbitrary.schema(schema as Schema.Codec<unknown, unknown>)
      const result = await Effect.runPromise(
        Arbitrary.checkEffect(values, (value) => Result.isSuccess(decode(value)) && validate(value), { runs, seed }),
      )
      expect(Arbitrary.formatCheckFailure(result) ?? "passed", `seed ${seed}`).toBe("passed")
    })

    test(`${name} rejects corrupted values the same way`, async () => {
      const candidates = Arbitrary.all([
        Arbitrary.schema(schema as Schema.Codec<unknown, unknown>),
        Arbitrary.schema(Schema.Json),
        Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 30 }))),
      ])
      const result = await Effect.runPromise(
        Arbitrary.checkEffect(candidates, ([value, replacement, pick]) => agree(corrupt(value, replacement, pick)), {
          runs: runs * 5,
          seed,
        }),
      )
      expect(Arbitrary.formatCheckFailure(result) ?? "passed", `seed ${seed}`).toBe("passed")
    })
  }
})
