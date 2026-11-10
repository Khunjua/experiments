const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

// Returns the day number (days since 1970-01-01) for a valid 'YYYY-MM-DD' string, or null.
function toDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / MS_PER_DAY);
}

// Converts a day number back to 'YYYY-MM-DD'.
function fmt(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isObj(x) {
  return x !== null && typeof x === 'object';
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let clock = null;      // day number of the most recent accepted dated call
  let holdCounter = 0;
  let loanCounter = 0;

  const fail = (reason) => ({ ok: false, reason });

  // Sets the book's status after it stops being held by someone, starting on day S.
  function passToQueue(book, S) {
    book.loan = null;
    if (book.queue.length === 0) {
      book.status = 'available';
    } else {
      book.status = 'readyForPickup';
      book.queue[0].readyUntil = S + PICKUP_DAYS;
    }
  }

  // Removes the first hold of a book's queue from the queue and from its member's holds.
  function removeFirstHold(book) {
    const hold = book.queue.shift();
    const m = members.get(hold.memberId);
    const i = m.holds.indexOf(hold);
    if (i >= 0) m.holds.splice(i, 1);
    return hold;
  }

  // Processes hold expirations up to day T (§5.3).
  function expire(T) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.status !== 'readyForPickup') continue;
        const hold = book.queue[0];
        if (hold.readyUntil < T) {
          removeFirstHold(book);
          passToQueue(book, hold.readyUntil + 1);
          changed = true;
        }
      }
    }
  }

  // Advances the clock to day. Returns false if day is earlier than the clock.
  function tick(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    expire(day);
    return true;
  }

  function addBook(args) {
    if (!isObj(args) || !validId(args.bookId)) return fail('invalid bookId');
    if (books.has(args.bookId)) return fail('book exists');
    books.set(args.bookId, { id: args.bookId, status: 'available', loan: null, queue: [] });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !validId(args.memberId)) return fail('invalid memberId');
    if (members.has(args.memberId)) return fail('member exists');
    members.set(args.memberId, { id: args.memberId, owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObj(args)) return fail('invalid arguments');
    const { memberId, bookId } = args;
    const day = toDay(args.date);
    if (!validId(memberId) || !validId(bookId) || day === null) return fail('invalid arguments');
    if (!tick(day)) return fail('time order');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('no member');
    if (!book) return fail('no book');
    if (member.owed >= BLOCK_THRESHOLD) return fail('blocked by fines');
    if (book.status === 'onLoan') return fail('on loan');

    let readyForThisMember = false;
    if (book.status === 'readyForPickup') {
      if (book.queue[0].memberId !== memberId) return fail('set aside for another member');
      readyForThisMember = true;
    } else if (book.queue.length > 0) {
      return fail('inconsistent queue');
    }

    if (readyForThisMember) removeFirstHold(book);

    const loan = {
      memberId,
      bookId,
      borrowDay: day,
      dueDay: day + LOAN_DAYS,
      renewals: 0,
      seq: ++loanCounter,
    };
    book.status = 'onLoan';
    book.loan = loan;
    member.loans.push(loan);
    return { ok: true, dueDate: fmt(loan.dueDay) };
  }

  function returnBook(args) {
    if (!isObj(args)) return fail('invalid arguments');
    const { memberId, bookId } = args;
    const day = toDay(args.date);
    if (!validId(memberId) || !validId(bookId) || day === null) return fail('invalid arguments');
    if (!tick(day)) return fail('time order');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('no member');
    if (!book) return fail('no book');
    const loan = book.loan;
    if (book.status !== 'onLoan' || !loan || loan.memberId !== memberId) return fail('not on loan to member');

    const late = day - loan.dueDay;
    const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
    member.owed += fine;
    const li = member.loans.indexOf(loan);
    if (li >= 0) member.loans.splice(li, 1);
    passToQueue(book, day);
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObj(args)) return fail('invalid arguments');
    const { memberId, bookId } = args;
    const day = toDay(args.date);
    if (!validId(memberId) || !validId(bookId) || day === null) return fail('invalid arguments');
    if (!tick(day)) return fail('time order');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('no member');
    if (!book) return fail('no book');
    const loan = book.loan;
    if (book.status !== 'onLoan' || !loan || loan.memberId !== memberId) return fail('not on loan to member');
    if (book.queue.length > 0) return fail('someone is waiting');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (day > loan.dueDay) return fail('overdue');
    if (member.owed >= BLOCK_THRESHOLD) return fail('blocked by fines');

    loan.dueDay += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: fmt(loan.dueDay) };
  }

  function placeHold(args) {
    if (!isObj(args)) return fail('invalid arguments');
    const { memberId, bookId } = args;
    const day = toDay(args.date);
    if (!validId(memberId) || !validId(bookId) || day === null) return fail('invalid arguments');
    if (!tick(day)) return fail('time order');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('no member');
    if (!book) return fail('no book');
    if (book.status === 'available') return fail('available; borrow instead');
    if (book.status === 'onLoan' && book.loan.memberId === memberId) return fail('already on loan to member');
    if (book.queue.some((h) => h.memberId === memberId)) return fail('already holds this book');

    const hold = { memberId, bookId, order: ++holdCounter, readyUntil: null };
    book.queue.push(hold);
    member.holds.push(hold);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (!isObj(args)) return fail('invalid arguments');
    const { memberId, amount } = args;
    const day = toDay(args.date);
    if (!validId(memberId) || day === null || !Number.isInteger(amount) || amount <= 0) {
      return fail('invalid arguments');
    }
    if (!tick(day)) return fail('time order');

    const member = members.get(memberId);
    if (!member) return fail('no member');
    if (amount > member.owed) return fail('amount exceeds owed');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (!isObj(args)) return fail('invalid arguments');
    const { memberId } = args;
    const day = toDay(args.date);
    if (!validId(memberId) || day === null) return fail('invalid arguments');
    if (!tick(day)) return fail('time order');

    const member = members.get(memberId);
    if (!member) return fail('no member');

    const loans = member.loans
      .slice()
      .sort((a, b) => (a.borrowDay - b.borrowDay) || (a.seq - b.seq))
      .map((l) => ({ bookId: l.bookId, dueDate: fmt(l.dueDay) }));

    const holds = member.holds
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((h) => {
        const book = books.get(h.bookId);
        return {
          bookId: h.bookId,
          position: book.queue.indexOf(h) + 1,
          readyUntil: h.readyUntil === null ? null : fmt(h.readyUntil),
        };
      });

    return { loans, owed: member.owed, holds };
  }

  // Guard every method so that no input can make it throw.
  const guard = (fn) => (args) => {
    try {
      return fn(args);
    } catch {
      return fail('internal error');
    }
  };

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
