import { describe, expect, test } from "vitest";
import { extractNativeResearchReport } from "../../src/browser/nativeDeepResearch.js";

const citation = "\uE200cite\uE202source1\uE201";
function fixture() {
  const state = {
    status: "completed",
    report_message: {
      id: "report-1",
      author: { role: "assistant" },
      channel: "final",
      status: "finished_successfully",
      content: { content_type: "text", parts: [`# Report\nA supported claim ${citation}.`] },
      metadata: {
        is_complete: true,
        content_references: [
          {
            type: "grouped_webpages",
            matched_text: citation,
            items: [{ title: "Official", url: "https://example.com/official" }],
          },
          {
            type: "sources_footnote",
            matched_text: " ",
            sources: [{ title: "Other", url: "https://example.com/other" }],
          },
        ],
      },
    },
  };
  return {
    state,
    document: {
      current_node: "tool",
      mapping: {
        user: { parent: null, message: { id: "user-1", author: { role: "user" } } },
        tool: {
          parent: "user",
          message: {
            author: { role: "tool" },
            metadata: {
              invoked_resource: { resource_uri: "/connector_openai_deep_research/start" },
              chatgpt_sdk: { widget_state: JSON.stringify(state) },
            },
          },
        },
      },
    },
  };
}

describe("native Deep Research widget reports", () => {
  test("extracts the matched native report with working inline citations and source inventory", () => {
    const { document } = fixture();
    const result = extractNativeResearchReport(document, ["user-1"]);
    expect(result?.completed).toBe(true);
    expect(result?.text).toContain("[Official](<https://example.com/official>)");
    expect(result?.text).toContain("## Sources");
    expect(result?.text).toContain("[Other](<https://example.com/other>)");
    expect(result?.text).not.toContain(citation);
    expect(result?.text.length).toBeLessThan(500);
  });

  test.each(["researching", "planning"])(
    "does not promote %s state to a completed report",
    (status) => {
      const { state, document } = fixture();
      state.status = status;
      document.mapping.tool.message.metadata.chatgpt_sdk.widget_state = JSON.stringify(state);
      expect(extractNativeResearchReport(document, ["user-1"])).toMatchObject({
        completed: false,
        text: "",
      });
    },
  );

  test("rejects another user's report and a different connector", () => {
    const { document } = fixture();
    expect(extractNativeResearchReport(document, ["other-user"])).toBeNull();
    document.mapping.tool.message.metadata.invoked_resource.resource_uri =
      "/another-connector/start";
    expect(extractNativeResearchReport(document, ["user-1"])).toBeNull();
  });

  test("never exports hidden reasoning as the report", () => {
    const { state, document } = fixture();
    state.report_message.channel = "analysis";
    document.mapping.tool.message.metadata.chatgpt_sdk.widget_state = JSON.stringify(state);
    expect(extractNativeResearchReport(document, ["user-1"])).toMatchObject({
      completed: false,
      text: "",
    });
  });

  test("rejects cyclic conversation ancestry", () => {
    const { document } = fixture();
    document.mapping.tool.parent = "tool";
    expect(extractNativeResearchReport(document, ["user-1"])).toBeNull();
  });
});
