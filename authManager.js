const crypto = require('crypto');
const db = require('./database');

// Jelszó hashelés PBKDF2 segítségével
function hashPassword(password, salt) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function sanitizeAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    avatarColor: account.avatarColor || '#7655F5',
    avatarUrl: account.avatarUrl || null,
    createdAt: account.createdAt
  };
}

module.exports = {
  // 1. Regisztráció
  register({ username, password, avatarColor, avatarUrl }) {
    const cleanUsername = (username || '').trim();
    if (!cleanUsername || cleanUsername.length < 2 || cleanUsername.length > 24) {
      return { success: false, error: 'A felhasználónév 2 és 24 karakter közötti legyen!' };
    }
    if (!password || password.length < 4) {
      return { success: false, error: 'A jelszó legalább 4 karakter hosszú legyen!' };
    }

    // Foglaltság ellenőrzése SQLite-ban
    const existing = db.getAccountByUsername(cleanUsername);
    if (existing) {
      return { success: false, error: 'Ez a felhasználónév már foglalt!' };
    }

    const { hash, salt } = hashPassword(password);
    const newAccount = {
      id: `acc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      username: cleanUsername,
      passwordHash: hash,
      salt,
      avatarColor: avatarColor || '#7655F5',
      avatarUrl: avatarUrl || null,
      createdAt: Date.now()
    };

    const created = db.createAccount(newAccount);
    const token = crypto.randomBytes(32).toString('hex');
    db.saveAuthToken(token, created.id);
    console.log(`[SQLite Auth] Új fiók regisztrálva: ${created.username} (${created.id})`);
    return { success: true, user: sanitizeAccount(created), token };
  },

  // 2. Bejelentkezés
  login({ username, password }) {
    const cleanUsername = (username || '').trim();
    if (!cleanUsername || !password) {
      return { success: false, error: 'Kérlek add meg a felhasználónevet és jelszót!' };
    }

    const account = db.getAccountByUsername(cleanUsername);
    if (!account) {
      return { success: false, error: 'Nem létezik felhasználó ezzel a névvel!' };
    }

    const { hash } = hashPassword(password, account.salt);
    if (hash !== account.passwordHash) {
      return { success: false, error: 'Helytelen jelszó!' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    db.saveAuthToken(token, account.id);
    console.log(`[SQLite Auth] Sikeres bejelentkezés: ${account.username} (${account.id})`);
    return { success: true, user: sanitizeAccount(account), token };
  },

  // 2B. Automatikus bejelentkezés Tokennel
  verifyToken(token) {
    if (!token) return { success: false, error: 'Hiányzó token!' };
    const account = db.getAccountByToken(token);
    if (!account) {
      return { success: false, error: 'Érvénytelen vagy lejárt munkamenet token!' };
    }
    console.log(`[SQLite Auth] Token sikeresen hitelesítve: ${account.username} (${account.id})`);
    return { success: true, user: sanitizeAccount(account), token };
  },

  // 2C. Kijelentkezés token törléssel
  logout(token) {
    if (token) {
      db.deleteAuthToken(token);
    }
  },

  // 3. Profil frissítése
  updateProfile(accountId, { username, avatarColor, avatarUrl }) {
    let account = accountId ? db.getAccountById(accountId) : null;
    if (!account && username) {
      account = db.getAccountByUsername(username);
    }

    if (!account) {
      // Ha még nincs fiókja (pl. vendég), létrehozunk egyet SQLite-ban
      const newId = accountId || `acc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      account = db.createAccount({
        id: newId,
        username: username || 'Felhasználó',
        passwordHash: 'guest_no_pass',
        salt: 'guest_salt',
        avatarColor: avatarColor || '#7655F5',
        avatarUrl: avatarUrl || null,
        createdAt: Date.now()
      });
      return { success: true, user: sanitizeAccount(account) };
    }

    const cleanNewName = username ? username.trim() : account.username;
    if (cleanNewName.toLowerCase() !== account.username.toLowerCase()) {
      const conflict = db.getAccountByUsername(cleanNewName);
      if (conflict && conflict.id !== account.id) {
        return { success: false, error: 'Ez a név már foglalt egy másik felhasználó által!' };
      }
    }

    const updated = db.updateAccount(account.id, {
      username: cleanNewName,
      avatarColor: avatarColor || account.avatarColor,
      avatarUrl: avatarUrl !== undefined ? avatarUrl : account.avatarUrl
    });

    console.log(`[SQLite Auth] Profil frissítve: ${updated.username}`);
    return { success: true, user: sanitizeAccount(updated) };
  },

  getAccount(accountId) {
    return sanitizeAccount(db.getAccountById(accountId));
  }
};
