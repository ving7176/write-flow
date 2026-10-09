import * as fs from "fs";
import * as path from "path";
import getPath from "@/utils/getPath";

/**
 * JSONL 调试取证通道（对齐全局规范 ts/src/level/msg 协议）：单行 JSON 追加写 data/logs/ 下指定文件。
 * 供 aiCall 留痕、badcase 流水等结构化事件落盘；写失败静默降级（磁盘满/权限），不阻断业务主流程。
 */
export default function appendJsonLine(fileName: string, obj: Record<string, unknown>): void {
  try {
    const dir = getPath("logs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, fileName), JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
  } catch {
    // 留痕通道失败不打断主流程
  }
}
