import { Operation, compare, applyPatch } from 'fast-json-patch'
import { LensSource, LensOp } from './lens-ops'
import { reverseLens } from './reverse'
import { addDefaultValues, defaultObjectForSchema } from './defaults'
import { JSONSchema7 } from 'json-schema'
import { updateSchema } from './json-schema'
import GenerateSchema from 'generate-schema'
import { inspect } from 'util'

// todo: we're throwing away the type param right now so it doesn't actually do anything.
// can we actually find a way to keep it around and typecheck patches against a type?
export type PatchOp = Operation
type MaybePatchOp = PatchOp | null
export type Patch = Operation[]
export type CompiledLens = (patch: Patch, targetDoc: any) => Patch

function assertNever(x: never): never {
  throw new Error(`Unexpected object: ${x}`)
}

function noNulls<T>(items: (T | null)[]) {
  return items.filter((x): x is T => x !== null)
}

// Provide curried functions that incorporate the lenses internally;
// this is useful for exposing a pre-baked converter function to developers
// without them needing to access the lens themselves
// TODO: the public interface could just be runLens and reverseLens
// ... maybe also composeLens?
export function compile(lensSource: LensSource): { right: CompiledLens; left: CompiledLens } {
  return {
    right: (patch: Patch, targetDoc: any) => applyLensToPatch(lensSource, patch, targetDoc),
    left: (patch: Patch, targetDoc: any) =>
      applyLensToPatch(reverseLens(lensSource), patch, targetDoc),
  }
}

// generate an inferred JSON Schema for a document
function generateSchema(doc): JSONSchema7 {
  return GenerateSchema.json(doc)
}

// utility function: converts a document (rather than a patch) through a lens
export function applyLensToDoc(
  lensSource: LensSource,
  inputDoc: any,
  inputSchema?: JSONSchema7,
  targetDoc?: any
) {
  // build up a patch that creates the document
  const patchForOriginalDoc = compare({}, inputDoc)

  if (inputSchema === undefined || inputSchema === null) {
    inputSchema = generateSchema(inputDoc)
  }

  // convert the patch through the lens
  const outputPatch = applyLensToPatch(lensSource, patchForOriginalDoc, inputSchema)
  const outputSchema = updateSchema(inputSchema, lensSource)

  // construct the "base" upon which we will apply the patches from doc.
  // We start with the default object for the output schema,
  // then we add in any existing fields on the target doc.
  // TODO: I think we need to deep merge here, can't just shallow merge?
  const base = Object.assign(defaultObjectForSchema(outputSchema), targetDoc || {})

  // return a doc based on the converted patch.
  // (start with either a specified baseDoc, or just empty doc)
  return applyPatch(base, outputPatch).newDocument
}

// given a patch, returns a new patch that has had the lens applied to it.
export function applyLensToPatch(
  lensSource: LensSource,
  patch: Patch,
  patchSchema: JSONSchema7 // the json schema for the doc the patch was operating on
): Patch {
  // expand patches that set nested objects into scalar patches
  const expandedPatch: Patch = patch.map((op) => expandPatch(op)).flat()

  // send everything through the lens
  const lensedPatch = noNulls<PatchOp>(
    expandedPatch.map((patchOp) => applyLensToPatchOp(lensSource, patchOp))
  )

  // add in default values needed (based on the new schema after lensing)
  const readerSchema = updateSchema(patchSchema, lensSource)
  const lensedPatchWithDefaults = addDefaultValues(lensedPatch, readerSchema)

  return lensedPatchWithDefaults
}

// todo: remove destinationDoc entirely
export function applyLensToPatchOp(lensSource: LensSource, patchOp: MaybePatchOp): MaybePatchOp {
  return lensSource.reduce<MaybePatchOp>((prevPatch: MaybePatchOp, lensOp: LensOp) => {
    return runLensOp(lensOp, prevPatch)
  }, patchOp)
}

