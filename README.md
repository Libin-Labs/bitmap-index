# @lp-labs/bitmap-index

A bounded in-memory bitmap-backed index for categorical rows. Use it to filter compact,
column-like datasets by exact values, sets of values, and their complement.

## Install

```bash
npm install @lp-labs/bitmap-index
```

The package ships ES2022 ESM and CommonJS builds and TypeScript declarations. CommonJS:
`const { createBitmapIndex } = require('@lp-labs/bitmap-index')`.

## Quickstart

```js
import { createBitmapIndex } from '@lp-labs/bitmap-index';

const index = createBitmapIndex();
index.set('row-1', { status: 'ready', region: 'west' });
index.set('row-2', { status: 'queued', region: 'west' });
console.log(index.query({ field: 'status', op: 'eq', value: 'ready' })); // ['row-1']
console.log(index.query({ field: 'region', op: 'in', values: ['west', 'east'] }));
```

## API

- `createBitmapIndex({ maxRows?, maxFields?, maxValuesPerField? })` creates a fixed-capacity
  bitset index. Defaults: 100,000 rows, 64 active fields, and 10,000 distinct values per field.
- `set(id, fields)` inserts or atomically replaces a row. IDs are unique strings up to 256
  characters; values are strings, finite numbers, or booleans. Each row may omit fields.
- `remove(id)` returns whether the row existed. `query({ field, op, value })` supports `eq`,
  `not` (complement among rows that contain that field), and `in` (union of exact matches).
- `clear()` resets all rows. `size` reports indexed rows.

Results are sorted by ID for repeatable output. Rows and values are copied at insertion. A
capacity overrun throws `BitmapIndexError` with code `capacity`; missing fields throw
`BitmapIndexError` with code `unknown-field`; malformed values are rejected before mutation.

## Customization and limitations

Tune capacities for the workload; `maxRows` is capped at 1,000,000, `maxFields` at 256, and
`maxValuesPerField` at 100,000. Bitmaps are allocated per distinct field/value pair and share a
fixed row-slot space. This is not a general database, range index, null-aware SQL engine,
persistent store, or compressed Roaring implementation. Querying requires an existing field;
`not` excludes rows with a missing field. JavaScript numbers use ordinary floating-point
equality. Keep row and category cardinality bounded to control memory.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
