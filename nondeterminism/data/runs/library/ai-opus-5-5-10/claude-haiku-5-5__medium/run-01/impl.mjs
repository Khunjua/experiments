const MS_PER_DAY = 86400000;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;
const DEBT_LIMIT = 1000;
const PICKUP_DAYS = 7;

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Returns the day number (days since 1970-01-01) for a valid YYYY-MM-DD string, else null.
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (m < 1 || m > 12) return null;
  const maxDay = m === 2 && isLeapYear(y) ? 29 : DAYS_IN_MONTH[m - 1];
  if (d < 1 || d > maxDay) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDate(day) {
  const t = new Date(day * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(value) {
  return typeof value === 'string' && value.length > 0;
}

function isArgs(a) {
  return a !== null && typeof a === 'object';
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { id, state: 'available' | 'loan' | 'setaside', readyUntil, loan, queue: [{ memberId, seq }] }
  const books = new Map();
  // memberId -> { owed, loans: [{ bookId, memberId, dueDay, renewals }] }
  const members = new Map();
  let lastDay = null;
  let holdSeq = 0;

  function processExpiry(day) {
    for (const book of books.values()) {
      while (book.state === 'setaside' && day > book.readyUntil) {
        book.queue.shift();
        const nextSetAsideDay = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.readyUntil = nextSetAsideDay + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
        }
      }
    }
  }

  // Step 2 and 3 of §3.6. Caller has already validated the date format.
  function admit(day) {
    if (lastDay !== null && day < lastDay) return false;
    lastDay = day;
    processExpiry(day);
    return true;
  }

  function addBook(a) {
    if (!isArgs(a) || !isId(a.bookId)) return fail('invalid arguments');
    if (books.has(a.bookId)) return fail('book exists');
    books.set(a.bookId, {
      id: a.bookId,
      state: 'available',
      readyUntil: null,
      loan: null,
      queue: [],
    });
    return { ok: true };
  }

  function addMember(a) {
    if (!isArgs(a) || !isId(a.memberId)) return fail('invalid arguments');
    if (members.has(a.memberId)) return fail('member exists');
    members.set(a.memberId, { owed: 0, loans: [] });
    return { ok: true };
  }

  function borrow(a) {
    if (!isArgs(a) || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!admit(day)) return fail('date before last date');

    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.state === 'loan') return fail('book on loan');
    if (b.state === 'setaside' && b.queue[0].memberId !== a.memberId) {
      return fail('set aside for another member');
    }
    if (b.state === 'available' && b.queue.length > 0) return fail('hold queue inconsistent');
    if (m.owed >= DEBT_LIMIT) return fail('debt limit');
    if (m.loans.some((l) => day > l.dueDay)) return fail('overdue loan');
    if (m.loans.length >= MAX_LOANS) return fail('loan limit');

    const loan = { bookId: a.bookId, memberId: a.memberId, dueDay: day + LOAN_DAYS, renewals: 0 };
    m.loans.push(loan);
    if (b.state === 'setaside') {
      b.queue.shift();
    }
    b.state = 'loan';
    b.readyUntil = null;
    b.loan = loan;
    return { ok: true, dueDate: formatDate(loan.dueDay) };
  }

  function returnBook(a) {
    if (!isArgs(a) || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!admit(day)) return fail('date before last date');

    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.state !== 'loan' || b.loan.memberId !== a.memberId) {
      return fail('not on loan to this member');
    }

    const loan = b.loan;
    const late = Math.max(0, day - loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
    m.owed += fine;

    const idx = m.loans.indexOf(loan);
    if (idx !== -1) m.loans.splice(idx, 1);
    b.loan = null;

    if (b.queue.length > 0) {
      b.state = 'setaside';
      b.readyUntil = day + PICKUP_DAYS;
    } else {
      b.state = 'available';
      b.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(a) {
    if (!isArgs(a) || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!admit(day)) return fail('date before last date');

    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.state !== 'loan' || b.loan.memberId !== a.memberId) {
      return fail('not on loan to this member');
    }

    const loan = b.loan;
    if (day > loan.dueDay) return fail('loan overdue');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (b.queue.length > 0) return fail('book is wanted');
    if (m.owed >= DEBT_LIMIT) return fail('debt limit');

    loan.dueDay += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDay) };
  }

  function placeHold(a) {
    if (!isArgs(a) || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!admit(day)) return fail('date before last date');

    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.state === 'available') return fail('book is available');
    if (b.state === 'loan' && b.loan.memberId === a.memberId) return fail('already on loan');
    if (b.queue.some((e) => e.memberId === a.memberId)) return fail('hold exists');

    holdSeq += 1;
    b.queue.push({ memberId: a.memberId, seq: holdSeq });
    return { ok: true, position: b.queue.length };
  }

  function payFine(a) {
    if (!isArgs(a) || !isId(a.memberId) || !Number.isInteger(a.amount)) {
      return fail('invalid arguments');
    }
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!admit(day)) return fail('date before last date');

    const m = members.get(a.memberId);
    if (!m) return fail('unknown member');
    if (a.amount < 1) return fail('amount too small');
    if (a.amount > m.owed) return fail('overpayment');

    m.owed -= a.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(a) {
    if (!isArgs(a) || !isId(a.memberId)) return fail('invalid arguments');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    if (!admit(day)) return fail('date before last date');

    const m = members.get(a.memberId);
    if (!m) return fail('unknown member');

    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.dueDay) }));

    const holds = [];
    for (const b of books.values()) {
      const idx = b.queue.findIndex((e) => e.memberId === a.memberId);
      if (idx === -1) continue;
      const setAsideForMember = b.state === 'setaside' && idx === 0;
      holds.push({
        seq: b.queue[idx].seq,
        bookId: b.id,
        position: idx + 1,
        readyUntil: setAsideForMember ? formatDate(b.readyUntil) : null,
      });
    }
    holds.sort((x, y) => x.seq - y.seq);

    return {
      loans,
      owed: m.owed,
      holds: holds.map((h) => ({ bookId: h.bookId, position: h.position, readyUntil: h.readyUntil })),
    };
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
