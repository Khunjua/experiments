const DAY_MS = 86400000;

function fail() {
  return { ok: false };
}

function isObj(v) {
  return typeof v === 'object' && v !== null;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return Math.round(dt.getTime() / DAY_MS);
}

function fmt(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  const books = new Map();   // bookId -> { state: 'shelf'|'loan'|'aside', borrower, queue: [{memberId, seq}], readyUntil }
  const members = new Map(); // memberId -> { loans: Map(bookId -> { due, renewals }), owed }
  let seqCounter = 0;

  // Process hold expirations for all books up to and including day-compare rules of §3.5.
  function expire(day) {
    for (const book of books.values()) {
      if (book.state !== 'aside') continue;
      while (book.state === 'aside' && day > book.readyUntil) {
        book.queue.shift();
        if (book.queue.length > 0) {
          // start = previous readyUntil + 1, readyUntil = start + 7
          book.readyUntil = book.readyUntil + 8;
        } else {
          book.state = 'shelf';
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the argument object and date, then runs time processing.
  // Returns the day number, or null if the date/argument is invalid (no processing done).
  function startDated(arg) {
    if (!isObj(arg)) return null;
    const day = parseDay(arg.date);
    if (day === null) return null;
    expire(day);
    return day;
  }

  function countActiveHolds(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const e of book.queue) {
        if (e.memberId === memberId) n++;
      }
    }
    return n;
  }

  function guard(fn) {
    return (arg) => {
      try {
        return fn(arg);
      } catch {
        return fail();
      }
    };
  }

  const addBook = guard((arg) => {
    if (!isObj(arg)) return fail();
    const bookId = arg.bookId;
    if (!isId(bookId) || books.has(bookId)) return fail();
    books.set(bookId, { state: 'shelf', borrower: null, queue: [], readyUntil: null });
    return { ok: true };
  });

  const addMember = guard((arg) => {
    if (!isObj(arg)) return fail();
    const memberId = arg.memberId;
    if (!isId(memberId) || members.has(memberId)) return fail();
    members.set(memberId, { loans: new Map(), owed: 0 });
    return { ok: true };
  });

  const borrow = guard((arg) => {
    const day = startDated(arg);
    if (day === null) return fail();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.state === 'loan') return fail();
    if (b.state === 'aside' && b.queue[0].memberId !== memberId) return fail();
    if (b.state === 'shelf' && b.queue.length > 0) return fail();
    if (m.loans.size >= 5) return fail();
    if (m.owed >= 1000) return fail();
    for (const loan of m.loans.values()) {
      if (loan.due < day) return fail();
    }
    const due = day + 21;
    m.loans.set(bookId, { due, renewals: 0 });
    if (b.state === 'aside') {
      b.queue.shift();
    }
    b.state = 'loan';
    b.borrower = memberId;
    b.readyUntil = null;
    return { ok: true, dueDate: fmt(due) };
  });

  const returnBook = guard((arg) => {
    const day = startDated(arg);
    if (day === null) return fail();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    const loan = m.loans.get(bookId);
    if (!loan || b.state !== 'loan' || b.borrower !== memberId) return fail();

    const daysLate = Math.max(0, day - loan.due);
    const chargeable = Math.max(0, daysLate - 2);
    const fine = Math.min(chargeable * 25, 1000);

    m.owed += fine;
    m.loans.delete(bookId);
    b.borrower = null;
    if (b.queue.length > 0) {
      b.state = 'aside';
      b.readyUntil = day + 7;
    } else {
      b.state = 'shelf';
      b.readyUntil = null;
    }
    return { ok: true, fine };
  });

  const renew = guard((arg) => {
    const day = startDated(arg);
    if (day === null) return fail();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    const loan = m.loans.get(bookId);
    if (!loan || b.state !== 'loan' || b.borrower !== memberId) return fail();
    if (loan.renewals >= 2) return fail();
    if (day > loan.due) return fail();
    if (b.queue.length > 0) return fail();
    loan.due += 21;
    loan.renewals += 1;
    return { ok: true, dueDate: fmt(loan.due) };
  });

  const placeHold = guard((arg) => {
    const day = startDated(arg);
    if (day === null) return fail();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.state === 'shelf') return fail();
    if (m.loans.has(bookId)) return fail();
    if (b.queue.some((e) => e.memberId === memberId)) return fail();
    if (countActiveHolds(memberId) >= 5) return fail();
    b.queue.push({ memberId, seq: ++seqCounter });
    return { ok: true, position: b.queue.length };
  });

  const payFine = guard((arg) => {
    const day = startDated(arg);
    if (day === null) return fail();
    const memberId = arg.memberId;
    const amount = arg.amount;
    if (!isId(memberId)) return fail();
    const m = members.get(memberId);
    if (!m) return fail();
    if (!Number.isSafeInteger(amount) || amount < 1) return fail();
    if (amount > m.owed) return fail();
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  });

  const getMember = guard((arg) => {
    const day = startDated(arg);
    if (day === null) return fail();
    const memberId = arg.memberId;
    if (!isId(memberId)) return fail();
    const m = members.get(memberId);
    if (!m) return fail();

    const loanEntries = [];
    for (const [bookId, loan] of m.loans.entries()) {
      loanEntries.push({ bookId, due: loan.due });
    }
    loanEntries.sort((x, y) => {
      if (x.due !== y.due) return x.due - y.due;
      if (x.bookId < y.bookId) return -1;
      if (x.bookId > y.bookId) return 1;
      return 0;
    });
    const loans = loanEntries.map((e) => ({ bookId: e.bookId, dueDate: fmt(e.due) }));

    const holdEntries = [];
    for (const [bookId, b] of books.entries()) {
      b.queue.forEach((e, i) => {
        if (e.memberId === memberId) {
          const setAside = i === 0 && b.state === 'aside';
          holdEntries.push({
            seq: e.seq,
            bookId,
            position: i + 1,
            readyUntil: setAside ? fmt(b.readyUntil) : null,
          });
        }
      });
    }
    holdEntries.sort((x, y) => x.seq - y.seq);
    const holds = holdEntries.map((h) => ({
      bookId: h.bookId,
      position: h.position,
      readyUntil: h.readyUntil,
    }));

    return { ok: true, loans, owed: m.owed, holds };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
