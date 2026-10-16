"use strict";

// In-memory stand-in for the subset of the Admin Firestore API the iOS push store uses.
// It enforces the rules that matter for correctness: transactions are serialized, every
// transactional read must precede the first write, `update` fails on missing documents, and
// range filters only match values of the same type (so null fields drop out, as in Firestore).

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class DocumentSnapshot {
  constructor(db, path) {
    this.ref = new DocumentReference(db, path);
    this.id = this.ref.id;
    this.exists = db.documents.has(path);
    this._data = clone(db.documents.get(path));
  }

  data() {
    return clone(this._data);
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }
}

class DocumentReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split("/").at(-1);
  }

  collection(name) {
    return new CollectionReference(this.db, `${this.path}/${name}`);
  }

  async get() {
    this.db.reads += 1;
    return new DocumentSnapshot(this.db, this.path);
  }

  async create(value) {
    if (this.db.documents.has(this.path)) {
      const error = new Error("document already exists");
      error.code = 6;
      throw error;
    }
    this.db.write(this.path, clone(value));
  }

  async set(value) {
    this.db.write(this.path, clone(value));
  }

  async update(value) {
    const current = this.db.documents.get(this.path);
    if (!current) {
      const error = new Error(`no document to update: ${this.path}`);
      error.code = 5;
      throw error;
    }
    this.db.write(this.path, { ...current, ...clone(value) });
  }

  async delete() {
    this.db.documents.delete(this.path);
    this.db.writes += 1;
  }
}

function compare(actual, operator, expected) {
  if (operator === "==") {
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    return actual === expected;
  }
  const sameType = expected instanceof Date
    ? actual instanceof Date
    : typeof actual === typeof expected && actual !== null;
  if (!sameType) return false;
  const left = actual instanceof Date ? actual.getTime() : actual;
  const right = expected instanceof Date ? expected.getTime() : expected;
  if (operator === "<=") return left <= right;
  if (operator === "<") return left < right;
  if (operator === ">=") return left >= right;
  if (operator === ">") return left > right;
  throw new Error(`unsupported operator ${operator}`);
}

class Query {
  constructor(db, path, { filters = [], order = null, maximum = null } = {}) {
    this.db = db;
    this.path = path;
    this.filters = filters;
    this.order = order;
    this.maximum = maximum;
  }

  where(field, operator, value) {
    return new Query(this.db, this.path, { ...this, filters: [...this.filters, { field, operator, value }] });
  }

  orderBy(field) {
    return new Query(this.db, this.path, { ...this, order: field });
  }

  limit(maximum) {
    return new Query(this.db, this.path, { ...this, maximum });
  }

  doc(id) {
    return new DocumentReference(this.db, `${this.path}/${id}`);
  }

  async get() {
    const depth = this.path.split("/").length + 1;
    let matches = [];
    for (const [path, value] of this.db.documents) {
      if (!path.startsWith(`${this.path}/`) || path.split("/").length !== depth) continue;
      if (this.filters.every(({ field, operator, value: expected }) => compare(value[field], operator, expected))) {
        matches.push([path, value]);
      }
    }
    if (this.order) {
      matches = matches.filter(([, value]) => value[this.order] !== undefined && value[this.order] !== null);
      matches.sort(([, left], [, right]) => left[this.order] - right[this.order]);
    }
    if (this.maximum !== null) matches = matches.slice(0, this.maximum);
    this.db.reads += Math.max(matches.length, 1);
    return new QuerySnapshot(matches.map(([path]) => new DocumentSnapshot(this.db, path)));
  }
}

class CollectionReference extends Query {}

class Transaction {
  constructor() {
    this.pending = [];
  }

  async get(refOrQuery) {
    if (this.pending.length > 0) throw new Error("Firestore transactions require all reads before writes");
    return refOrQuery.get();
  }

  set(ref, value) { this.pending.push(() => ref.set(value)); }
  update(ref, value) { this.pending.push(() => ref.update(value)); }
  delete(ref) { this.pending.push(() => ref.delete()); }

  async commit() {
    for (const write of this.pending) await write();
  }
}

class WriteBatch {
  constructor() {
    this.pending = [];
  }

  delete(ref) { this.pending.push(() => ref.delete()); }
  set(ref, value) { this.pending.push(() => ref.set(value)); }
  update(ref, value) { this.pending.push(() => ref.update(value)); }

  async commit() {
    for (const write of this.pending) await write();
  }
}

class FakeFirestore {
  constructor() {
    this.documents = new Map();
    this.queue = Promise.resolve();
    this.reads = 0;
    this.writes = 0;
  }

  write(path, value) {
    this.documents.set(path, value);
    this.writes += 1;
  }

  collection(name) {
    return new CollectionReference(this, name);
  }

  batch() {
    return new WriteBatch();
  }

  /** Serializes transactions so concurrent claims behave like Firestore's optimistic retries. */
  async runTransaction(callback) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const transaction = new Transaction();
      const result = await callback(transaction);
      await transaction.commit();
      return result;
    } finally {
      release();
    }
  }

  /** Every stored document, for assertions about what the service persists. */
  dump() {
    return Object.fromEntries([...this.documents].map(([path, value]) => [path, clone(value)]));
  }
}

module.exports = { FakeFirestore };
