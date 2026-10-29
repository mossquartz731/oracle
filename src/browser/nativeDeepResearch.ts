import type { ChromeClient, BrowserResearchPlanMetadata } from "./types.js";
import { captureProviderNativeConversation } from "./chatgptConversation.js";
import { readUserMessageIdsMatchingFingerprint } from "./promptFingerprint.js";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;

export interface NativeResearchReport {
  completed: boolean;
  text: string;
  messageId?: string;
  plan?: BrowserResearchPlanMetadata;
}

/** Read only the native research widget belonging to the fingerprint-matched user turn. */
export function extractNativeResearchReport(
  document: unknown,
  userMessageIds: readonly string[],
): NativeResearchReport | null {
  const doc = object(document);
  const mapping = object(doc?.mapping);
  if (!mapping || typeof doc?.current_node !== "string" || !userMessageIds.length) return null;
  const chain: RecordValue[] = [];
  const seen = new Set<string>();
  let id: unknown = doc.current_node;
  while (typeof id === "string" && !seen.has(id) && chain.length < 10000) {
    seen.add(id);
    const node = object(mapping[id]);
    if (!node) return null;
    const message = object(node.message);
    if (message) chain.push(message);
    id = node.parent;
  }
  if (typeof id === "string") return null;
  let matchedUser = false;
  let found: NativeResearchReport | null = null;
  for (let index = chain.length - 1; index >= 0; index--) {
    const message = chain[index];
    const author = object(message.author);
    if (author?.role === "user") {
      matchedUser = typeof message.id === "string" && userMessageIds.includes(message.id);
      continue;
    }
    if (!matchedUser || author?.role !== "tool") continue;
    const metadata = object(message.metadata);
    if (
      object(metadata?.invoked_resource)?.resource_uri !== "/connector_openai_deep_research/start"
    )
      continue;
    const encoded = object(metadata?.chatgpt_sdk)?.widget_state;
    if (typeof encoded !== "string") continue;
    let state: RecordValue | null;
    try {
      state = object(JSON.parse(encoded));
    } catch {
      continue;
    }
    if (!state) continue;
    const nativePlan = object(state.plan);
    const steps = Array.isArray(nativePlan?.steps)
      ? nativePlan.steps.flatMap((step) => {
          const text = object(step)?.text;
          return typeof text === "string" ? [text] : [];
        })
      : [];
    const plan =
      typeof nativePlan?.title === "string" && steps.length
        ? {
            title: nativePlan.title,
            steps,
            phase: (state.research_started_at || state.status === "completed"
              ? "researching"
              : "planning") as "researching" | "planning",
            capturedAt:
              typeof state.last_updated_at === "string"
                ? state.last_updated_at
                : new Date().toISOString(),
          }
        : undefined;
    const report = object(state.report_message);
    const parts = object(report?.content)?.parts;
    const completed =
      state.status === "completed" &&
      report?.status === "finished_successfully" &&
      report.channel === "final" &&
      object(report?.author)?.role === "assistant" &&
      object(report?.metadata)?.is_complete === true;
    let text =
      completed && Array.isArray(parts) && parts.every((part) => typeof part === "string")
        ? parts.join("\n")
        : "";
    const refs = object(report?.metadata)?.content_references;
    const sources = new Set<string>();
    if (text && Array.isArray(refs)) {
      for (const reference of refs) {
        const ref = object(reference);
        if (!ref) continue;
        const links: string[] = [];
        const add = (value: unknown) => {
          const item = object(value);
          if (typeof item?.url !== "string" || !/^https?:\/\//i.test(item.url)) return;
          const title = typeof item.title === "string" ? item.title : "Source";
          links.push(
            `[${title
              .replaceAll("[", " ")
              .replaceAll("]", " ")
              .replace(/[\r\n]/g, " ")}](<${item.url.replace(/[<>\s]/g, encodeURIComponent)}>)`,
          );
        };
        if (Array.isArray(ref.items))
          for (const item of ref.items) {
            add(item);
            const supporting = object(item)?.supporting_websites;
            if (Array.isArray(supporting)) supporting.forEach(add);
          }
        if (Array.isArray(ref.sources)) ref.sources.forEach(add);
        links.forEach((link) => sources.add(link));
        if (
          links.length &&
          ref.type === "grouped_webpages" &&
          typeof ref.matched_text === "string" &&
          ref.matched_text.startsWith("\uE200cite")
        )
          text = text.split(ref.matched_text).join([...new Set(links)].join(", "));
      }
    }
    if (text && sources.size)
      text += `\n\n## Sources\n\n${[...sources].map((link) => `- ${link}`).join("\n")}\n`;
    found = {
      completed: completed && Boolean(text),
      text,
      messageId: typeof report?.id === "string" ? report.id : undefined,
      plan,
    };
  }
  return found;
}

export async function readNativeResearchReport(
  runtime: ChromeClient["Runtime"],
  conversationId: string,
  fingerprint: string,
): Promise<NativeResearchReport | null> {
  const ids = await readUserMessageIdsMatchingFingerprint(runtime, fingerprint);
  if (!ids.length) return null;
  const outcome = await captureProviderNativeConversation({ Runtime: runtime, conversationId });
  if (outcome.status !== "captured") return null;
  return extractNativeResearchReport(JSON.parse(outcome.capture.rawText), ids);
}
