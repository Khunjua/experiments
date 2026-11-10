const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function FAIL(reason) {
  return { ok: false, reason };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns the day number (days since 1970-01-01) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return Math.round(dt.getTime() / MS_PER_DAY);
}

function dayToStr(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  const books = new Map();   // bookId -> { status, loan, queue }
  const members = new Map(); // memberId -> { owed, loans, holds }
  let clock = null;          // day number or null
  let placeSeq = 0;

  // Removes the first hold of a book's queue from the queue and from its member.
  function popFirstHold(book) {
    const hold = book.queue.shift();
    const member = members.get(hold.memberId);
    const i = member.holds.indexOf(hold);
    if (i >= 0) member.holds.splice(i, 1);
    return hold;
  }

  // §5.2: a book stops being held on day S.
  function passToQueue(book, S) {
    if (book.queue.length === 0) {
      book.status = 'available';
      return;
    }
    book.status = 'readyForPickup';
    book.queue[0].readyUntil = S + PICKUP_DAYS;
  }

  // §5.3: process hold expirations strictly before day T.
  function processExpirations(T) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.status !== 'readyForPickup') continue;
        const first = book.queue[0];
        if (first.readyUntil < T) {
          const expiredUntil = first.readyUntil;
          popFirstHold(book);
          passToQueue(book, expiredUntil + 1);
          changed = true;
        }
      }
    }
  }

  // §3.5 steps 2 and 3. Returns false if the date is before the clock.
  function enter(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    processExpirations(day);
    return true;
  }

  function guard(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return FAIL('internal error');
      }
    };
  }

  function addBook(args) {
    if (!isObject(args) || !isId(args.bookId)) return FAIL('invalid bookId');
    const bookId = args.bookId;
    if (books.has(bookId)) return FAIL('book exists');
    books.set(bookId, { status: 'available', loan: null, queue: [] });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObject(args) || !isId(args.memberId)) return FAIL('invalid memberId');
    const memberId = args.memberId;
    if (members.has(memberId)) return FAIL('member exists');
    members.set(memberId, { owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObject(args)) return FAIL('invalid arguments');
    const { memberId, bookId, date } = args;
    if (!isId(memberId) || !isId(bookId)) return FAIL('invalid id');
    const day = parseDate(date);
    if (day === null) return FAIL('invalid date');
    if (!enter(day)) return FAIL('date before clock');

    const member = members.get(memberId);
    if (!member) return FAIL('no such member');
    const book = books.get(bookId);
    if (!book) return FAIL('no such book');

    if (member.owed >= BLOCK_THRESHOLD) return FAIL('member owes too much');
    if (book.status === 'onLoan') return FAIL('book on loan');
    if (book.status === 'readyForPickup') {
      if (book.queue[0].memberId !== memberId) return FAIL('set aside for another member');
    } else if (book.queue.length > 0) {
      return FAIL('inconsistent state');
    }

    if (book.status === 'readyForPickup') {
      popFirstHold(book);
    }

    const loan = { bookId, memberId, borrowDay: day, dueDay: day + LOAN_DAYS, renewals: 0 };
    book.status = 'onLoan';
    book.loan = loan;
    member.loans.push(loan);
    return { ok: true, dueDate: dayToStr(loan.dueDay) };
  }

  function returnBook(args) {
    if (!isObject(args)) return FAIL('invalid arguments');
    const { memberId, bookId, date } = args;
    if (!isId(memberId) || !isId(bookId)) return FAIL('invalid id');
    const day = parseDate(date);
    if (day === null) return FAIL('invalid date');
    if (!enter(day)) return FAIL('date before clock');

    const member = members.get(memberId);
    if (!member) return FAIL('no such member');
    const book = books.get(bookId);
    if (!book) return FAIL('no such book');
    if (book.status !== 'onLoan' || !book.loan || book.loan.memberId !== memberId) {
      return FAIL('book not on loan to this member');
    }

    const loan = book.loan;
    const late = day - loan.dueDay;
    const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;

    member.owed += fine;
    const li = member.loans.indexOf(loan);
    if (li >= 0) member.loans.splice(li, 1);
    book.loan = null;
    passToQueue(book, day);
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObject(args)) return FAIL('invalid arguments');
    const { memberId, bookId, date } = args;
    if (!isId(memberId) || !isId(bookId)) return FAIL('invalid id');
    const day = parseDate(date);
    if (day === null) return FAIL('invalid date');
    if (!enter(day)) return FAIL('date before clock');

    const member = members.get(memberId);
    if (!member) return FAIL('no such member');
    const book = books.get(bookId);
    if (!book) return FAIL('no such book');
    if (book.status !== 'onLoan' || !book.loan || book.loan.memberId !== memberId) {
      return FAIL('book not on loan to this member');
    }
    if (book.queue.length > 0) return FAIL('someone is waiting');

    const loan = book.loan;
    if (loan.renewals >= MAX_RENEWALS) return FAIL('renewal limit reached');
    if (day > loan.dueDay) return FAIL('loan is overdue');
    if (member.owed >= BLOCK_THRESHOLD) return FAIL('member owes too much');

    loan.dueDay += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: dayToStr(loan.dueDay) };
  }

  function placeHold(args) {
    if (!isObject(args)) return FAIL('invalid arguments');
    const { memberId, bookId, date } = args;
    if (!isId(memberId) || !isId(bookId)) return FAIL('invalid id');
    const day = parseDate(date);
    if (day === null) return FAIL('invalid date');
    if (!enter(day)) return FAIL('date before clock');

    const member = members.get(memberId);
    if (!member) return FAIL('no such member');
    const book = books.get(bookId);
    if (!book) return FAIL('no such book');

    if (book.status === 'available') return FAIL('book is available');
    if (book.status === 'onLoan' && book.loan.memberId === memberId) {
      return FAIL('member already has this book');
    }
    if (book.queue.some((h) => h.memberId === memberId)) {
      return FAIL('member already holds this book');
    }

    const hold = { memberId, bookId, placedOrder: ++placeSeq, readyUntil: null };
    book.queue.push(hold);
    member.holds.push(hold);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (!isObject(args)) return FAIL('invalid arguments');
    const { memberId, amount, date } = args;
    if (!isId(memberId)) return FAIL('invalid memberId');
    if (!Number.isInteger(amount) || amount <= 0) return FAIL('invalid amount');
    const day = parseDate(date);
    if (day === null) return FAIL('invalid date');
    if (!enter(day)) return FAIL('date before clock');

    const member = members.get(memberId);
    if (!member) return FAIL('no such member');
    if (amount > member.owed) return FAIL('amount exceeds owed');

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (!isObject(args)) return FAIL('invalid arguments');
    const { memberId, date } = args;
    if (!isId(memberId)) return FAIL('invalid memberId');
    const day = parseDate(date);
    if (day === null) return FAIL('invalid date');
    if (!enter(day)) return FAIL('date before clock');

    const member = members.get(memberId);
    if (!member) return FAIL('no such member');

    const loans = member.loans.map((l) => ({
      bookId: l.bookId,
      dueDate: dayToStr(l.dueDay),
    }));
    const holds = member.holds.map((h) => {
      const book = books.get(h.bookId);
      return {
        bookId: h.bookId,
        position: book.queue.indexOf(h) + 1,
        readyUntil: h.readyUntil === null ? null : dayToStr(h.readyUntil),
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
