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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Pure UTC-style civil day arithmetic (no time zones involved).
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  return [y, m, d];
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function formatDay(n) {
  const [y, m, d] = civilFromDays(n);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

const FAIL = () => ({ ok: false });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, dueDay, renewals} | null, queue: [{memberId, seq}], readyUntil: number|null }
  const members = new Map(); // memberId -> { owed, loans: Map<bookId, true> }
  let currentDay = null;
  let holdSeq = 0;

  function readArgs(args, fields) {
    if (typeof args !== 'object' || args === null) return null;
    const out = {};
    for (const f of fields) out[f] = args[f];
    return out;
  }

  function processExpiry(day) {
    for (const book of books.values()) {
      while (book.loan === null && book.queue.length > 0 && day > book.readyUntil) {
        const prev = book.readyUntil;
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns day number or null if the call must fail.
  function clock(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (currentDay !== null && day < currentDay) return null;
    currentDay = day;
    processExpiry(day);
    return day;
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const h of book.queue) if (h.memberId === memberId) n++;
    }
    return n;
  }

  function safe(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return FAIL();
      }
    };
  }

  const lib = {
    addBook: safe((args) => {
      const a = readArgs(args, ['bookId']);
      if (!a || !isId(a.bookId) || books.has(a.bookId)) return FAIL();
      books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    }),

    addMember: safe((args) => {
      const a = readArgs(args, ['memberId']);
      if (!a || !isId(a.memberId) || members.has(a.memberId)) return FAIL();
      members.set(a.memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    }),

    borrow: safe((args) => {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL();
      const day = clock(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL();
      if (book.loan !== null) return FAIL();
      const setAside = book.queue.length > 0;
      if (setAside && book.queue[0].memberId !== a.memberId) return FAIL();
      if (member.loans.size >= MAX_LOANS) return FAIL();
      for (const bid of member.loans.keys()) {
        if (books.get(bid).loan.dueDay < day) return FAIL();
      }
      if (member.owed >= OWED_BLOCK) return FAIL();

      if (setAside) {
        book.queue.shift();
        book.readyUntil = null;
      }
      const dueDay = day + LOAN_DAYS;
      book.loan = { memberId: a.memberId, dueDay, renewals: 0 };
      member.loans.set(a.bookId, true);
      return { ok: true, dueDate: formatDay(dueDay) };
    }),

    returnBook: safe((args) => {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL();
      const day = clock(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL();
      if (book.loan === null || book.loan.memberId !== a.memberId) return FAIL();

      const daysLate = Math.max(0, day - book.loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;
      book.loan = null;
      member.loans.delete(a.bookId);
      if (book.queue.length > 0) {
        book.readyUntil = day + PICKUP_DAYS;
      } else {
        book.readyUntil = null;
      }
      return { ok: true, fine };
    }),

    renew: safe((args) => {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL();
      const day = clock(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL();
      const loan = book.loan;
      if (loan === null || loan.memberId !== a.memberId) return FAIL();
      if (loan.renewals >= MAX_RENEWALS) return FAIL();
      if (day > loan.dueDay) return FAIL();
      if (book.queue.length > 0) return FAIL();

      loan.dueDay = Math.max(loan.dueDay, day + RENEW_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.dueDay) };
    }),

    placeHold: safe((args) => {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL();
      const day = clock(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL();
      if (book.loan === null && book.queue.length === 0) return FAIL();
      if (book.loan !== null && book.loan.memberId === a.memberId) return FAIL();
      if (book.queue.some((h) => h.memberId === a.memberId)) return FAIL();
      if (activeHoldCount(a.memberId) >= MAX_HOLDS) return FAIL();

      book.queue.push({ memberId: a.memberId, seq: holdSeq++ });
      return { ok: true, position: book.queue.length };
    }),

    payFine: safe((args) => {
      const a = readArgs(args, ['memberId', 'amount', 'date']);
      if (!a) return FAIL();
      const day = clock(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId)) return FAIL();
      const member = members.get(a.memberId);
      if (!member) return FAIL();
      if (typeof a.amount !== 'number' || !Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL();
      if (a.amount > member.owed) return FAIL();
      member.owed -= a.amount;
      return { ok: true, owed: member.owed };
    }),

    getMember: safe((args) => {
      const a = readArgs(args, ['memberId', 'date']);
      if (!a) return FAIL();
      const day = clock(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId)) return FAIL();
      const member = members.get(a.memberId);
      if (!member) return FAIL();

      const loans = [];
      for (const bid of member.loans.keys()) {
        loans.push({ bookId: bid, dueDate: formatDay(books.get(bid).loan.dueDay) });
      }
      const found = [];
      for (const [bid, book] of books) {
        book.queue.forEach((h, i) => {
          if (h.memberId === a.memberId) {
            const ready = i === 0 && book.loan === null;
            found.push({
              seq: h.seq,
              hold: {
                bookId: bid,
                position: i + 1,
                readyUntil: ready ? formatDay(book.readyUntil) : null,
              },
            });
          }
        });
      }
      found.sort((x, y) => x.seq - y.seq);
      return { ok: true, loans, owed: member.owed, holds: found.map((f) => f.hold) };
    }),
  };

  return lib;
}
