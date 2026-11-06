import { createBitmapIndex, type BitmapQuery } from '@lp-labs/bitmap-index';
const index = createBitmapIndex();
index.set('row', { enabled: true });
const query: BitmapQuery = { field: 'enabled', op: 'eq', value: true };
const ids: string[] = index.query(query);
void ids;
