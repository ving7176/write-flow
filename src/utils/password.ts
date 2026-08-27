import crypto from "crypto";

/**
 * 密码哈希（P2-1 用户体系）：Node 内置 crypto.scrypt（不引 bcrypt——标准库可解，符合"先确认标准库"约定）。
 * 存储格式 `scrypt$<salt>$<hash>`；老库明文密码（如种子 admin/admin123）在首次登录成功后静默升级为哈希。
 */

const SCRYPT_PREFIX = "scrypt$";
const KEYLEN = 64;

export function isScryptHash(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(SCRYPT_PREFIX);
}

export function hashPassword(plain: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(plain, salt, KEYLEN, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(`${SCRYPT_PREFIX}${salt}$${derivedKey.toString("hex")}`);
    });
  });
}

/**
 * 校验密码：stored 为 scrypt 格式走哈希比对（timingSafeEqual 防时序侧信道）；
 * 否则按历史明文比较（老库兼容，返回 true 时调用方应升级为哈希）。
 */
export function verifyPassword(plain: string, stored: string | null | undefined): Promise<boolean> {
  if (typeof stored !== "string" || !stored) return Promise.resolve(false);
  if (!stored.startsWith(SCRYPT_PREFIX)) return Promise.resolve(stored === plain);
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return Promise.resolve(false);
  return new Promise((resolve) => {
    crypto.scrypt(plain, salt, KEYLEN, (err, derivedKey) => {
      if (err) {
        resolve(false);
        return;
      }
      const a = Buffer.from(hash, "hex");
      const b = derivedKey;
      resolve(a.length === b.length && crypto.timingSafeEqual(a, b));
    });
  });
}
