export type BitmapScalar = string | number | boolean;

export interface BitmapIndexOptions {
  maxRows?: number;
  maxValuesPerField?: number;
  maxFields?: number;
  maxBitmapBytes?: number;
}

export type BitmapQuery =
  | { field: string; op: 'eq'; value: BitmapScalar }
  | { field: string; op: 'in'; values: readonly BitmapScalar[] }
  | { field: string; op: 'not'; value: BitmapScalar };

export interface BitmapIndex {
  readonly size: number;
  set(id: string, fields: Readonly<Record<string, BitmapScalar>>): void;
  remove(id: string): boolean;
  query(query: BitmapQuery): string[];
  clear(): void;
}

export class BitmapIndexError extends Error {
  constructor(
    readonly code: 'capacity' | 'unknown-field',
    message: string,
  ) {
    super(message);
    this.name = 'BitmapIndexError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function assertPlainObject(value: unknown, name: string): void {
  if (!isRecord(value)) throw new TypeError(`${name} must be a plain object.`);
}

function scalar(value: unknown): value is BitmapScalar {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function encode(value: BitmapScalar): string {
  return `${typeof value}:${String(value)}`;
}

function bounded(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

interface Row {
  slot: number;
  values: Map<string, BitmapScalar>;
}

interface Bitmap {
  bits: Uint32Array;
  rows: number;
}

export function createBitmapIndex(options: BitmapIndexOptions = {}): BitmapIndex {
  assertPlainObject(options, 'Options');
  const maxRows = bounded(options.maxRows ?? 100_000, 'maxRows', 1_000_000);
  const maxValues = bounded(options.maxValuesPerField ?? 10_000, 'maxValuesPerField', 100_000);
  const maxFields = bounded(options.maxFields ?? 64, 'maxFields', 256);
  const maxBitmapBytes = bounded(
    options.maxBitmapBytes ?? 64 * 1024 * 1024,
    'maxBitmapBytes',
    512 * 1024 * 1024,
  );
  const wordCount = Math.ceil(maxRows / 32);
  const bitmapBytes = wordCount * Uint32Array.BYTES_PER_ELEMENT;
  const rows = new Map<string, Row>();
  const slotIds: (string | undefined)[] = new Array(maxRows);
  const freeSlots: number[] = [];
  const fields = new Map<string, Map<string, Bitmap>>();
  let nextSlot = 0;
  let allocatedBytes = 0;

  function validateId(id: unknown): asserts id is string {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
      throw new TypeError('Row id must be a non-empty string of at most 256 characters.');
    }
  }
  const attach = (field: string, value: BitmapScalar, slot: number) => {
    let values = fields.get(field);
    if (!values) fields.set(field, (values = new Map()));
    const key = encode(value);
    let bitmap = values.get(key);
    if (!bitmap) {
      bitmap = { bits: new Uint32Array(wordCount), rows: 0 };
      values.set(key, bitmap);
      allocatedBytes += bitmapBytes;
    }
    const word = slot >>> 5;
    const mask = 1 << (slot & 31);
    if ((bitmap.bits[word]! & mask) === 0) {
      bitmap.bits[word] = bitmap.bits[word]! | mask;
      bitmap.rows++;
    }
  };
  const detach = (field: string, value: BitmapScalar, slot: number) => {
    const values = fields.get(field)!;
    const key = encode(value);
    const bitmap = values.get(key)!;
    const word = slot >>> 5;
    const mask = 1 << (slot & 31);
    bitmap.bits[word] = bitmap.bits[word]! & ~mask;
    bitmap.rows--;
    if (bitmap.rows === 0) {
      values.delete(key);
      allocatedBytes -= bitmapBytes;
    }
    if (values.size === 0) fields.delete(field);
  };
  const readIds = (bits: Uint32Array, field: string): string[] => {
    const result: string[] = [];
    for (let wordIndex = 0; wordIndex < bits.length; wordIndex++) {
      let word = bits[wordIndex]!;
      while (word !== 0) {
        const leastBit = 31 - Math.clz32(word & -word);
        const slot = wordIndex * 32 + leastBit;
        const id = slotIds[slot];
        if (id !== undefined && rows.get(id)?.values.has(field)) result.push(id);
        word &= word - 1;
      }
    }
    return result.sort((a, b) => a.localeCompare(b, 'en'));
  };

  return {
    get size() {
      return rows.size;
    },
    set(id, input) {
      validateId(id);
      assertPlainObject(input, 'Fields');
      const keys = Reflect.ownKeys(input);
      if (keys.length > maxFields)
        throw new BitmapIndexError('capacity', `At most ${maxFields} fields are allowed.`);
      const values = new Map<string, BitmapScalar>();
      for (const key of keys) {
        if (typeof key !== 'string' || key.length === 0 || key.length > 128) {
          throw new TypeError('Field names must be non-empty strings of at most 128 characters.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!descriptor.enumerable || !('value' in descriptor) || !scalar(descriptor.value)) {
          throw new TypeError('Field values must be enumerable finite scalar properties.');
        }
        values.set(key, descriptor.value);
      }
      const existing = rows.get(id);
      if (!existing && rows.size >= maxRows)
        throw new BitmapIndexError('capacity', 'Row capacity reached.');
      const nextFieldNames = new Set(fields.keys());
      if (existing) {
        for (const [field, categories] of fields) {
          const previous = existing.values.get(field);
          let remains = false;
          for (const [key, bitmap] of categories) {
            const removed =
              previous !== undefined &&
              key === encode(previous) &&
              bitmap.rows === 1 &&
              (!values.has(field) || encode(values.get(field)!) !== key);
            if (!removed) {
              remains = true;
              break;
            }
          }
          if (!remains) nextFieldNames.delete(field);
        }
      }
      for (const field of values.keys()) nextFieldNames.add(field);
      if (nextFieldNames.size > maxFields)
        throw new BitmapIndexError('capacity', 'Field capacity reached.');
      const newValues = new Map<string, Set<string>>();
      for (const [field, value] of values) {
        const available = fields.get(field);
        const distinct = new Set(available?.keys() ?? []);
        const old = existing?.values.get(field);
        if (
          old !== undefined &&
          encode(old) !== encode(value) &&
          available?.get(encode(old))?.rows === 1
        ) {
          distinct.delete(encode(old));
        }
        distinct.add(encode(value));
        if (distinct.size > maxValues)
          throw new BitmapIndexError('capacity', `Value capacity reached for ${field}.`);
        if (!available?.has(encode(value))) {
          const set = newValues.get(field) ?? new Set<string>();
          set.add(encode(value));
          newValues.set(field, set);
        }
      }
      const removedBitmaps = existing
        ? [...existing.values]
            .filter(([field, value]) => {
              const replacement = values.get(field);
              return replacement === undefined || encode(replacement) !== encode(value);
            })
            .filter(([field, value]) => fields.get(field)?.get(encode(value))?.rows === 1).length
        : 0;
      const addedBitmaps = [...newValues.values()].reduce((total, set) => total + set.size, 0);
      if (allocatedBytes + (addedBitmaps - removedBitmaps) * bitmapBytes > maxBitmapBytes) {
        throw new BitmapIndexError('capacity', 'Bitmap memory capacity reached.');
      }
      let slot = existing?.slot;
      if (slot === undefined) {
        slot = freeSlots.pop() ?? nextSlot++;
      }
      if (existing) {
        for (const [field, value] of existing.values) {
          if (values.has(field) && encode(values.get(field)!) === encode(value)) continue;
          detach(field, value, slot);
        }
      }
      rows.set(id, { slot, values });
      slotIds[slot] = id;
      for (const [field, value] of values) {
        if (existing?.values.has(field) && encode(existing.values.get(field)!) === encode(value))
          continue;
        attach(field, value, slot);
      }
    },
    remove(id) {
      validateId(id);
      const row = rows.get(id);
      if (!row) return false;
      for (const [field, value] of row.values) detach(field, value, row.slot);
      rows.delete(id);
      slotIds[row.slot] = undefined;
      freeSlots.push(row.slot);
      return true;
    },
    query(input) {
      if (!isRecord(input) || typeof input.field !== 'string' || input.field.length === 0) {
        throw new TypeError('Query requires a field name.');
      }
      const field = fields.get(input.field);
      if (!field)
        throw new BitmapIndexError('unknown-field', `Unknown or empty field: ${input.field}`);
      const result = new Uint32Array(wordCount);
      const merge = (bitmap: Bitmap | undefined, operation: 'or' | 'and' = 'or') => {
        for (let index = 0; index < result.length; index++) {
          result[index] =
            operation === 'or'
              ? result[index]! | (bitmap?.bits[index] ?? 0)
              : result[index]! & (bitmap?.bits[index] ?? 0);
        }
      };
      if (input.op === 'eq' || input.op === 'not') {
        if (!scalar(input.value)) throw new TypeError('Query value must be a finite scalar.');
        const matching = field.get(encode(input.value));
        if (input.op === 'eq') merge(matching);
        else {
          for (const row of rows.values()) {
            if (
              !row.values.has(input.field) ||
              (matching?.rows && matching.bits[row.slot >>> 5]! & (1 << (row.slot & 31)))
            ) {
              continue;
            }
            result[row.slot >>> 5] = result[row.slot >>> 5]! | (1 << (row.slot & 31));
          }
        }
      } else if (input.op === 'in') {
        if (
          !Array.isArray(input.values) ||
          input.values.length === 0 ||
          input.values.length > maxValues
        ) {
          throw new RangeError(`in query requires 1..${maxValues} values.`);
        }
        for (const value of input.values) {
          if (!scalar(value)) throw new TypeError('Query values must be finite scalars.');
          merge(field.get(encode(value)));
        }
      } else {
        throw new TypeError('Unsupported bitmap query.');
      }
      return readIds(result, input.field);
    },
    clear() {
      rows.clear();
      fields.clear();
      slotIds.fill(undefined);
      freeSlots.length = 0;
      nextSlot = 0;
      allocatedBytes = 0;
    },
  };
}
