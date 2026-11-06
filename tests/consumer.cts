import { createBitmapIndex } from '@lp-labs/bitmap-index';
const index = createBitmapIndex();
index.set('row', { category: 'a' });
const size: number = index.size;
void size;
