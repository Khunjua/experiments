const DAY = 86400000;
function toNum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY;
}
function toStr(n) {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const fail = (reason) => ({ ok: false, reason });

  function expire(dn) {
    for (const b of books.values()) {
      while (b.setAside && b.setAside.readyUntil < dn) {
        b.holds.shift();
        if (b.holds.length) {
          b.setAside = { memberId: b.holds[0], readyUntil: b.setAside.readyUntil + 3 };
        } else {
          b.setAside = null;
        }
      }
    }
  }

  function loanCount(memberId) {
    let c = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) c++;
    return c;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, holds: [], setAside: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const dn = toNum(date);
      if (dn === null) return fail('date');
      expire(dn);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.owed >= 1000) return fail('owes');
      if (loanCount(memberId) >= 5) return fail('limit');
      if (b.setAside) {
        if (b.setAside.memberId !== memberId) return fail('set aside');
        b.holds.shift();
        b.setAside = null;
      }
      b.loan = { memberId, dueDate: dn + 21, renewals: 0 };
      return { ok: true, dueDate: toStr(dn + 21) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const dn = toNum(date);
      if (dn === null) return fail('date');
      expire(dn);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = dn - b.loan.dueDate;
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length) b.setAside = { memberId: b.holds[0], readyUntil: dn + 3 };
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const dn = toNum(date);
      if (dn === null) return fail('date');
      expire(dn);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      if (dn > b.loan.dueDate) return fail('overdue');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length) return fail('held');
      b.loan.renewals++;
      b.loan.dueDate += 21;
      return { ok: true, dueDate: toStr(b.loan.dueDate) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const dn = toNum(date);
      if (dn === null) return fail('date');
      expire(dn);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.setAside) return fail('on shelf');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const dn = toNum(date);
      if (dn === null) return fail('date');
      expire(dn);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const dn = toNum(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (dn !== null) expire(dn);
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: toStr(b.loan.dueDate) });
        }
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          const ready = b.setAside && b.setAside.memberId === memberId;
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: ready ? toStr(b.setAside.readyUntil) : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
