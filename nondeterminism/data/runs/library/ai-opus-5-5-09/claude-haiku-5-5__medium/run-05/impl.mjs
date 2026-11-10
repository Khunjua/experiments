const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

const fail = (reason) => ({ ok: false, reason });
const isObj = (a) => a !== null && typeof a === 'object';
const validId = (v) => typeof v === 'string' && v.length > 0;

// Returns integer day number (days since 1970-01-01 UTC) or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.getTime() / DAY_MS;
}

function formatDay(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let clock = null; // day number of the most recent accepted dated call
  let orderCounter = 0;

  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      return fail('internal error');
    }
  }

  // Sets the clock and processes hold expirations. Returns false if time goes backwards.
  function tick(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    expire(day);
    return true;
  }

  // Apply section 5.2: a book stops being held and goes to the queue or the shelf.
  function release(book, S) {
    if (book.queue.length === 0) {
      book.status = 'available';
      return;
    }
    book.status = 'readyForPickup';
    book.queue[0].readyUntil = formatDay(S + PICKUP_DAYS);
  }

  // Section 5.3: process hold expirations up to day T, repeating until nothing changes.
  function expire(day) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.status !== 'readyForPickup') continue;
        const hold = book.queue[0];
        const readyDay = parseDay(hold.readyUntil);
        if (readyDay < day) {
          book.queue.shift();
          const m = members.get(hold.memberId);
          if (m) m.holds = m.holds.filter((h) => h !== hold);
          release(book, readyDay + 1);
          changed = true;
        }
      }
    }
  }

  return {
    addBook(args) {
      return safe(() => {
        if (!isObj(args) || !validId(args.bookId)) return fail('invalid bookId');
        if (books.has(args.bookId)) return fail('book exists');
        books.set(args.bookId, { id: args.bookId, status: 'available', loan: null, queue: [] });
        return { ok: true };
      });
    },

    addMember(args) {
      return safe(() => {
        if (!isObj(args) || !validId(args.memberId)) return fail('invalid memberId');
        if (members.has(args.memberId)) return fail('member exists');
        members.set(args.memberId, { id: args.memberId, owed: 0, loans: [], holds: [] });
        return { ok: true };
      });
    },

    borrow(args) {
      return safe(() => {
        if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) {
          return fail('invalid arguments');
        }
        const day = parseDay(args.date);
        if (day === null) return fail('invalid date');
        if (!tick(day)) return fail('date before clock');

        const member = members.get(args.memberId);
        const book = books.get(args.bookId);
        if (!member) return fail('no such member');
        if (!book) return fail('no such book');
        if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');
        if (book.status === 'onLoan') return fail('on loan');

        let readyHold = null;
        if (book.status === 'readyForPickup') {
          if (book.queue[0].memberId !== member.id) return fail('set aside for another member');
          readyHold = book.queue[0];
        } else if (book.queue.length > 0) {
          return fail('inconsistent state');
        }

        if (readyHold) {
          book.queue.shift();
          member.holds = member.holds.filter((h) => h !== readyHold);
        }

        const loan = {
          bookId: book.id,
          memberId: member.id,
          borrowDay: day,
          dueDate: formatDay(day + LOAN_DAYS),
          renewals: 0,
        };
        member.loans.push(loan);
        book.loan = loan;
        book.status = 'onLoan';
        return { ok: true, dueDate: loan.dueDate };
      });
    },

    returnBook(args) {
      return safe(() => {
        if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) {
          return fail('invalid arguments');
        }
        const day = parseDay(args.date);
        if (day === null) return fail('invalid date');
        if (!tick(day)) return fail('date before clock');

        const member = members.get(args.memberId);
        const book = books.get(args.bookId);
        if (!member) return fail('no such member');
        if (!book) return fail('no such book');
        if (book.status !== 'onLoan' || !book.loan || book.loan.memberId !== member.id) {
          return fail('not on loan to this member');
        }

        const loan = book.loan;
        const daysLate = day - parseDay(loan.dueDate);
        const fine = daysLate > 0 ? Math.min(daysLate * FINE_PER_DAY, FINE_CAP) : 0;

        member.owed += fine;
        member.loans = member.loans.filter((l) => l !== loan);
        book.loan = null;
        release(book, day);
        return { ok: true, fine };
      });
    },

    renew(args) {
      return safe(() => {
        if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) {
          return fail('invalid arguments');
        }
        const day = parseDay(args.date);
        if (day === null) return fail('invalid date');
        if (!tick(day)) return fail('date before clock');

        const member = members.get(args.memberId);
        const book = books.get(args.bookId);
        if (!member) return fail('no such member');
        if (!book) return fail('no such book');
        if (book.status !== 'onLoan' || !book.loan || book.loan.memberId !== member.id) {
          return fail('not on loan to this member');
        }
        if (book.queue.length > 0) return fail('someone is waiting');

        const loan = book.loan;
        if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
        const dueDay = parseDay(loan.dueDate);
        if (day > dueDay) return fail('loan is overdue');
        if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');

        loan.dueDate = formatDay(dueDay + LOAN_DAYS);
        loan.renewals += 1;
        return { ok: true, dueDate: loan.dueDate };
      });
    },

    placeHold(args) {
      return safe(() => {
        if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) {
          return fail('invalid arguments');
        }
        const day = parseDay(args.date);
        if (day === null) return fail('invalid date');
        if (!tick(day)) return fail('date before clock');

        const member = members.get(args.memberId);
        const book = books.get(args.bookId);
        if (!member) return fail('no such member');
        if (!book) return fail('no such book');
        if (book.status === 'available') return fail('available; borrow instead');
        if (book.loan && book.loan.memberId === member.id) return fail('already on loan to member');
        if (book.queue.some((h) => h.memberId === member.id)) return fail('already holding');

        const hold = {
          bookId: book.id,
          memberId: member.id,
          placedOrder: ++orderCounter,
          readyUntil: null,
        };
        book.queue.push(hold);
        member.holds.push(hold);
        return { ok: true, position: book.queue.length };
      });
    },

    payFine(args) {
      return safe(() => {
        if (
          !isObj(args) ||
          !validId(args.memberId) ||
          !Number.isInteger(args.amount) ||
          args.amount <= 0
        ) {
          return fail('invalid arguments');
        }
        const day = parseDay(args.date);
        if (day === null) return fail('invalid date');
        if (!tick(day)) return fail('date before clock');

        const member = members.get(args.memberId);
        if (!member) return fail('no such member');
        if (args.amount > member.owed) return fail('amount exceeds owed');

        member.owed -= args.amount;
        return { ok: true, owed: member.owed };
      });
    },

    getMember(args) {
      return safe(() => {
        if (!isObj(args) || !validId(args.memberId)) return fail('invalid arguments');
        const day = parseDay(args.date);
        if (day === null) return fail('invalid date');
        if (!tick(day)) return fail('date before clock');

        const member = members.get(args.memberId);
        if (!member) return fail('no such member');

        const holds = member.holds
          .slice()
          .sort((a, b) => a.placedOrder - b.placedOrder)
          .map((h) => {
            const book = books.get(h.bookId);
            const idx = book ? book.queue.indexOf(h) : -1;
            return {
              bookId: h.bookId,
              position: idx + 1,
              readyUntil: h.readyUntil === null ? null : h.readyUntil,
            };
          });

        return {
          loans: member.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
          owed: member.owed,
          holds,
        };
      });
    },
  };
}
