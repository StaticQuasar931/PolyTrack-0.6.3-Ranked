// Firestore REST adapter. Uses the parent's authenticated request function;
// never reads credentials and never falls back to nontransactional writes.
import { EVENT_SERVER_TIMESTAMP, EventError } from './events.js';

export function eventEncode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw Error('Invalid Firestore number');
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(eventEncode) } };
  if (value && typeof value.__firestoreTimestamp === 'string') return { timestampValue: value.__firestoreTimestamp };
  if (value && typeof value === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, eventEncode(v)])) } };
  throw Error('Unsupported Firestore value');
}
export function eventDecode(value) {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) { const number = Number(value.integerValue); if (!Number.isSafeInteger(number)) throw Error('Unsafe Firestore integer'); return number; }
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return { __firestoreTimestamp: value.timestampValue };
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(eventDecode);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, eventDecode(v)]));
  throw Error('Unsupported Firestore field');
}
function checkedPath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_-]{1,256}$/.test(value)) throw Error('Invalid event document path');
  return value;
}
function conflict(error) { return ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(error.code) ||
  [409, 412].includes(error.status) || /^FIRESTORE_(409|412)$/.test(error.message); }

/** request(path, init) has the same shape as index.js firestoreRequest with env bound.
 * Begin/read/commit share a transaction ID. Server snapshots are not CAS guesses.
 */
export function createEventFirestoreStore({ request, projectId, retries = 2, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (typeof request !== 'function' || !/^[a-z][a-z0-9-]{4,62}$/.test(projectId) || !Number.isInteger(retries) || retries < 0 || retries > 2) throw Error('Invalid event Firestore adapter');
  const base = `projects/${projectId}/databases/(default)/documents/`;
  const post = (route, body) => request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return Object.freeze({
    async transaction(fn) {
      for (let attempt = 0; ; attempt++) {
        const begun = await post(':beginTransaction', { options: { readWrite: {} } });
        const transaction = begun?.transaction;
        if (typeof transaction !== 'string' || !transaction) throw Error('Missing Firestore transaction');
        const reads = new Map(), writes = new Map(); let writing = false;
        const get = async documentPath => {
          checkedPath(documentPath);
          if (writing) throw Error('Event transaction read after write');
          if (reads.has(documentPath)) return structuredClone(reads.get(documentPath).data);
          if (reads.size >= 16) throw Error('Event transaction read budget');
          const document = await request('/' + documentPath.split('/').map(encodeURIComponent).join('/') + '?transaction=' + encodeURIComponent(transaction));
          const data = document ? eventDecode({ mapValue: { fields: document.fields || {} } }) : null;
          reads.set(documentPath, { data, updateTime: document?.updateTime }); return structuredClone(data);
        };
        const write = (documentPath, data, mode) => {
          checkedPath(documentPath); writing = true;
          if (!reads.has(documentPath) && mode !== 'create') throw Error('Event write requires prior read');
          if (writes.has(documentPath) || writes.size >= 16) throw Error('Event transaction write budget');
          if (mode === 'create' && reads.get(documentPath)?.data) throw new EventError('document_exists', 409);
          const currentDocument = mode === 'create' || !reads.get(documentPath)?.data ? { exists: false } :
            { updateTime: reads.get(documentPath).updateTime };
          if (mode === 'delete') { writes.set(documentPath, { delete: base + documentPath, currentDocument }); return; }
          const fields = {}, transforms = [];
          for (const [name, value] of Object.entries(data)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw Error('Invalid event field name');
            if (value === EVENT_SERVER_TIMESTAMP || value?.__eventServerTimestamp === true) transforms.push({ fieldPath: name, setToServerValue: 'REQUEST_TIME' });
            else fields[name] = eventEncode(value);
          }
          const output = { update: { name: base + documentPath, fields }, currentDocument };
          if (mode === 'patch') output.updateMask = { fieldPaths: Object.keys(fields) };
          if (transforms.length) output.updateTransforms = transforms;
          if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 800000) throw Error('Event document budget');
          writes.set(documentPath, output);
        };
        try {
          const result = await fn({ get, create: (p, d) => write(p, d, 'create'), set: (p, d) => write(p, d, 'set'),
            patch: (p, d) => write(p, d, 'patch'), delete: p => write(p, null, 'delete') });
          await post(':commit', { transaction, writes: [...writes.values()] });
          return result;
        } catch (error) {
          await post(':rollback', { transaction }).catch(() => {});
          if (!conflict(error) || attempt >= retries) throw error;
          await pause(25 * (attempt + 1));
        }
      }
    }
  });
}
