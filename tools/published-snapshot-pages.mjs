const PAGE_SIZE = 100;
const GENERATION_ID = /^[a-f0-9]{64}$/i;
const ACCOUNT_ID = /^[a-f0-9]{64}$/i;

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSourceRevision(value) {
  return typeof value === 'string'
    ? value.length > 0 && value.length <= 256
    : Number.isSafeInteger(value) && value >= 0;
}

function rowAccountId(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('Invalid published snapshot row');
  }
  const hasAccountId = Object.hasOwn(row, 'accountId') && row.accountId !== null;
  const hasUserId = Object.hasOwn(row, 'userId') && row.userId !== null;
  if ((hasAccountId && !ACCOUNT_ID.test(row.accountId)) || (hasUserId && !ACCOUNT_ID.test(row.userId))) {
    throw new TypeError('Invalid published snapshot account identity');
  }
  if (hasAccountId && hasUserId && row.accountId.toLowerCase() !== row.userId.toLowerCase()) {
    throw new TypeError('Mismatched published snapshot account identity');
  }
  const id = hasAccountId ? row.accountId : hasUserId ? row.userId : null;
  if (!id) throw new TypeError('Missing published snapshot account identity');
  return id.toLowerCase();
}

function validatePagination(pagination, maxPages) {
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination) ||
      pagination.version !== 1 || !GENERATION_ID.test(pagination.generation || '') ||
      pagination.pageSize !== PAGE_SIZE || !nonnegativeInteger(pagination.pageCount) ||
      !nonnegativeInteger(pagination.totalEntries) || pagination.complete !== true ||
      pagination.pageCount !== Math.ceil(pagination.totalEntries / PAGE_SIZE)) {
    throw new TypeError('Invalid published snapshot pagination metadata');
  }
  if (!nonnegativeInteger(maxPages) || maxPages < 1) throw new RangeError('Invalid published snapshot page budget');
  if (pagination.pageCount > maxPages) throw new RangeError('Published snapshot exceeds page budget');
  return pagination;
}

/** Replace a legacy preview with validated pages from its immutable generation. */
export async function assemblePublishedSnapshotPages(value, {
  fetchPage,
  onRequest,
  maxPages = 100,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'pagination')) return value;
  if (!Array.isArray(value.entries)) throw new TypeError('Invalid published snapshot preview');

  const pagination = validatePagination(value.pagination, maxPages);
  if ((Object.hasOwn(value, 'generation') && value.generation !== pagination.generation) ||
      (Object.hasOwn(value, 'totalEntries') && value.totalEntries !== pagination.totalEntries) ||
      (Object.hasOwn(value, 'sourceRevision') && !validSourceRevision(value.sourceRevision))) {
    throw new Error('Published snapshot preview metadata mismatch');
  }
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage callback is required for paginated snapshots');

  const entries = [];
  const identities = new Set();
  let sourceRevision;
  let sourceCoverage = typeof value.sourceComplete === 'boolean' ? value.sourceComplete : undefined;
  for (let page = 0; page < pagination.pageCount; page++) {
    onRequest?.(page, pagination.generation);
    const result = await fetchPage(page, pagination.generation);
    const expectedLength = Math.min(PAGE_SIZE, pagination.totalEntries - page * PAGE_SIZE);
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        result.generation !== pagination.generation || result.page !== page ||
        result.pageSize !== PAGE_SIZE || result.pageCount !== pagination.pageCount ||
        result.totalEntries !== pagination.totalEntries || result.complete !== true ||
        !Array.isArray(result.entries) || result.entries.length !== expectedLength ||
        !Object.hasOwn(result, 'sourceRevision') || !validSourceRevision(result.sourceRevision)) {
      throw new Error(`Invalid or incomplete published snapshot page ${page}`);
    }
    if (sourceRevision === undefined) {
      sourceRevision = result.sourceRevision;
      if (Object.hasOwn(value, 'sourceRevision') && value.sourceRevision !== sourceRevision) {
        throw new Error('Published snapshot source revision mismatch');
      }
    } else if (result.sourceRevision !== sourceRevision) {
      throw new Error('Published snapshot pages have mixed source revisions');
    }

    if (Object.hasOwn(result, 'sourceComplete')) {
      if (typeof result.sourceComplete !== 'boolean' || sourceCoverage !== undefined && result.sourceComplete !== sourceCoverage) {
        throw new Error('Published snapshot pages have conflicting source coverage');
      }
      sourceCoverage = result.sourceComplete;
    }

    for (const row of result.entries) {
      const id = rowAccountId(row);
      if (identities.has(id)) throw new Error('Duplicate published snapshot account identity');
      identities.add(id);
      entries.push(row);
    }
  }

  if (entries.length !== pagination.totalEntries) throw new Error('Published snapshot is incomplete');
  const sourceComplete = sourceCoverage !== false;
  return {
    ...value,
    pagination: {
      version: pagination.version,
      generation: pagination.generation,
      pageSize: pagination.pageSize,
      pageCount: pagination.pageCount,
      totalEntries: pagination.totalEntries,
      complete: pagination.complete,
    },
    entries,
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    sourceComplete,
    complete: sourceComplete,
    totalEntries: pagination.totalEntries,
    paginatedSource: true,
  };
}
