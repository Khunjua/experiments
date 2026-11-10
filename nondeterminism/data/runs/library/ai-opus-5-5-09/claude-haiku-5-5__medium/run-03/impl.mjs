const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / MS_PER_DAY);
}

function formatDate(dayNumber) {
  return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
}

function isId(value) {
  return typeof value === 'string' && value.length > 0;
}

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let clock = null;
  let holdCounter = 0;
  let loanCounter = 0;

  const fail = (reason) => ({ ok: false, reason });

  function timeAllowed(day) {
    return clock === null || day >= clock;
  }

  // Gives a book (with no current loan) to the next hold starting on startDay,
  // or returns it to the shelf if the queue is empty.
  function applyPass(book, startDay) {
    if (book.queue.length === 0) {
      book.status = 'available';
    } else {
      book.status = 'readyForPickup';
      book.queue[0].readyUntil = startDay + PICKUP_DAYS;
    }
  }

  function processExpirations(T) {
    for (const book of books.values()) {
      while (
        book.status === 'readyForPickup' &&
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < T
      ) {
        const expired = book.queue.shift();
        applyPass(book, expired.readyUntil + 1);
      }
    }
  }

  function advanceClock(day) {
    clock = day;
    processExpirations(day);
  }

  function wrap(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return fail('internal error');
      }
    };
  }

  return {
    addBook: wrap((args) => {
      if (!isObj(args)) return fail('invalid arguments');
      const bookId = args.bookId;
      if (!isId(bookId)) return fail('invalid book id');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { status: 'available', loan: null, queue: [] });
      return { ok: true };
    }),

    addMember: wrap((args) => {
      if (!isObj(args)) return fail('invalid arguments');
      const memberId = args.memberId;
      if (!isId(memberId)) return fail('invalid member id');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    }),

    borrow: wrap((args) => {
      if (!isObj(args)) return fail('invalid arguments');
      const memberId = args.memberId;
      const bookId = args.bookId;
      const day = parseDate(args.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail('invalid arguments');
      if (!timeAllowed(day)) return fail('out of order');
      advanceClock(day);

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('no member');
      if (!book) return fail('no book');
      if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');
      if (book.status === 'onLoan') return fail('on loan');
      if (book.status === 'readyForPickup') {
        if (book.queue[0].memberId !== memberId) return fail('set aside for another member');
        book.queue.shift();
      } else if (book.queue.length > 0) {
        return fail('inconsistent state');
      }

      const dueDay = day + LOAN_DAYS;
      book.status = 'onLoan';
      book.loan = {
        bookId,
        memberId,
        borrowDay: day,
        dueDay,
        renewals: 0,
        seq: loanCounter++,
      };
      return { ok: true, dueDate: formatDate(dueDay) };
    }),

    returnBook: wrap((args) => {
      if (!isObj(args)) return fail('invalid arguments');
      const memberId = args.memberId;
      const bookId = args.bookId;
      const day = parseDate(args.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail('invalid arguments');
      if (!timeAllowed(day)) return fail('out of order');
      advanceClock(day);

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('no member');
      if (!book) return fail('no book');
      if (book.status !== 'onLoan' || book.loan.memberId !== memberId) {
        return fail('not on loan to member');
      }

      const daysLate = day - book.loan.dueDay;
      const fine = daysLate > 0 ? Math.min(daysLate * FINE_PER_DAY, FINE_CAP) : 0;
      member.owed += fine;
      book.loan = null;
      applyPass(book, day);
      return { ok: true, fine };
    }),

    renew: wrap((args) => {
      if (!isObj(args)) return fail('invalid arguments');
      const memberId = args.memberId;
      const bookId = args.bookId;
      const day = parseDate(args.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail('invalid arguments');
      if (!timeAllowed(day)) return fail('out of order');
      advanceClock(day);

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('no member');
      if (!book) return fail('no book');
      if (book.status !== 'onLoan' || book.loan.memberId !== memberId) {
        return fail('not on loan to member');
      }
      if (book.queue.length > 0) return fail('someone is waiting');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (day > book.loan.dueDay) return fail('loan is overdue');
      if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');

      book.loan.dueDay += LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDate(book.loan.dueDay) };
    }),

    placeHold: wrap((args) => {
      if (!isObj(args)) return fail('invalid arguments');
      const memberId = args.memberId;
      const bookId = args.bookId;
      const day = parseDate(args.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail('invalid arguments');
      if (!timeAllowed(day)) return fail('out of order');
      advanceClock(day);

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('no member');
      if (!book) return fail('no book');
      if (book.status === 'available') return fail('book is available');
      if (book.status === 'onLoan' && book.loan.memberId === memberId) {
        return fail('member has this book');
      }
      if (book.queue.some((h) => h.memberId === memberId)) {
        return fail('already holding this book');
      }

      book.queue.push({ memberId, placedOrder: holdCounter++, readyUntil: null });
      return { ok: true, position: book.queue.length };
    }),

    payFine: wrap((args) => {
      if (!isObj(args)) return fail('invalid arguments');
      const memberId = args.memberId;
      const amount = args.amount;
      const day = parseDate(args.date);
      if (!isId(memberId) || !Number.isInteger(amount) || amount <= 0 || day === null) {
        return fail('invalid arguments');
      }
      if (!timeAllowed(day)) return fail('out of order');
      advanceClock(day);

      const member = members.get(memberId);
      if (!member) return fail('no member');
      if (amount > member.owed) return fail('amount exceeds owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    }),

    getMember: wrap((args) => {
      if (!isObj(args)) return fail('invalid arguments');
      const memberId = args.memberId;
      const day = parseDate(args.date);
      if (!isId(memberId) || day === null) return fail('invalid arguments');
      if (!timeAllowed(day)) return fail('out of order');
      advanceClock(day);

      const member = members.get(memberId);
      if (!member) return fail('no member');

      const loans = [];
      for (const book of books.values()) {
        if (book.status === 'onLoan' && book.loan.memberId === memberId) {
          loans.push(book.loan);
        }
      }
      loans.sort((a, b) => a.borrowDay - b.borrowDay || a.seq - b.seq);

      const holds = [];
      for (const [bookId, book] of books) {
        book.queue.forEach((hold, index) => {
          if (hold.memberId === memberId) {
            holds.push({
              placedOrder: hold.placedOrder,
              bookId,
              position: index + 1,
              readyUntil: hold.readyUntil,
            });
          }
        });
      }
      holds.sort((a, b) => a.placedOrder - b.placedOrder);

      return {
        loans: loans.map((loan) => ({
          bookId: loan.bookId,
          dueDate: formatDate(loan.dueDay),
        })),
        owed: member.owed,
        holds: holds.map((hold) => ({
          bookId: hold.bookId,
          position: hold.position,
          readyUntil: hold.readyUntil === null ? null : formatDate(hold.readyUntil),
        })),
      };
    }),
  };
}
