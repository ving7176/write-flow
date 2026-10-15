/**
 * WriteFlow AI供应商模板 - DeepSeek
 * @version 2.1
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

interface ImageConfig {
  prompt: string;
  imageBase64: string[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  imageBase64?: string[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const axios: any;
declare const logger: (msg: string) => void;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "deepseek",
  version: "2.1",
  author: "WriteFlow",
  name: "DeepSeek",
  description:
    "DeepSeek 官方接口适配，支持 V4 系列模型与思考模式（思维链输出）。\n\n[前往平台](https://platform.deepseek.com/)",
  icon: "",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "示例：https://api.deepseek.com" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://api.deepseek.com/v1",
  },
  models: [
    { name: "DeepSeek V4 Pro", modelName: "deepseek-v4-pro", type: "text", think: true },
    // 2026-10-14 API 端名册更新（实测 400 回执：supported = deepseek-flash, deepseek-v4-pro）：
    // deepseek-v4-flash / v4.1-flash 均已下架（10-15 /models 复核仅 2 名），failover 已切 auto 动态解析，
    // 存量路由由并行会话统一改 deepseek-flash；旧名行删除防 auto/管理端误选
    { name: "DeepSeek Flash", modelName: "deepseek-flash", type: "text", think: true },
  ],
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");

  // DeepSeek 思考强度仅支持 high / max（low、medium 会被映射为 high，xhigh 会被映射为 max）
  // thinkLevel: 0/1/2 → high, 3 → max
  const effortMap: Record<0 | 1 | 2 | 3, "high" | "max"> = {
    0: "high",
    1: "high",
    2: "high",
    3: "max",
  };

  const enableThinking = model.think && think;
  const extraBody: Record<string, any> = {
    thinking: { type: enableThinking ? "enabled" : "disabled" },
  };
  if (enableThinking) {
    extraBody.reasoning_effort = effortMap[thinkLevel];
  }

  return createOpenAICompatible({
    baseURL: vendor.inputValues.baseUrl,
    apiKey,
    fetch: async (url: string, options?: RequestInit) => {
      const rawBody = JSON.parse((options?.body as string) ?? "{}");
      const modifiedBody = {
        ...rawBody,
        ...extraBody
      };
      return await fetch(url, {
        ...options,
        body: JSON.stringify(modifiedBody),
      });
    },
  }).chatModel(model.modelName);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  return "";
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  return "";
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "2.0", notice: "" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export { };