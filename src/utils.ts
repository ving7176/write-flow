import db from "@/utils/db";
import oss from "@/utils/oss";
import getConfig from "./utils/getConfig";
import { v4 as uuid } from "uuid";
import error from "@/utils/error";
import getPath from "@/utils/getPath";
import vm from "@/utils/vm";
import task from "@/utils/taskRecord";
import Ai from "@/utils/ai";
import { getPrompts } from "@/utils/getPrompts";
import { getArtPrompt } from "@/utils/getArtPrompt";
import replaceUrl from "@/utils/replaceUrl";
import writeVersion from "@/utils/writeVersion";
import * as vendor from "@/utils/vendor";

/**
 * 生成 int4 列安全主键（防碰撞）：integer 列装不下 Date.now()（溢出 2^31-1），
 * 且纯取模（Date.now() % 2147483647）同毫秒并发必撞。方案：2e9 模 + 0-999 随机后缀
 * （同 trace.ts 口径），范围 [0, 2000000999] < 2^31-1。用于 o_agentWorkData / o_novel /
 * o_tasks 等非自增 int 主键表。
 */
export function nextIntId(): number {
  return (Date.now() % 2000000000) + Math.floor(Math.random() * 1000);
}

export default {
  db,
  oss,
  getConfig,
  uuid,
  error,
  vm,
  getPath,
  Ai,
  task,
  getPrompts,
  getArtPrompt,
  replaceUrl,
  writeVersion,
  vendor,
  nextIntId,
};