function runLensOp(lensOp: LensOp, patchOp: MaybePatchOp): MaybePatchOp {
  if (patchOp === null) {
    return null
  }

  switch (lensOp.op) {
    case 'rename':
      if (
        // TODO: what about other JSON patch op types?
        // (consider other parts of JSON patch: move / copy / test / remove ?)
        (patchOp.op === 'replace' || patchOp.op === 'add') &&
        patchOp.path.split('/')[1] === lensOp.source
      ) {
        const path = patchOp.path.replace(lensOp.source, lensOp.destination)
        return { ...patchOp, path }
      }

      break

    case 'hoist': {
      // leading slash needs trimming
      const pathElements = patchOp.path.substr(1).split('/')
      const [possibleSource, possibleDestination, ...rest] = pathElements
      if (possibleSource === lensOp.host && possibleDestination === lensOp.name) {
        const path = ['', lensOp.name, ...rest].join('/')
        return { ...patchOp, path }
      }
      break
    }

    case 'plunge': {
      const pathElements = patchOp.path.substr(1).split('/')
      const [head] = pathElements
      if (head === lensOp.name) {
        const path = ['', lensOp.host, pathElements].join('/')
        return { ...patchOp, path }
      }
      break
    }

    case 'wrap': {
      const pathComponent = new RegExp(`^/(${lensOp.name})(.*)`)
      const match = patchOp.path.match(pathComponent)
      if (match) {
        const path = `/${match[1]}/0${match[2]}`
        if ((patchOp.op === "add" || patchOp.op === "replace") && patchOp.value === null && match[2] === "") {
           return { op: "remove", path }
        }
        return { ... patchOp, path } 
      }
      break
    }

    case 'head': {
      // break early if we're not handling a write to the array handled by this lens
      const arrayMatch = patchOp.path.split('/')[1] === lensOp.name
      if (!arrayMatch) break

      // We only care about writes to the head element, nothing else matters
      const headMatch = patchOp.path.match(new RegExp(`^/${lensOp.name}/0(.*)`))
      if (!headMatch) return null

      if (patchOp.op === 'add' || patchOp.op === 'replace') {
        // If the write is to the first array element, write to the scalar
        return {
          op: patchOp.op,
          path: `/${lensOp.name}${headMatch[1] || ''}`,
          value: patchOp.value,
        }
      }

      if (patchOp.op === 'remove') {
        if (headMatch[1] === "") {
          return {
            op: 'replace' as const,
            path: `/${lensOp.name}${headMatch[1] || ''}`,
            value: null,
          }
        } else {
          return { ... patchOp, path: `/${lensOp.name}${headMatch[1] || ''}` }
        }
      }

      break
    }

    case 'add':
      // hmm, what do we do here? perhaps write the default value if there's nothing
      // already written into the doc there?
      // (could be a good use case for destinationDoc)
      break

    case 'remove':
      if (patchOp.path.split('/')[1] === lensOp.name) return null
      break

    case 'in': {
      // Run the inner body in a context where the path has been narrowed down...
      const pathComponent = new RegExp(`^/${lensOp.name}`)
      if (patchOp.path.match(pathComponent)) {
        const childPatch = applyLensToPatchOp(lensOp.lens, {
          ...patchOp,
          path: patchOp.path.replace(pathComponent, ''),
        })

        if (childPatch) {
          return { ...childPatch, path: `/${lensOp.name}${childPatch.path}` }
        }
      }
      break
    }

    case 'map': {
      const arrayIndexMatch = patchOp.path.match(/\/([0-9]+)\//)
      if (!arrayIndexMatch) break
      const arrayIndex = arrayIndexMatch[1]
      const itemPatch = applyLensToPatchOp(
        lensOp.lens,
        { ...patchOp, path: patchOp.path.replace(/\/[0-9]+\//, '/') }
        // Then add the parent path back to the beginning of the results
      )

      if (itemPatch) {
        return { ...itemPatch, path: `/${arrayIndex}${itemPatch.path}` }
      }
      break
    }

    case 'convert': {
      if (patchOp.op !== 'add' && patchOp.op !== 'replace') break
      if (`/${lensOp.name}` !== patchOp.path) break
      const stringifiedValue = String(patchOp.value)

      // todo: should we add in support for fallback/default conversions
      if (!Object.keys(lensOp.mapping[0]).includes(stringifiedValue)) {
        throw new Error(`No mapping for value: ${stringifiedValue}`)
      }

      return { ...patchOp, value: lensOp.mapping[0][stringifiedValue] }
    }

    default:
      assertNever(lensOp) // exhaustiveness check
  }

  return patchOp
}

export function expandPatch(patchOp: PatchOp) {
  // this only applies for add and replace ops; no expansion to do otherwise
  // todo: check the whole list of json patch verbs
  if (patchOp.op !== 'add' && patchOp.op !== 'replace') return [patchOp]

  if (patchOp.value && typeof patchOp.value === 'object') {
    let result: any[] = [
      {
        op: patchOp.op,
        path: patchOp.path,
        value: Array.isArray(patchOp.value) ? [] : {},
      },
    ]

    result = result.concat(
      Object.entries(patchOp.value).map(([key, value]) => {
        return expandPatch({
          op: patchOp.op,
          path: `${patchOp.path}/${key}`,
          value,
        })
      })
    )

    return result.flat(Infinity)
  }
  return [patchOp]
}
