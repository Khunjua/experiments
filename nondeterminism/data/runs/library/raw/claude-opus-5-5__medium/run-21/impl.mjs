const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE_PER_LOAN = 1000;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDay(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function fromDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, queue: [memberId], readyUntil: day|null }
  const members = new Map(); // memberId -> { owed, loans: [bookId], holds: [bookId] }

  function removeHold(member, memberId, bookId) {
    const b = books.get(bookId);
    b.queue = b.queue.filter((x) => x !== memberId);
    member.holds = member.holds.filter((x) => x !== bookId);
  }

  // Expire set-aside holds whose pickup window has passed; pass the book on.
  function process(today) {
    for (const [bookId, b] of books) {
      while (b.loan === null && b.readyUntil !== null && today > b.readyUntil) {
        const expiredId = b.queue.shift();
        const em = members.get(expiredId);
        em.holds = em.holds.filter((x) => x !== bookId);
        if (b.queue.length > 0) {
          b.readyUntil = b.readyUntil + PICKUP_DAYS;
        } else {
          b.readyUntil = null;
        }
      }
    }
  }

  function prep(memberId, bookId, date, needBook = true) {
    const today = toDay(date);
    if (today === null) return { err: fail('invalid date') };
    process(today);
    const member = members.get(memberId);
    if (!member) return { err: fail('unknown member') };
    let book = null;
    if (needBook) {
      book = books.get(bookId);
      if (!book) return { err: fail('unknown book') };
    }
    return { today, member, book };
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid id');
      if (books.has(bookId)) return fail('duplicate');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid id');
      if (members.has(memberId)) return fail('duplicate');
      members.set(memberId, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return p.err;
      const { today, member, book } = p;
      if (book.loan) return fail('on loan');
      if (book.readyUntil !== null && book.queue[0] !== memberId) return fail('set aside for another member');
      if (member.loans.length >= MAX_LOANS) return fail('loan limit');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      if (book.readyUntil !== null) {
        removeHold(member, memberId, bookId);
        book.readyUntil = null;
      }
      const due = today + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      member.loans.push(bookId);
      return { ok: true, dueDate: fromDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return p.err;
      const { today, member, book } = p;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
      const late = today - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      member.loans = member.loans.filter((x) => x !== bookId);
      book.loan = null;
      if (book.queue.length > 0) book.readyUntil = today + PICKUP_DAYS - 1;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return p.err;
      const { today, book } = p;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.queue.length > 0) return fail('others waiting');
      if (today > book.loan.due) return fail('overdue');
      book.loan.due += LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: fromDay(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return p.err;
      const { member, book } = p;
      if (!book.loan && book.readyUntil === null) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
      if (book.queue.includes(memberId)) return fail('already holding');
      book.queue.push(memberId);
      member.holds.push(bookId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const p = prep(memberId, null, date, false);
      if (p.err) return p.err;
      const { member } = p;
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const p = prep(memberId, null, date, false);
      if (p.err) return p.err;
      const { member } = p;
      return {
        ok: true,
        loans: member.loans.map((bookId) => ({ bookId, dueDate: fromDay(books.get(bookId).loan.due) })),
        owed: member.owed,
        holds: member.holds.map((bookId) => {
          const b = books.get(bookId);
          const position = b.queue.indexOf(memberId) + 1;
          const ready = position === 1 && !b.loan && b.readyUntil !== null;
          return { bookId, position, readyUntil: ready ? fromDay(b.readyUntil) : null };
        }),
      };
    },
  };
}
