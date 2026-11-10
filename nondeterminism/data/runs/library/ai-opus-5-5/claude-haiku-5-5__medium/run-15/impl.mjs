const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return Math.round(dt.getTime() / DAY_MS);
}

const MAX_DAY = parseDate('9999-12-31');

function toIso(day) {
  const dt = new Date(day * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDay, renewals } | null, queue: [{ memberId, seq }], readyDay: number | null }
  const books = new Map();
  // memberId -> { loans: [bookId] in borrow order, owed: number }
  const members = new Map();
  let now = null;
  let holdSeq = 0;

  const fail = () => ({ ok: false });
  const isId = (v) => typeof v === 'string' && v.length > 0;
  const isObj = (v) => v !== null && typeof v === 'object';
  const isAmount = (v) => Number.isSafeInteger(v) && v > 0;

  // Processes hold expiries for every book, as of `day`.
  function advance(day) {
    for (const b of books.values()) {
      while (!b.loan && b.queue.length > 0 && day > b.readyDay) {
        b.queue.shift();
        if (b.queue.length === 0) {
          b.readyDay = null;
        } else {
          b.readyDay = Math.min(b.readyDay + 1 + PICKUP_DAYS, MAX_DAY);
        }
      }
    }
  }

  // Applies the clock rule for a dated call. Returns false if the date is earlier than now.
  function enter(day) {
    if (now !== null && day < now) return false;
    now = day;
    advance(day);
    return true;
  }

  function addBook(args) {
    if (!isObj(args) || !isId(args.bookId) || books.has(args.bookId)) return fail();
    books.set(args.bookId, { loan: null, queue: [], readyDay: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !isId(args.memberId) || members.has(args.memberId)) return fail();
    members.set(args.memberId, { loans: [], owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
    const day = parseDate(args.date);
    if (day === null || !enter(day)) return fail();
    const m = members.get(args.memberId);
    const b = books.get(args.bookId);
    if (!m || !b || b.loan) return fail();
    if (b.queue.length > 0 && b.queue[0].memberId !== args.memberId) return fail();
    if (m.loans.length >= MAX_LOANS) return fail();
    if (m.loans.some((id) => books.get(id).loan.dueDay < day)) return fail();
    if (m.owed >= BLOCK_OWED) return fail();
    const dueDay = day + LOAN_DAYS;
    if (dueDay > MAX_DAY) return fail();

    if (b.queue.length > 0) {
      b.queue.shift();
    }
    if (b.queue.length === 0) {
      b.readyDay = null;
    }
    b.loan = { memberId: args.memberId, dueDay, renewals: 0 };
    m.loans.push(args.bookId);
    return { ok: true, dueDate: toIso(dueDay) };
  }

  function returnBook(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
    const day = parseDate(args.date);
    if (day === null || !enter(day)) return fail();
    const m = members.get(args.memberId);
    const b = books.get(args.bookId);
    if (!m || !b || !b.loan || b.loan.memberId !== args.memberId) return fail();

    let readyDay = null;
    if (b.queue.length > 0) {
      readyDay = day + PICKUP_DAYS;
      if (readyDay > MAX_DAY) return fail();
    }

    const daysLate = Math.max(0, day - b.loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));

    m.owed += fine;
    m.loans.splice(m.loans.indexOf(args.bookId), 1);
    b.loan = null;
    b.readyDay = readyDay;
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
    const day = parseDate(args.date);
    if (day === null || !enter(day)) return fail();
    const m = members.get(args.memberId);
    const b = books.get(args.bookId);
    if (!m || !b || !b.loan || b.loan.memberId !== args.memberId) return fail();
    if (b.loan.renewals >= MAX_RENEWALS) return fail();
    if (day > b.loan.dueDay) return fail();
    if (b.queue.length > 0) return fail();
    const dueDay = day + RENEWAL_DAYS;
    if (dueDay > MAX_DAY) return fail();

    b.loan.dueDay = dueDay;
    b.loan.renewals += 1;
    return { ok: true, dueDate: toIso(dueDay) };
  }

  function placeHold(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
    const day = parseDate(args.date);
    if (day === null || !enter(day)) return fail();
    const m = members.get(args.memberId);
    const b = books.get(args.bookId);
    if (!m || !b) return fail();
    if (!b.loan && b.queue.length === 0) return fail();
    if (b.loan && b.loan.memberId === args.memberId) return fail();
    if (b.queue.some((h) => h.memberId === args.memberId)) return fail();

    let active = 0;
    for (const other of books.values()) {
      for (const h of other.queue) {
        if (h.memberId === args.memberId) active += 1;
      }
    }
    if (active >= MAX_HOLDS) return fail();

    b.queue.push({ memberId: args.memberId, seq: ++holdSeq });
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    if (!isObj(args) || !isId(args.memberId) || !isAmount(args.amount)) return fail();
    const day = parseDate(args.date);
    if (day === null || !enter(day)) return fail();
    const m = members.get(args.memberId);
    if (!m) return fail();
    if (args.amount > m.owed) return fail();

    m.owed -= args.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    if (!isObj(args) || !isId(args.memberId)) return fail();
    const day = parseDate(args.date);
    if (day === null || !enter(day)) return fail();
    const m = members.get(args.memberId);
    if (!m) return fail();

    const loans = m.loans.map((id) => ({
      bookId: id,
      dueDate: toIso(books.get(id).loan.dueDay),
    }));

    const entries = [];
    for (const [bookId, b] of books) {
      b.queue.forEach((h, i) => {
        if (h.memberId === args.memberId) {
          entries.push({
            seq: h.seq,
            bookId,
            position: i + 1,
            readyUntil: !b.loan && i === 0 ? toIso(b.readyDay) : null,
          });
        }
      });
    }
    entries.sort((x, y) => x.seq - y.seq);
    const holds = entries.map(({ bookId, position, readyUntil }) => ({
      bookId,
      position,
      readyUntil,
    }));

    return { ok: true, loans, owed: m.owed, holds };
  }

  return {
    addBook,
    addMember,
    borrow,
    returnBook,
    renew,
    placeHold,
    payFine,
    getMember,
  };
}
