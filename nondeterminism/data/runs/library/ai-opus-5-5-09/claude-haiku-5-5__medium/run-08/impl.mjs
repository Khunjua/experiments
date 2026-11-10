const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

// Returns the day number (integer days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
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

function toStr(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

function isObj(a) {
  return a !== null && typeof a === 'object';
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let clock = null;
  let holdCounter = 0;

  const fail = (reason) => ({ ok: false, reason });

  function removeHoldFromMember(hold) {
    const member = members.get(hold.memberId);
    if (!member) return;
    const i = member.holds.indexOf(hold);
    if (i >= 0) member.holds.splice(i, 1);
  }

  // Section 5.2: a book stops being held starting on day `start`.
  function passToQueue(book, start) {
    book.loan = null;
    if (book.queue.length === 0) {
      book.status = 'available';
    } else {
      book.status = 'readyForPickup';
      book.queue[0].readyUntil = start + PICKUP_DAYS;
    }
  }

  // Section 5.3: expire ready holds whose readyUntil is before `today`.
  function expire(today) {
    for (const book of books.values()) {
      while (book.status === 'readyForPickup' && book.queue[0].readyUntil < today) {
        const hold = book.queue.shift();
        removeHoldFromMember(hold);
        passToQueue(book, hold.readyUntil + 1);
      }
    }
  }

  // Section 3.5 steps 2 and 3. Returns false if the date is before the clock.
  function advance(date) {
    if (clock !== null && date < clock) return false;
    clock = date;
    expire(date);
    return true;
  }

  return {
    addBook(args) {
      try {
        if (!isObj(args)) return fail('invalid arguments');
        const bookId = args.bookId;
        if (!validId(bookId)) return fail('invalid bookId');
        if (books.has(bookId)) return fail('book exists');
        books.set(bookId, { status: 'available', loan: null, queue: [] });
        return { ok: true };
      } catch {
        return fail('error');
      }
    },

    addMember(args) {
      try {
        if (!isObj(args)) return fail('invalid arguments');
        const memberId = args.memberId;
        if (!validId(memberId)) return fail('invalid memberId');
        if (members.has(memberId)) return fail('member exists');
        members.set(memberId, { owed: 0, loans: [], holds: [] });
        return { ok: true };
      } catch {
        return fail('error');
      }
    },

    borrow(args) {
      try {
        if (!isObj(args)) return fail('invalid arguments');
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return fail('invalid id');
        const date = parseDate(args.date);
        if (date === null) return fail('invalid date');
        if (!advance(date)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('not found');
        if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');
        if (book.status === 'onLoan') return fail('on loan');

        if (book.status === 'readyForPickup') {
          if (book.queue[0].memberId !== memberId) return fail('set aside for another member');
        } else if (book.queue.length > 0) {
          return fail('available with waiting holds');
        }

        if (book.status === 'readyForPickup') {
          const hold = book.queue.shift();
          removeHoldFromMember(hold);
        }

        const loan = {
          bookId,
          memberId,
          borrowDate: date,
          dueDate: date + LOAN_DAYS,
          renewals: 0,
        };
        book.status = 'onLoan';
        book.loan = loan;
        member.loans.push(loan);
        return { ok: true, dueDate: toStr(loan.dueDate) };
      } catch {
        return fail('error');
      }
    },

    returnBook(args) {
      try {
        if (!isObj(args)) return fail('invalid arguments');
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return fail('invalid id');
        const date = parseDate(args.date);
        if (date === null) return fail('invalid date');
        if (!advance(date)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('not found');
        if (book.status !== 'onLoan' || !book.loan || book.loan.memberId !== memberId) {
          return fail('not on loan to this member');
        }

        const loan = book.loan;
        const daysLate = date - loan.dueDate;
        const fine = daysLate > 0 ? Math.min(daysLate * FINE_PER_DAY, FINE_CAP) : 0;
        member.owed += fine;

        const i = member.loans.indexOf(loan);
        if (i >= 0) member.loans.splice(i, 1);

        passToQueue(book, date);
        return { ok: true, fine };
      } catch {
        return fail('error');
      }
    },

    renew(args) {
      try {
        if (!isObj(args)) return fail('invalid arguments');
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return fail('invalid id');
        const date = parseDate(args.date);
        if (date === null) return fail('invalid date');
        if (!advance(date)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('not found');
        if (book.status !== 'onLoan' || !book.loan || book.loan.memberId !== memberId) {
          return fail('not on loan to this member');
        }
        if (book.queue.length > 0) return fail('someone is waiting');

        const loan = book.loan;
        if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
        if (date > loan.dueDate) return fail('overdue');
        if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');

        loan.dueDate = loan.dueDate + LOAN_DAYS;
        loan.renewals += 1;
        return { ok: true, dueDate: toStr(loan.dueDate) };
      } catch {
        return fail('error');
      }
    },

    placeHold(args) {
      try {
        if (!isObj(args)) return fail('invalid arguments');
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return fail('invalid id');
        const date = parseDate(args.date);
        if (date === null) return fail('invalid date');
        if (!advance(date)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('not found');
        if (book.status === 'available') return fail('available; borrow instead');
        if (book.status === 'onLoan' && book.loan && book.loan.memberId === memberId) {
          return fail('already on loan to this member');
        }
        if (book.queue.some((h) => h.memberId === memberId)) {
          return fail('hold exists');
        }

        const hold = {
          bookId,
          memberId,
          placedOrder: ++holdCounter,
          readyUntil: null,
        };
        book.queue.push(hold);
        member.holds.push(hold);
        return { ok: true, position: book.queue.length };
      } catch {
        return fail('error');
      }
    },

    payFine(args) {
      try {
        if (!isObj(args)) return fail('invalid arguments');
        const memberId = args.memberId;
        if (!validId(memberId)) return fail('invalid memberId');
        const amount = args.amount;
        if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
        const date = parseDate(args.date);
        if (date === null) return fail('invalid date');
        if (!advance(date)) return fail('date before clock');

        const member = members.get(memberId);
        if (!member) return fail('not found');
        if (amount > member.owed) return fail('amount exceeds owed');

        member.owed -= amount;
        return { ok: true, owed: member.owed };
      } catch {
        return fail('error');
      }
    },

    getMember(args) {
      try {
        if (!isObj(args)) return fail('invalid arguments');
        const memberId = args.memberId;
        if (!validId(memberId)) return fail('invalid memberId');
        const date = parseDate(args.date);
        if (date === null) return fail('invalid date');
        if (!advance(date)) return fail('date before clock');

        const member = members.get(memberId);
        if (!member) return fail('not found');

        const holds = member.holds
          .slice()
          .sort((a, b) => a.placedOrder - b.placedOrder)
          .map((h) => ({
            bookId: h.bookId,
            position: books.get(h.bookId).queue.indexOf(h) + 1,
            readyUntil: h.readyUntil === null ? null : toStr(h.readyUntil),
          }));

        return {
          loans: member.loans.map((l) => ({
            bookId: l.bookId,
            dueDate: toStr(l.dueDate),
          })),
          owed: member.owed,
          holds,
        };
      } catch {
        return fail('error');
      }
    },
  };
}
