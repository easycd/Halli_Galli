import { randomBytes, scrypt as rawScrypt, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
const scrypt = promisify(rawScrypt);

export class Accounts {
  constructor(directory) { this.directory = directory; this.users = []; this.pending = new Set(); this.saveQueue = Promise.resolve(); }
  async load() {
    await mkdir(this.directory, { recursive: true });
    try { this.users = JSON.parse(await readFile(join(this.directory, 'accounts.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  public(user) { return { id: user.id, nickname: user.nickname, wins: user.wins, played: user.played }; }
  async register(nickname, password) {
    if (typeof nickname !== 'string' || !/^[\p{L}\p{N}_-]{2,12}$/u.test(nickname)) throw new Error('닉네임은 한글·영문·숫자·밑줄·하이픈으로 2~12자 입력해주세요.');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new Error('비밀번호는 8~128자로 입력해주세요.');
    const key = nickname.normalize('NFKC').toLocaleLowerCase('ko');
    if (this.users.some(u => u.key === key) || this.pending.has(key)) throw new Error('이미 사용 중인 닉네임이에요.');
    this.pending.add(key);
    try {
      const salt = randomBytes(16).toString('hex');
      const hash = (await scrypt(password, salt, 64)).toString('hex');
      const user = { id: randomUUID(), nickname, key, salt, hash, wins: 0, played: 0 };
      this.users.push(user); await this.save(); return user;
    } finally { this.pending.delete(key); }
  }
  async login(nickname, password) {
    if (typeof nickname !== 'string' || typeof password !== 'string' || password.length > 128) throw new Error('닉네임 또는 비밀번호를 확인해주세요.');
    const key = nickname.normalize('NFKC').toLocaleLowerCase('ko');
    const user = this.users.find(u => u.key === key);
    const candidate = await scrypt(password, user?.salt ?? 'invalid-user-fixed-salt', 64);
    if (!user || !timingSafeEqual(candidate, Buffer.from(user.hash, 'hex'))) throw new Error('닉네임 또는 비밀번호를 확인해주세요.');
    return user;
  }
  save() {
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      const path = join(this.directory, 'accounts.json');
      await writeFile(`${path}.tmp`, JSON.stringify(this.users, null, 2), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    return this.saveQueue;
  }
}
