const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 1000;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const PICKUP_GAP = 8; // next window starts the day after the previous one ends
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

const MAX_DAY = parseDate('9999-12-31');

function clampDay(n) {
  return n > MAX_DAY ? MAX_DAY : n;
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function removeId(list, id) {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

function guard(fn) {
  try {
    return fn();
  } catch (e) {
    return { ok: false, reason: 'internal error' };
  }
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDay, renewals }, queue: [{ memberId, readyDay }] }
  // readyDay is non-null only for the head of a set-aside book.
  const books = new Map();
  // memberId -> { loans: [bookId] (borrow order), holds: [bookId] (placement order), owed }
  const members = new Map();
  let clock = null;

  const fail = (reason) => ({ ok: false, reason });

  function advance(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    for (const [bookId, book] of books) {
      while (book.loan === null && book.queue.length > 0) {
        const head = book.queue[0];
        if (head.readyDay === null || clock <= head.readyDay) break;
        book.queue.shift();
        removeId(members.get(head.memberId).holds, bookId);
        if (book.queue.length > 0) {
          book.queue[0].readyDay = clampDay(head.readyDay + PICKUP_GAP);
        }
      }
    }
    return true;
  }

  return {
    addBook(input) {
      return guard(() => {
        if (!isObj(input)) return fail('bad input');
        const bookId = input.bookId;
        if (!isId(bookId)) return fail('bad bookId');
        if (books.has(bookId)) return fail('book exists');
        books.set(bookId, { loan: null, queue: [] });
        return { ok: true };
      });
    },

    addMember(input) {
      return guard(() => {
        if (!isObj(input)) return fail('bad input');
        const memberId = input.memberId;
        if (!isId(memberId)) return fail('bad memberId');
        if (members.has(memberId)) return fail('member exists');
        members.set(memberId, { loans: [], holds: [], owed: 0 });
        return { ok: true };
      });
    },

    borrow(input) {
      return guard(() => {
        if (!isObj(input)) return fail('bad input');
        const { memberId, bookId, date } = input;
        if (!isId(memberId) || !isId(bookId)) return fail('bad id');
        const day = parseDate(date);
        if (day === null) return fail('bad date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('unknown member or book');
        if (book.loan !== null) return fail('on loan');
        if (book.queue.length > 0 && book.queue[0].memberId !== memberId) {
          return fail('set aside for another member');
        }
        if (member.loans.length >= MAX_LOANS) return fail('loan limit');
        if (member.owed >= BORROW_BLOCK_OWED) return fail('owed too much');

        if (book.queue.length > 0) {
          book.queue.shift();
          removeId(member.holds, bookId);
        }
        const dueDay = clampDay(day + LOAN_DAYS);
        book.loan = { memberId, dueDay, renewals: 0 };
        member.loans.push(bookId);
        return { ok: true, dueDate: formatDay(dueDay) };
      });
    },

    renew(input) {
      return guard(() => {
        if (!isObj(input)) return fail('bad input');
        const { memberId, bookId, date } = input;
        if (!isId(memberId) || !isId(bookId)) return fail('bad id');
        const day = parseDate(date);
        if (day === null) return fail('bad date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('unknown member or book');
        const loan = book.loan;
        if (loan === null || loan.memberId !== memberId) return fail('not on loan to member');
        if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
        if (book.queue.length > 0) return fail('book has holds');
        if (day > loan.dueDay) return fail('overdue');
        const newDue = clampDay(day + LOAN_DAYS);
        if (newDue <= loan.dueDay) return fail('does not extend loan');

        loan.dueDay = newDue;
        loan.renewals += 1;
        return { ok: true, dueDate: formatDay(newDue) };
      });
    },

    returnBook(input) {
      return guard(() => {
        if (!isObj(input)) return fail('bad input');
        const { memberId, bookId, date } = input;
        if (!isId(memberId) || !isId(bookId)) return fail('bad id');
        const day = parseDate(date);
        if (day === null) return fail('bad date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('unknown member or book');
        const loan = book.loan;
        if (loan === null || loan.memberId !== memberId) return fail('not on loan to member');

        const daysLate = day - loan.dueDay;
        const chargeable = Math.max(0, daysLate - GRACE_DAYS);
        const fine = Math.min(FINE_PER_DAY * chargeable, MAX_FINE);

        book.loan = null;
        removeId(member.loans, bookId);
        member.owed += fine;
        if (book.queue.length > 0) {
          book.queue[0].readyDay = clampDay(day + PICKUP_DAYS);
        }
        return { ok: true, fine };
      });
    },

    placeHold(input) {
      return guard(() => {
        if (!isObj(input)) return fail('bad input');
        const { memberId, bookId, date } = input;
        if (!isId(memberId) || !isId(bookId)) return fail('bad id');
        const day = parseDate(date);
        if (day === null) return fail('bad date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail('unknown member or book');
        if (book.loan === null && book.queue.length === 0) return fail('book is available');
        if (book.loan !== null && book.loan.memberId === memberId) return fail('member has this book');
        if (book.queue.some((h) => h.memberId === memberId)) return fail('already held');

        book.queue.push({ memberId, readyDay: null });
        member.holds.push(bookId);
        return { ok: true, position: book.queue.length };
      });
    },

    payFine(input) {
      return guard(() => {
        if (!isObj(input)) return fail('bad input');
        const { memberId, amount, date } = input;
        if (!isId(memberId)) return fail('bad memberId');
        if (!Number.isSafeInteger(amount) || amount <= 0) return fail('bad amount');
        const day = parseDate(date);
        if (day === null) return fail('bad date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        if (!member) return fail('unknown member');
        if (amount > member.owed) return fail('overpayment');

        member.owed -= amount;
        return { ok: true, owed: member.owed };
      });
    },

    getMember(input) {
      return guard(() => {
        if (!isObj(input)) return fail('bad input');
        const { memberId, date } = input;
        if (!isId(memberId)) return fail('bad memberId');
        const day = parseDate(date);
        if (day === null) return fail('bad date');
        if (!advance(day)) return fail('date before clock');

        const member = members.get(memberId);
        if (!member) return fail('unknown member');

        const loans = member.loans.map((bookId) => ({
          bookId,
          dueDate: formatDay(books.get(bookId).loan.dueDay),
        }));

        const holds = member.holds.map((bookId) => {
          const book = books.get(bookId);
          const idx = book.queue.findIndex((h) => h.memberId === memberId);
          const h = book.queue[idx];
          const setAside = idx === 0 && book.loan === null && h.readyDay !== null;
          return {
            bookId,
            position: idx + 1,
            readyUntil: setAside ? formatDay(h.readyDay) : null,
          };
        });

        return { ok: true, loans, owed: member.owed, holds };
      });
    },
  };
}
