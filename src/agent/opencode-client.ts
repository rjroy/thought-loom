import { OpenCode, isSessionNotFoundError, type SessionInfo, type SessionMessageInfo, type SessionInboxInfo, type SessionMessageAssistantTool } from "@opencode/client";
import { AgentBindingError, validateServiceUrl } from "./binding";
import { AgentSessionMissingError, AgentUncertainError } from "./errors";
import type { InboxItem, NativeMessage, NativeSession, NativeTool, PublicClient, ResolvedAgentService } from "./opencode-adapter";

// Per-HTTP-request transport timeout. It neither interrupts model execution nor imposes an effort budget.
const requestOptions = () => ({signal:AbortSignal.timeout(10_000)});
async function request<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof AgentBindingError) throw error;
    if (isSessionNotFoundError(error)) throw new AgentSessionMissingError("Native session is absent");
    throw new AgentUncertainError("Native request outcome is uncertain");
  }
}

function session(value: SessionInfo): NativeSession {
  if (!value.model || !value.metadata) throw new AgentBindingError("Native session identity is incomplete");
  const permissions = (value.permissions ?? []).map(rule => ({action:rule.action,resource:rule.resource,effect:rule.effect}));
  return {id:value.id,location:{directory:value.location.directory},model:{...value.model},permissions,metadata:{...value.metadata},
    ...(value.parentID || value.fork || value.revert || value.time?.archived ? {unsafe:true} : {})};
}

function inboxItem(value: SessionInboxInfo): InboxItem {
  if (value.type !== "user" || value.payload.files?.length || value.payload.agents?.length || value.payload.skills?.length || Object.keys(value.payload.metadata ?? {}).length) throw new AgentBindingError("Unexpected native inbox context");
  return {id:value.id,sessionID:value.sessionID,type:"user",payload:{text:value.payload.text},delivery:value.delivery,time:{created:value.time.created}};
}

function tool(value: SessionMessageAssistantTool): NativeTool {
  if (typeof value.id !== "string" || !value.id.trim() || typeof value.name !== "string" || !value.name.trim() ||
      !value.time || !Number.isFinite(value.time.created) ||
      (value.time.ran !== undefined && !Number.isFinite(value.time.ran)) ||
      (value.time.completed !== undefined && !Number.isFinite(value.time.completed)) ||
      (value.executed !== undefined && typeof value.executed !== "boolean")) throw new AgentBindingError("Unexpected native tool context");
  switch (value.state?.status) {
    case "streaming": case "running": case "completed": case "error": break;
    default: throw new AgentBindingError("Unknown native tool state");
  }
  return {id:value.id,name:value.name,status:value.state.status,time:{created:value.time.created,
    ...(value.time.ran === undefined ? {} : {ran:value.time.ran}),
    ...(value.time.completed === undefined ? {} : {completed:value.time.completed})},
    ...(value.executed === undefined ? {} : {executed:value.executed})};
}

function assistant(value: Extract<SessionMessageInfo,{type:"assistant"}>): NativeMessage {
  if (!Array.isArray(value.content)) throw new AgentBindingError("Unexpected native assistant context");
  const content: {type:"text";text:string}[] = [], tools: NativeTool[] = [];
  let unsafe = false;
  for (const item of value.content) {
    if (!item || typeof item !== "object") { unsafe = true; continue; }
    switch (item.type) {
      case "text":
        if (typeof item.text !== "string") unsafe = true;
        else content.push({type:"text",text:item.text});
        break;
      case "reasoning": break; // Known private reasoning is not application output.
      case "tool": tools.push(tool(item)); break;
      default: unsafe = true;
    }
  }
  return {id:value.id,type:"assistant",time:{created:value.time.created,...(value.time.completed === undefined ? {} : {completed:value.time.completed})},
    content,...(tools.length ? {tools} : {}),...(value.finish === undefined ? {} : {finish:value.finish}),
    ...(value.error ? {error:true} : {}),...(unsafe ? {unsafe:true} : {})};
}

function message(value: SessionMessageInfo): NativeMessage {
  if (value.type === "user") return {id:value.id,type:"user",text:value.text,time:{created:value.time.created},
    ...(value.files?.length || value.agents?.length || value.skills?.length || Object.keys(value.metadata ?? {}).length ? {unsafe:true} : {})};
  if (value.type === "idle") return {id:value.id,type:"idle",time:{created:value.time.created},outcome:value.outcome,...(value.error ? {error:true} : {})};
  if (value.type === "assistant") return assistant(value);
  // Do not silently discard synthetic inputs, compaction, switches, shells, or other untracked native context.
  return {id:value.id,type:"other",nativeType:value.type,time:{created:value.time.created}};
}

function connectionHeaders(config: ResolvedAgentService): Headers {
  try {
    const headers = new Headers(config.headers);
    if (config.token !== undefined) {
      if (headers.has("authorization") || !config.token.trim() || /[\r\n\0]/.test(config.token)) throw new AgentBindingError();
      headers.set("authorization",`Bearer ${config.token}`);
    }
    return headers;
  } catch { throw new AgentBindingError("Invalid service authentication configuration"); }
}

/** Actual maintained promise client; the facade only projects decoded SDK types, not fabricated wire APIs. */
export function createPublicClient(config: ResolvedAgentService): PublicClient {
  const url = validateServiceUrl(config.url);
  const headers = connectionHeaders(config);
  const client = OpenCode.make({baseUrl:url,headers});
  return {
    serviceUrl:url,
    serverInfo:() => request(async () => { const info = await client.server.info(requestOptions()); return {version:info.version}; }),
    sessionCreate:input => request(async () => session(await client.session.create(input,requestOptions()))),
    sessionGet:input => request(async () => session(await client.session.get(input,requestOptions()))),
    prompt:input => request(async () => inboxItem(await client.session.prompt({sessionID:input.sessionID,id:input.id,text:input.text},requestOptions()))),
    inbox:input => request(async () => (await client.session.inbox.list(input,requestOptions())).map(inboxItem)),
    history:input => request(async () => {
      const page = await client.message.list(input,requestOptions());
      return {data:page.data.map(message),cursor:page.cursor.next == null ? {} : {next:page.cursor.next}};
    }),
    active:() => request(() => client.session.active(requestOptions())),
    cancelInbox:input => request(() => client.session.inbox.cancel(input,requestOptions())),
    interrupt:input => request(() => client.session.interrupt({...input,resume:false},requestOptions())),
  };
}
