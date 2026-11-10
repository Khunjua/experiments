const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const OWED_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(2000, 0, 1));
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / MS_PER_DAY);
}

function formatDate(day) {
  const dt = new Date(day * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

function readArgs(args, fields) {
  if (args === null || typeof args !== 'object') return null;
  const out = {};
  for (const f of fields) out[f] = args[f];
  return out;
}

export function createLibrary() {
  const books = new Map();   // bookId -> { state, loan, queue, readyUntil }
  const members = new Map(); // memberId -> { owed }
  let currentDate = null;
  let seq = 0;

  function processExpiry(day) {
    for (const book of books.values()) {
      while (book.state === 'aside' && day > book.readyUntil) {
        const prev = book.readyUntil;
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns day number or null if the call must fail. Advances clock and runs expiry.
  function enterDated(day) {
    if (currentDate !== null && day < currentDate) return false;
    currentDate = day;
    processExpiry(day);
    return true;
  }

  function memberLoans(memberId) {
    const res = [];
    for (const [bookId, book] of books) {
      if (book.state === 'loan' && book.loan.memberId === memberId) res.push({ bookId, loan: book.loan });
    }
    res.sort((a, b) => a.loan.seq - b.loan.seq);
    return res;
  }

  function memberHolds(memberId) {
    const res = [];
    for (const [bookId, book] of books) {
      book.queue.forEach((h, i) => {
        if (h.memberId === memberId) {
          res.push({
            bookId,
            seq: h.seq,
            position: i + 1,
            readyUntil: book.state === 'aside' && i === 0 ? book.readyUntil : null,
          });
        }
      });
    }
    res.sort((a, b) => a.seq - b.seq);
    return res;
  }

  function guard(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return fail('error');
      }
    };
  }

  const addBook = guard((args) => {
    const a = readArgs(args, ['bookId']);
    if (!a || !validId(a.bookId)) return fail('invalid');
    if (books.has(a.bookId)) return fail('exists');
    books.set(a.bookId, { state: 'available', loan: null, queue: [], readyUntil: null });
    return { ok: true };
  });

  const addMember = guard((args) => {
    const a = readArgs(args, ['memberId']);
    if (!a || !validId(a.memberId)) return fail('invalid');
    if (members.has(a.memberId)) return fail('exists');
    members.set(a.memberId, { owed: 0 });
    return { ok: true };
  });

  const borrow = guard((args) => {
    const a = readArgs(args, ['memberId', 'bookId', 'date']);
    if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!enterDated(day)) return fail('date in past');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('not registered');
    if (book.state === 'loan') return fail('on loan');
    if (book.state === 'aside' && book.queue[0].memberId !== a.memberId) return fail('set aside');
    const loans = memberLoans(a.memberId);
    if (loans.length >= MAX_LOANS) return fail('loan limit');
    if (loans.some((l) => l.loan.dueDate < day)) return fail('overdue');
    if (member.owed >= OWED_BLOCK) return fail('owes');
    if (book.state === 'aside') {
      book.queue.shift();
      book.readyUntil = null;
    }
    const dueDate = day + LOAN_DAYS;
    book.state = 'loan';
    book.loan = { memberId: a.memberId, dueDate, renewals: 0, seq: ++seq };
    return { ok: true, dueDate: formatDate(dueDate) };
  });

  const returnBook = guard((args) => {
    const a = readArgs(args, ['memberId', 'bookId', 'date']);
    if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!enterDated(day)) return fail('date in past');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('not registered');
    if (book.state !== 'loan' || book.loan.memberId !== a.memberId) return fail('not on loan to member');
    const daysLate = Math.max(0, day - book.loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    member.owed += fine;
    book.loan = null;
    if (book.queue.length === 0) {
      book.state = 'available';
      book.readyUntil = null;
    } else {
      book.state = 'aside';
      book.readyUntil = day + PICKUP_DAYS;
    }
    return { ok: true, fine };
  });

  const renew = guard((args) => {
    const a = readArgs(args, ['memberId', 'bookId', 'date']);
    if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!enterDated(day)) return fail('date in past');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('not registered');
    if (book.state !== 'loan' || book.loan.memberId !== a.memberId) return fail('not on loan to member');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (day > book.loan.dueDate) return fail('overdue');
    if (book.queue.length > 0) return fail('holds exist');
    const dueDate = day + RENEW_DAYS;
    book.loan.dueDate = dueDate;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDate(dueDate) };
  });

  const placeHold = guard((args) => {
    const a = readArgs(args, ['memberId', 'bookId', 'date']);
    if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!enterDated(day)) return fail('date in past');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('not registered');
    if (book.state === 'available') return fail('available');
    if (book.state === 'loan' && book.loan.memberId === a.memberId) return fail('member has book');
    if (book.queue.some((h) => h.memberId === a.memberId)) return fail('already held');
    if (memberHolds(a.memberId).length >= MAX_HOLDS) return fail('hold limit');
    book.queue.push({ memberId: a.memberId, seq: ++seq });
    return { ok: true, position: book.queue.length };
  });

  const payFine = guard((args) => {
    const a = readArgs(args, ['memberId', 'amount', 'date']);
    if (!a || !validId(a.memberId)) return fail('invalid');
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return fail('invalid amount');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!enterDated(day)) return fail('date in past');
    const member = members.get(a.memberId);
    if (!member) return fail('not registered');
    if (a.amount > member.owed) return fail('overpayment');
    member.owed -= a.amount;
    return { ok: true, owed: member.owed };
  });

  const getMember = guard((args) => {
    const a = readArgs(args, ['memberId', 'date']);
    if (!a || !validId(a.memberId)) return fail('invalid');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!enterDated(day)) return fail('date in past');
    const member = members.get(a.memberId);
    if (!member) return fail('not registered');
    return {
      ok: true,
      loans: memberLoans(a.memberId).map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.loan.dueDate) })),
      owed: member.owed,
      holds: memberHolds(a.memberId).map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil === null ? null : formatDate(h.readyUntil),
      })),
    };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
