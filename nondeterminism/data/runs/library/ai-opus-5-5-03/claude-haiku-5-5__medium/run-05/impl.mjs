const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayNumOf(y, m, d) {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

const MIN_DAY = dayNumOf(1, 1, 1);
const MAX_DAY = dayNumOf(9999, 12, 31);

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}

function dayNum(s) {
  return dayNumOf(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)));
}

function fromDayNum(n) {
  const c = Math.min(Math.max(n, MIN_DAY), MAX_DAY);
  const t = new Date(c * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fromDayNum(dayNum(s) + n);
}

function isObj(a) {
  return a !== null && typeof a === 'object' && !Array.isArray(a);
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

const NO = () => ({ ok: false });

function safe(fn) {
  return (args) => {
    try {
      return fn(args);
    } catch {
      return NO();
    }
  };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: null | {memberId, dueDate, renewals}, queue: [] }
  const members = new Map(); // memberId -> { owed: number, loans: [bookId] }
  let clock = null;
  let seq = 0;

  function readArgs(args, opts = {}) {
    if (!isObj(args)) return null;
    const out = {};
    out.memberId = args.memberId;
    if (!validId(out.memberId)) return null;
    if (opts.book) {
      out.bookId = args.bookId;
      if (!validId(out.bookId)) return null;
    }
    if (opts.amount) {
      out.amount = args.amount;
      if (!Number.isSafeInteger(out.amount) || out.amount <= 0) return null;
    }
    out.date = args.date;
    if (!isValidDate(out.date)) return null;
    return out;
  }

  function processHolds(D) {
    for (const b of books.values()) {
      while (b.queue.length > 0 && b.queue[0].readyUntil !== null && b.queue[0].readyUntil < D) {
        const old = b.queue.shift().readyUntil;
        if (b.queue.length > 0) {
          const E = addDays(old, 1);
          b.queue[0].readyUntil = addDays(E, PICKUP_DAYS);
        }
      }
    }
  }

  function advance(date) {
    if (clock !== null && date < clock) return false;
    clock = date;
    processHolds(date);
    return true;
  }

  return {
    addBook: safe((args) => {
      if (!isObj(args) || !validId(args.bookId) || books.has(args.bookId)) return NO();
      books.set(args.bookId, { loan: null, queue: [] });
      return { ok: true };
    }),

    addMember: safe((args) => {
      if (!isObj(args) || !validId(args.memberId) || members.has(args.memberId)) return NO();
      members.set(args.memberId, { owed: 0, loans: [] });
      return { ok: true };
    }),

    borrow: safe((args) => {
      const a = readArgs(args, { book: true });
      if (!a || !advance(a.date)) return NO();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b || b.loan) return NO();
      const head = b.queue[0];
      const ready = head !== undefined && head.readyUntil !== null;
      if (ready && head.memberId !== a.memberId) return NO();
      if (m.loans.length >= MAX_LOANS || m.owed >= BORROW_BLOCK_OWED) return NO();
      if (ready) b.queue.shift();
      const dueDate = addDays(a.date, LOAN_DAYS);
      b.loan = { memberId: a.memberId, dueDate, renewals: 0 };
      m.loans.push(a.bookId);
      return { ok: true, dueDate };
    }),

    returnBook: safe((args) => {
      const a = readArgs(args, { book: true });
      if (!a || !advance(a.date)) return NO();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== a.memberId) return NO();
      const late = dayNum(a.date) - dayNum(b.loan.dueDate);
      const fine = late <= GRACE_DAYS
        ? 0
        : Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(a.bookId), 1);
      b.loan = null;
      if (b.queue.length > 0) {
        b.queue[0].readyUntil = addDays(a.date, PICKUP_DAYS);
      }
      return { ok: true, fine };
    }),

    renew: safe((args) => {
      const a = readArgs(args, { book: true });
      if (!a || !advance(a.date)) return NO();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== a.memberId) return NO();
      const L = b.loan;
      if (a.date > L.dueDate) return NO();
      if (L.renewals >= MAX_RENEWALS) return NO();
      if (b.queue.length > 0) return NO();
      L.dueDate = addDays(L.dueDate, LOAN_DAYS);
      L.renewals += 1;
      return { ok: true, dueDate: L.dueDate };
    }),

    placeHold: safe((args) => {
      const a = readArgs(args, { book: true });
      if (!a || !advance(a.date)) return NO();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return NO();
      if (!b.loan && b.queue.length === 0) return NO();
      if (b.loan && b.loan.memberId === a.memberId) return NO();
      if (b.queue.some((e) => e.memberId === a.memberId)) return NO();
      b.queue.push({ seq: ++seq, memberId: a.memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    }),

    payFine: safe((args) => {
      const a = readArgs(args, { amount: true });
      if (!a || !advance(a.date)) return NO();
      const m = members.get(a.memberId);
      if (!m || a.amount > m.owed) return NO();
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    }),

    getMember: safe((args) => {
      const a = readArgs(args);
      if (!a || !advance(a.date)) return NO();
      const m = members.get(a.memberId);
      if (!m) return NO();
      const loans = m.loans.map((id) => ({
        bookId: id,
        dueDate: books.get(id).loan.dueDate,
      }));
      const raw = [];
      for (const [bookId, b] of books) {
        b.queue.forEach((e, i) => {
          if (e.memberId === a.memberId) {
            raw.push({ seq: e.seq, bookId, position: i + 1, readyUntil: e.readyUntil });
          }
        });
      }
      raw.sort((x, y) => x.seq - y.seq);
      const holds = raw.map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil,
      }));
      return { ok: true, loans, owed: m.owed, holds };
    }),
  };
}
