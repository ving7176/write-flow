import { transform } from "sucrase";
import fs from "fs";
import path from "path";
import u from "@/utils";

// ── HP6 编译产物读穿缓存：sucrase transform + vm 执行按 (id + code hash) 进程内缓存 ──
// 每次 AI 调用原会重复整条编译链（readFileSync + transform + new Function），连写场景是纯
// 开销。TTL 10 分钟 + writeCode 主动失效双保险。缓存键不含 inputValues（ai.ts 每次调用对
// cached 对象重新 assign 最新配置）；调用方勿改动返回对象（共享引用）。
const COMPILE_TTL = 10 * 60 * 1000;
const compiledCache = new Map<string, { at: number; running: Record<string, any> }>();

function codeHash(code: string): string {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** 取编译后的 vendor 模块（读穿缓存；代码变更自动换键，旧键顺带清理） */
export function getCompiledVendor(id: string): Record<string, any> {
  const code = getCode(id);
  const key = `${id}:${codeHash(code)}`;
  const hit = compiledCache.get(key);
  if (hit && Date.now() - hit.at < COMPILE_TTL) return hit.running;
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const running = u.vm(jsCode);
  compiledCache.set(key, { at: Date.now(), running });
  for (const k of [...compiledCache.keys()]) {
    if (k.startsWith(`${id}:`) && k !== key) compiledCache.delete(k);
  }
  return running;
}

/** 失效编译缓存（writeCode/管理端改 vendor 后调用；不传 id 全清） */
export function invalidateCompiledVendor(id?: string): void {
  if (id == null) {
    compiledCache.clear();
    return;
  }
  for (const k of [...compiledCache.keys()]) {
    if (k.startsWith(`${id}:`)) compiledCache.delete(k);
  }
}

export function writeCode(id: string | number, tsCode: string) {
  const rootDir = u.getPath("vendor")
  fs.mkdirSync(rootDir, { recursive: true })
  if (fs.existsSync(path.join(rootDir,  `${id}.ts`))) {
    fs.writeFileSync(path.join(rootDir,  `${id}.ts`), tsCode);
  }
  fs.writeFileSync(path.join(rootDir,  `${id}.ts`), tsCode);
  invalidateCompiledVendor(String(id)); // HP6：代码变更即失效编译缓存
}

export function getCode(id: string): string {
  const rootDir = u.getPath("vendor");
  const targetFile = path.join(rootDir, `${id}.ts`);
  if (!fs.existsSync(targetFile)) return "";
  return fs.readFileSync(targetFile, "utf-8");
}

export async function getModelList(id: string): Promise<Array<any>> {
  const models = await u.db("o_vendorConfig").where("id", id).select("models").first();
  if (!models || !models.models) return [];
  const vendorData = getCompiledVendor(id);
  if(!vendorData || !vendorData.vendor || !vendorData.vendor.models) return [];
  const combined = [...JSON.parse(JSON.stringify(vendorData.vendor.models)), ...JSON.parse(models?.models ?? "[]")];
  const map = new Map<string, any>();
  for (const m of combined) {
    map.set(m.modelName, m);
  }
  return [...map.values()];
}

export function getVendor(id: string) {
  const vendorData = getCompiledVendor(id);
  return vendorData.vendor;
}
