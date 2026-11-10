const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function isObject(a) {
  return a !== null && typeof a === 'object' && !Array.isArray(a);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns an integer day number (days since 1970-01-01), or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDay(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fail(reason) {
  return { ok: false, reason };
}

function guard(fn) {
  return (args) => {
    try {
      return fn(args);
    } catch {
      return fail('internal error');
    }
  };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { id, status, loan, queue }
  const members = new Map(); // memberId -> { id, owed, loans, holds }
  let clock = null;          // day number of last accepted dated call
  let orderCounter = 0;      // global counter for holds and loans

  function removeHoldFromMember(hold) {
    const m = members.get(hold.memberId);
    if (m) m.holds = m.holds.filter((h) => h !== hold);
  }

  // Section 5.2: a book leaves a hold on day S.
  function passToQueue(book, S) {
    if (book.queue.length === 0) {
      book.status = 'available';
    } else {
      book.status = 'readyForPickup';
      book.queue[0].readyUntil = S + PICKUP_DAYS;
    }
  }

  // Section 5.3: expire ready holds whose readyUntil is strictly before T.
  function expire(T) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.status !== 'readyForPickup') continue;
        const hold = book.queue[0];
        if (hold.readyUntil < T) {
          book.queue.shift();
          removeHoldFromMember(hold);
          passToQueue(book, hold.readyUntil + 1);
          changed = true;
        }
      }
    }
  }

  // Section 3.5 steps 2 and 3. Returns false if the date is before the clock.
  function advanceClock(d) {
    if (clock !== null && d < clock) return false;
    clock = d;
    expire(d);
    return true;
  }

  function addBook(args) {
    if (!isObject(args)) return fail('invalid arguments');
    const bookId = args.bookId;
    if (!isId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { id: bookId, status: 'available', loan: null, queue: [] });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObject(args)) return fail('invalid arguments');
    const memberId = args.memberId;
    if (!isId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { id: memberId, owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObject(args)) return fail('invalid arguments');
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const d = parseDay(args.date);
    if (d === null) return fail('invalid date');
    if (!advanceClock(d)) return fail('date before clock');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');
    if (book.status === 'onLoan') return fail('on loan');

    let readyHold = null;
    if (book.status === 'readyForPickup') {
      if (book.queue[0].memberId !== memberId) return fail('set aside for another member');
      readyHold = book.queue[0];
    } else if (book.queue.length > 0) {
      return fail('inconsistent state');
    }

    if (readyHold) {
      book.queue.shift();
      member.holds = member.holds.filter((h) => h !== readyHold);
    }

    const loan = {
      bookId,
      memberId,
      borrowDay: d,
      dueDay: d + LOAN_DAYS,
      renewals: 0,
      seq: ++orderCounter,
    };
    member.loans.push(loan);
    book.loan = loan;
    book.status = 'onLoan';
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function returnBook(args) {
    if (!isObject(args)) return fail('invalid arguments');
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const d = parseDay(args.date);
    if (d === null) return fail('invalid date');
    if (!advanceClock(d)) return fail('date before clock');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    if (book.status !== 'onLoan' || book.loan.memberId !== memberId) {
      return fail('not on loan to member');
    }

    const loan = book.loan;
    const lateDays = d - loan.dueDay;
    const fine = lateDays > 0 ? Math.min(lateDays * FINE_PER_DAY, FINE_CAP) : 0;

    member.owed += fine;
    member.loans = member.loans.filter((l) => l !== loan);
    book.loan = null;
    passToQueue(book, d);
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObject(args)) return fail('invalid arguments');
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const d = parseDay(args.date);
    if (d === null) return fail('invalid date');
    if (!advanceClock(d)) return fail('date before clock');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    if (book.status !== 'onLoan' || book.loan.memberId !== memberId) {
      return fail('not on loan to member');
    }
    const loan = book.loan;
    if (book.queue.length > 0) return fail('someone is waiting');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (d > loan.dueDay) return fail('loan is overdue');
    if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');

    loan.dueDay += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function placeHold(args) {
    if (!isObject(args)) return fail('invalid arguments');
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const d = parseDay(args.date);
    if (d === null) return fail('invalid date');
    if (!advanceClock(d)) return fail('date before clock');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    if (book.status === 'available') return fail('book is available');
    if (book.status === 'onLoan' && book.loan.memberId === memberId) {
      return fail('member already has this book');
    }
    if (book.queue.some((h) => h.memberId === memberId)) {
      return fail('hold already exists');
    }

    const hold = {
      memberId,
      bookId,
      placedOrder: ++orderCounter,
      readyUntil: null,
    };
    book.queue.push(hold);
    member.holds.push(hold);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (!isObject(args)) return fail('invalid arguments');
    const memberId = args.memberId;
    if (!isId(memberId)) return fail('invalid memberId');
    const amount = args.amount;
    if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
    const d = parseDay(args.date);
    if (d === null) return fail('invalid date');
    if (!advanceClock(d)) return fail('date before clock');

    const member = members.get(memberId);
    if (!member) return fail('not found');
    if (amount > member.owed) return fail('amount exceeds owed');

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (!isObject(args)) return fail('invalid arguments');
    const memberId = args.memberId;
    if (!isId(memberId)) return fail('invalid memberId');
    const d = parseDay(args.date);
    if (d === null) return fail('invalid date');
    if (!advanceClock(d)) return fail('date before clock');

    const member = members.get(memberId);
    if (!member) return fail('not found');

    const loans = member.loans
      .slice()
      .sort((a, b) => (a.borrowDay - b.borrowDay) || (a.seq - b.seq))
      .map((l) => ({ bookId: l.bookId, dueDate: formatDay(l.dueDay) }));

    const holds = member.holds
      .slice()
      .sort((a, b) => a.placedOrder - b.placedOrder)
      .map((h) => {
        const book = books.get(h.bookId);
        return {
          bookId: h.bookId,
          position: book.queue.indexOf(h) + 1,
          readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
        };
      });

    return { loans, owed: member.owed, holds };
  }

  return {
    addBook: guard(addBook),
    addMember: guard(addMember),
    borrow: guard(borrow),
    returnBook: guard(returnBook),
    renew: guard(renew),
    placeHold: guard(placeHold),
    payFine: guard(payFine),
    getMember: guard(getMember),
  };
}
