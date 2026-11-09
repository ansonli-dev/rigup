export const catalog = {
  archive: ['archiveProduct', `
import {findProduct} from './lookup.js';

export function archiveProduct(products, sku) {
  const current = findProduct(products, sku);
  return products.map(product => product === current ? {...product, active: false} : product);
}
`, `
  assert.deepEqual(archiveProduct([{sku: 'T-1', active: true}], 'T-1'), [{sku: 'T-1', active: false}]);
`],
  rename: ['renameProduct', `
import {DomainError} from '../error.js';

export function renameProduct(product, name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new DomainError('PRODUCT_NAME_REQUIRED', 'A product requires a name');
  }
  return {...product, name: name.trim()};
}
`, `
  assert.equal(renameProduct({sku: 'T-1', name: 'Tote'}, ' Travel tote ').name, 'Travel tote');
`],
  restore: ['restoreProduct', `
import {DomainError} from '../error.js';

export function restoreProduct(products, sku) {
  const archived = products.find(product => product.sku === sku && !product.active);
  if (!archived) throw new DomainError('ARCHIVED_SKU_NOT_FOUND', 'Archived product not found');
  return products.map(product => product === archived ? {...product, active: true} : product);
}
`, `
  assert.deepEqual(restoreProduct([{sku: 'T-1', active: false}], 'T-1'), [{sku: 'T-1', active: true}]);
`],
  tags: ['addTag', `
import {DomainError} from '../error.js';

export function addTag(product, tag) {
  if (typeof tag !== 'string' || !tag.trim()) throw new DomainError('TAG_REQUIRED', 'A tag is required');
  const normalized = tag.trim().toLowerCase();
  const tags = [...new Set([...(product.tags ?? []), normalized])];
  return {...product, tags};
}
`, `
  assert.deepEqual(addTag({sku: 'T-1', tags: ['travel']}, ' Travel ').tags, ['travel']);
`],
  categories: ['setCategory', `
import {DomainError} from '../error.js';

export function setCategory(product, categoryId) {
  if (typeof categoryId !== 'string' || !categoryId.trim()) {
    throw new DomainError('CATEGORY_REQUIRED', 'A category is required');
  }
  return {...product, categoryId};
}
`, `
  assert.equal(setCategory({sku: 'T-1'}, 'accessories').categoryId, 'accessories');
  assert.throws(() => setCategory({sku: 'T-1'}, ''), {code: 'CATEGORY_REQUIRED'});
`],
  'category-path': ['categoryPath', `
import {DomainError} from '../error.js';

export function categoryPath(categoryNames) {
  if (!Array.isArray(categoryNames) || categoryNames.some(name => typeof name !== 'string' || !name.trim())) {
    throw new DomainError('INVALID_CATEGORY_PATH', 'A category path contains named segments');
  }
  return categoryNames.map(name => name.trim()).join(' / ');
}
`, `
  assert.equal(categoryPath(['Accessories', 'Travel']), 'Accessories / Travel');
`],
  'product-url': ['productSlug', `
import {DomainError} from '../error.js';

export function productSlug(product) {
  const slug = String(product.name ?? '').toLowerCase().match(/[a-z0-9]+/g)?.join('-');
  if (!slug) throw new DomainError('INVALID_PRODUCT_SLUG', 'Product name cannot form a slug');
  return slug;
}
`, `
  assert.equal(productSlug({name: 'Travel Tote (Large)'}), 'travel-tote-large');
`],
  identifiers: ['normalizeSku', `
import {DomainError} from '../error.js';

export function normalizeSku(sku) {
  const normalized = typeof sku === 'string' ? sku.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(normalized)) {
    throw new DomainError('INVALID_SKU', 'SKU segments contain letters or digits');
  }
  return normalized;
}
`, `
  assert.equal(normalizeSku(' bag-18 '), 'BAG-18');
  assert.throws(() => normalizeSku('bag 18'), {code: 'INVALID_SKU'});
`],
  filter: ['activeProducts', `
export function activeProducts(products) {
  return products.filter(product => product.active);
}
`, `
  const items = [{sku: 'A', active: false}, {sku: 'B', active: true}];
  assert.deepEqual(activeProducts(items), [{sku: 'B', active: true}]);
`],
  search: ['searchProducts', `
import {DomainError} from '../error.js';
import {activeProducts} from './filter.js';

export function searchProducts(products, query) {
  if (typeof query !== 'string') throw new DomainError('INVALID_SEARCH', 'Product search requires text');
  const normalized = query.trim().toLowerCase();
  return activeProducts(products).filter(product => product.name.toLowerCase().includes(normalized));
}
`, `
  const product = {sku: 'T-1', name: 'Travel Tote', active: true};
  assert.deepEqual(searchProducts([product, {...product, active: false}], ' TOTE '), [product]);
`],
  images: ['setCoverImage', `
import {DomainError} from '../error.js';

export function setCoverImage(product, address) {
  const url = URL.parse(address);
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    throw new DomainError('INVALID_IMAGE_URL', 'Cover images require an HTTP URL');
  }
  return {...product, coverImage: url.href};
}
`, `
  assert.equal(setCoverImage({sku: 'T-1'}, 'https://images.example/tote.png').coverImage, 'https://images.example/tote.png');
  assert.throws(() => setCoverImage({sku: 'T-1'}, 'file:///tote.png'), {code: 'INVALID_IMAGE_URL'});
`],
  attributes: ['setProductAttribute', `
import {DomainError} from '../error.js';

export function setProductAttribute(product, key, value) {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9-]*$/.test(key) || typeof value !== 'string') {
    throw new DomainError('INVALID_ATTRIBUTE', 'Attributes require a lowercase key and text value');
  }
  return {...product, attributes: {...product.attributes, [key]: value}};
}
`, `
  const product = {sku: 'T-1', attributes: {color: 'gray'}};
  assert.deepEqual(setProductAttribute(product, 'material', 'canvas').attributes, {color: 'gray', material: 'canvas'});
`],
  dimensions: ['setPackageDimensions', `
import {DomainError} from '../error.js';

export function setPackageDimensions(product, {lengthCm, widthCm, heightCm}) {
  if ([lengthCm, widthCm, heightCm].some(value => !Number.isFinite(value) || value <= 0)) {
    throw new DomainError('INVALID_DIMENSIONS', 'Package dimensions must be positive');
  }
  return {...product, dimensions: {lengthCm, widthCm, heightCm}};
}
`, `
  const dimensions = {lengthCm: 30, widthCm: 25, heightCm: 7};
  assert.deepEqual(setPackageDimensions({sku: 'T-1'}, dimensions).dimensions, dimensions);
`],
  bundles: ['setBundleItems', `
import {DomainError} from '../error.js';
import {normalizeSku} from './identifiers.js';

export function setBundleItems(product, skus) {
  if (!Array.isArray(skus) || skus.length < 2) {
    throw new DomainError('INVALID_BUNDLE', 'A bundle requires at least two items');
  }
  const bundleItems = skus.map(normalizeSku);
  if (new Set(bundleItems).size !== bundleItems.length || bundleItems.includes(product.sku)) {
    throw new DomainError('INVALID_BUNDLE', 'Bundle items must be distinct and cannot include the bundle');
  }
  return {...product, bundleItems};
}
`, `
  assert.deepEqual(setBundleItems({sku: 'PACK'}, [' tote-1 ', 'wallet-2']).bundleItems, ['TOTE-1', 'WALLET-2']);
  assert.throws(() => setBundleItems({sku: 'PACK'}, ['wallet-2', 'WALLET-2']), {code: 'INVALID_BUNDLE'});
`],
  sort: ['sortProductsByName', `
export function sortProductsByName(products) {
  return [...products].sort((left, right) => left.name.localeCompare(right.name));
}
`, `
  const products = [{name: 'Wallet'}, {name: 'Tote'}];
  assert.deepEqual(sortProductsByName(products), [{name: 'Tote'}, {name: 'Wallet'}]);
  assert.equal(products[0].name, 'Wallet');
`],
};
