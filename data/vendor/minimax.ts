/**
 * WriteFlow AI供应商模板 - MiniMax(海螺AI)
 * @version 2.0
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

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
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
  uploadReference: (base64: string, fileType: "image" | "audio" | "video") => Promise<ReferenceList>;
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
  id: "minimax",
  version: "2.1",
  author: "WriteFlow",
  name: "MiniMax(海螺AI)",
  description: "MiniMax官方接口适配，支持M系列推理文本模型、文生图/图生图、视频生成（文生视频、图生视频、首尾帧生成）能力 \n [前往平台](https://minimaxi.com/)",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "示例：https://api.minimaxi.com" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://api.minimaxi.com" },
  models: [
    // 文本模型
    { name: "MiniMax-M2.7 (推理版)", modelName: "MiniMax-M2.7", type: "text", think: true },
    { name: "MiniMax-M2.7 极速版 (推理版)", modelName: "MiniMax-M2.7-highspeed", type: "text", think: true },
    { name: "MiniMax-M2.5 (推理版)", modelName: "MiniMax-M2.5", type: "text", think: true },
    { name: "MiniMax-M2.5 极速版 (推理版)", modelName: "MiniMax-M2.5-highspeed", type: "text", think: true },
    { name: "MiniMax-M2.1 (编程版)", modelName: "MiniMax-M2.1", type: "text", think: true },
    { name: "MiniMax-M2.1 极速版 (编程版)", modelName: "MiniMax-M2.1-highspeed", type: "text", think: true },
    { name: "MiniMax-M2 (Agent版)", modelName: "MiniMax-M2", type: "text", think: false },
    // 图片模型
    { name: "海螺图像V1", modelName: "image-01", type: "image", mode: ["text", "singleImage"] },
    { name: "海螺图像V1 Live版", modelName: "image-01-live", type: "image", mode: ["text", "singleImage"], associationSkills: "支持自定义画风" },
    // 视频模型
  ],
};

// ============================================================
// 辅助工具
// ============================================================

/**
 * 获取请求头
 */
const getHeaders = (): Record<string, string> => {
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
};

/**
 * 获取基础请求地址
 */
const getBaseUrl = (): string => {
  return vendor.inputValues.baseUrl.replace(/\/$/, "");
};

/**
 * 从 ReferenceList 条目中提取有头 base64 字符串
 */
const extractBase64WithHead = (ref: ReferenceList): string => {
  return ref.base64.startsWith("data:") ? ref.base64 : `data:image/png;base64,${ref.base64}`;
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const baseUrl = getBaseUrl();

  const openaiBaseUrl = `${baseUrl}/v1`;
  const extraBody = model.think ? { reasoning_split: true } : {};
  return createOpenAI({ baseURL: openaiBaseUrl, apiKey, extraBody }).chat(model.modelName);
};

const uploadReference = async (base64: string, fileType: "image" | "audio" | "video"): Promise<ReferenceList> => {
  // MiniMax的图片接口直接接受 base64，压缩后原样返回
  if (fileType === "image") {
    const compressed = await zipImage(base64, 10 * 1024);
    return { type: "image", sourceType: "base64", base64: compressed };
  }
  // 视频接口的图片参数也是 base64，压缩到20MB
  return { type: fileType, sourceType: "base64", base64 } as ReferenceList;
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const baseUrl = getBaseUrl();
  const headers = getHeaders();

  const reqBody: any = {
    model: model.modelName,
    prompt: config.prompt,
    aspect_ratio: config.aspectRatio,
    response_format: "base64",
    n: 1,
    prompt_optimizer: true,
    aigc_watermark: false,
  };

  // 处理图生图参考
  const imageRefs = config.referenceList || [];
  if (imageRefs.length > 0) {
    const refBase64 = extractBase64WithHead(imageRefs[0]);
    reqBody.subject_reference = [{ type: "character", image_file: refBase64 }];
  }

  logger("开始提交MiniMax图像生成任务");
  const resp = await axios.post(`${baseUrl}/v1/image_generation`, reqBody, { headers });
  if (resp.data.base_resp.status_code !== 0) {
    throw new Error(`图像生成失败：${resp.data.base_resp.status_msg}`);
  }
  if (resp.data.metadata.success_count === 0) {
    throw new Error("图像生成被安全策略拦截，请调整prompt或参考图");
  }

  const imgBase64 = resp.data.data.image_base64[0];
  return imgBase64.startsWith("data:") ? imgBase64 : `data:image/png;base64,${imgBase64}`;
};


const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return {
    hasUpdate: false,
    latestVersion: "2.0",
    notice:
      "## 新版本更新公告\n1. 适配新版模板架构，支持 ReferenceList 统一引用类型\n2. 新增 uploadReference 前置处理器\n3. 优化图片压缩和引用提取逻辑",
  };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.uploadReference = uploadReference;
exports.imageRequest = imageRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

// 这行代码用于确保当前文件被识别为模块，避免全局变量冲突
export {};