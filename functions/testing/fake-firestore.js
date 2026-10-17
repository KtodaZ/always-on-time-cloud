"use strict";

// In-memory stand-in for the subset of the Admin Firestore API the iOS push store uses.
// It enforces the rules that matter for correctness: transactions are serialized, every
// transactional read must precede the first write, `update` fails on missing documents, and
// range filters only match values of the same type (so null fields drop out, as in Firestore).
// Merge writes apply increments written as `{ __increment: n }` (tests pass that as FieldValue).
// Documents carry an update time (a Date from `db.now()`); batches commit atomically at one time,
// honour `lastUpdateTime` preconditions and return write results, as Firestore does.

const { FieldValue } = require("firebase-admin/firestore");

const SERVER_TIMESTAMP = FieldValue.serverTimestamp();
const STAMP = "__serverTimestamp";

// Top-level FieldValue.serverTimestamp() fields become a marker that `write` replaces with the
// commit time, so they match the document's update time as in Firestore.
function clone(value) {
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
    value = Object.fromEntries(Object.entries(value).map(([key, field]) =>
      [key, field instanceof FieldValue && field.isEqual(SERVER_TIMESTAMP) ? { [STAMP]: true } : field]));
  }
  return structuredClone(value);
}

class DocumentSnapshot {
  constructor(db, path) {
    this.ref = new DocumentReference(db, path);
    this.id = this.ref.id;
    this.exists = db.documents.has(path);
    this._data = clone(db.documents.get(path));
    this.updateTime = this.exists ? new Date(db.updateTimes.get(path) ?? 0) : undefined;
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
    this.check("create");
    this.db.write(this.path, clone(value));
  }

  /** Throws the Firestore error a write would fail with. */
  check(kind, precondition) {
    if (kind === "create" && this.db.documents.has(this.path)) {
      const error = new Error("document already exists");
      error.code = 6;
      throw error;
    }
    if (kind === "update" && !this.db.documents.has(this.path)) {
      const error = new Error(`no document to update: ${this.path}`);
      error.code = 5;
      throw error;
    }
    if (precondition?.lastUpdateTime !== undefined) {
      const expected = precondition.lastUpdateTime instanceof Date ? precondition.lastUpdateTime.getTime() : precondition.lastUpdateTime?.toMillis?.();
      if ((this.db.updateTimes.get(this.path) ?? 0) !== expected) {
        const error = new Error("precondition failed");
        error.code = 9;
        throw error;
      }
    }
  }

  async set(value, options = {}) {
    if (options.merge) {
      this.db.write(this.path, mergeInto(clone(this.db.documents.get(this.path)) ?? {}, clone(value)));
    } else this.db.write(this.path, clone(value));
  }

  async update(value, precondition) {
    this.check("update", precondition);
    this.db.write(this.path, { ...this.db.documents.get(this.path), ...clone(value) });
  }

  async delete() {
    this.db.documents.delete(this.path);
    this.db.updateTimes.delete(this.path);
    this.db.writes += 1;
  }
}

function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (value && typeof value === "object" && "__increment" in value) target[key] = (target[key] ?? 0) + value.__increment;
    else if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      target[key] = mergeInto(target[key] && typeof target[key] === "object" ? target[key] : {}, value);
    } else target[key] = value;
  }
  return target;
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
  constructor(db, path, { filters = [], order = null, direction = "asc", maximum = null } = {}) {
    this.db = db;
    this.path = path;
    this.filters = filters;
    this.order = order;
    this.direction = direction;
    this.maximum = maximum;
  }

  where(field, operator, value) {
    return new Query(this.db, this.path, { ...this, filters: [...this.filters, { field, operator, value }] });
  }

  orderBy(field, direction = "asc") {
    return new Query(this.db, this.path, { ...this, order: field, direction });
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
      matches.sort(([, left], [, right]) => (left[this.order] - right[this.order]) * (this.direction === "desc" ? -1 : 1));
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

  set(ref, value, options) { this.pending.push(() => ref.set(value, options)); }
  update(ref, value) { this.pending.push(() => ref.update(value)); }
  delete(ref) { this.pending.push(() => ref.delete()); }

  async commit() {
    for (const write of this.pending) await write();
  }
}

class WriteBatch {
  constructor(db) {
    this.db = db;
    this.pending = [];
  }

  create(ref, value) { this.pending.push({ kind: "create", ref, apply: () => ref.create(value) }); }
  delete(ref) { this.pending.push({ kind: "delete", ref, apply: () => ref.delete() }); }
  set(ref, value, options) { this.pending.push({ kind: "set", ref, apply: () => ref.set(value, options) }); }
  update(ref, value, precondition) { this.pending.push({ kind: "update", ref, precondition, apply: () => ref.update(value, precondition) }); }

  /** All-or-nothing at a single commit time. */
  async commit() {
    for (const { kind, ref, precondition } of this.pending) ref.check(kind, precondition);
    const time = this.db.commitTime();
    this.db.frozenTime = time;
    try {
      for (const { apply } of this.pending) await apply();
    } finally {
      this.db.frozenTime = null;
    }
    return this.pending.map(() => ({ writeTime: new Date(time) }));
  }
}

class FakeFirestore {
  constructor() {
    this.documents = new Map();
    this.updateTimes = new Map();
    this.now = () => Date.now();
    this.lastTime = 0;
    this.frozenTime = null;
    this.queue = Promise.resolve();
    this.reads = 0;
    this.writes = 0;
  }

  /** A strictly increasing commit time, like Firestore's. */
  commitTime() {
    this.lastTime = Math.max(this.now(), this.lastTime + 1);
    return this.lastTime;
  }

  write(path, value) {
    const time = this.frozenTime ?? this.commitTime();
    for (const [key, field] of Object.entries(value ?? {})) {
      if (field && typeof field === "object" && field[STAMP] === true) value[key] = new Date(time);
    }
    this.documents.set(path, value);
    this.updateTimes.set(path, time);
    this.writes += 1;
  }

  collection(name) {
    return new CollectionReference(this, name);
  }

  batch() {
    return new WriteBatch(this);
  }

  /** Deletes a collection's documents and everything nested below them. */
  async recursiveDelete(ref) {
    for (const path of [...this.documents.keys()]) {
      if (path.startsWith(`${ref.path}/`)) {
        this.documents.delete(path);
        this.writes += 1;
      }
    }
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
