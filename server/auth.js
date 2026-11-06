// Halli Galli records (wins / played) per homepage member. Login itself is on the homepage (see homeAuth.js).
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export class Accounts {
  constructor(directory) { this.directory = directory; this.users = []; this.saveQueue = Promise.resolve(); }
  async load() {
    await mkdir(this.directory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'records.json'), 'utf8'));
      this.users = (Array.isArray(saved) ? saved : []).filter(u => u && typeof u.id === 'string')
        .map(u => ({ id: u.id, nickname: String(u.nickname), wins: Number(u.wins) || 0, played: Number(u.played) || 0 }));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  public(user) { return { id: user.id, nickname: user.nickname, wins: user.wins, played: user.played }; }
  find(id) { return this.users.find(u => u.id === id) ?? null; }
  /** Create the record on first visit; keep the nickname in step with the homepage. */
  ensure(member) {
    let user = this.find(member.id);
    if (!user) { user = { id: member.id, nickname: member.nickname, wins: 0, played: 0 }; this.users.push(user); this.save().catch(console.error); }
    else if (user.nickname !== member.nickname) { user.nickname = member.nickname; this.save().catch(console.error); }
    return user;
  }
  rename(id, nickname) { const user = this.find(id); if (!user) return false; user.nickname = nickname; this.save().catch(console.error); return true; }
  remove(id) {
    const before = this.users.length;
    this.users = this.users.filter(u => u.id !== id);
    if (this.users.length !== before) { this.save().catch(console.error); return true; }
    return false;
  }
  save() {
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      const path = join(this.directory, 'records.json');
      await writeFile(`${path}.tmp`, JSON.stringify(this.users, null, 2), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    return this.saveQueue;
  }
}
