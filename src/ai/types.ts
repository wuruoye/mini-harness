// 统一消息格式。harness 内部只用这套类型，各厂商适配器负责和自家 API 的格式互相转换。

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** 厂商返回的签名。下次请求同一个模型时要原样带回，换了模型就丢掉 */
  signature?: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  /** 厂商生成的调用 id，工具结果靠它和这次调用对应 */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock;

/** 模型为什么停下：正常结束、要调用工具、输出达到上限、被安全策略拒绝 */
export type StopReason = "stop" | "toolUse" | "length" | "refusal";

export interface UserMessage {
  role: "user";
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** 从提示缓存里读取的输入 token */
  cacheReadTokens: number;
  /** 写入提示缓存的输入 token */
  cacheWriteTokens: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  stopReason: StopReason;
  /** 生成这条消息的厂商和模型，换模型时据此决定 thinking 块能不能带回去 */
  provider: string;
  model: string;
  /** 这次请求的 token 用量；真实厂商会填，假模型可以不填 */
  usage?: Usage;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 发给模型的工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** 参数的 JSON Schema */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
}

/** 模型接入层的统一接口，每家厂商一个实现 */
export interface Provider {
  /** 请求一次模型，返回完整的 assistant 消息。网络或 API 出错时抛异常 */
  complete(request: ModelRequest): Promise<AssistantMessage>;
}
