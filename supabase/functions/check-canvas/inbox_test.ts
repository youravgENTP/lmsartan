import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  type CanvasConversation,
  extractLearningElementUrl,
  isLearningElementConversation,
  planLearningElementConversations,
  runIndependentCheck,
} from "./inbox.ts";

const base: CanvasConversation = {
  id: "10619",
  subject: "[생약학2(ADB036-1)] '강의자료'가 등록되었습니다.",
  last_message:
    "자료가 등록되었습니다.\n학습요소 바로가기 :\nhttps://e-edu.inje.ac.kr/courses/3278/modules/items/1",
  last_message_at: "2026-09-07T05:30:25Z",
  context_code: "course_3278",
  context_name: "생약학2(ADB036-1)",
  participants: [{ name: "새 학습요소 등록 알림" }],
};

Deno.test("detects a learning-element sender", () => {
  assertEquals(isLearningElementConversation(base), true);
});

Deno.test("accepts both Korean subject particles", () => {
  for (const particle of ["가", "이"]) {
    assertEquals(
      isLearningElementConversation({
        id: particle,
        subject: `[과목] '자료'${particle} 등록되었습니다.`,
        participants: [],
      }),
      true,
    );
  }
});

Deno.test("ignores unrelated inbox messages", () => {
  assertEquals(
    isLearningElementConversation({
      id: "other",
      subject: "과제에 관해 질문합니다",
      participants: [{ name: "학생" }],
    }),
    false,
  );
});

Deno.test("does not plan an already-seen conversation", () => {
  const plan = planLearningElementConversations(
    [base],
    true,
    new Set(["10619"]),
    "https://e-edu.inje.ac.kr",
  );
  assertEquals(plan.newItems.length, 0);
});

Deno.test("plans multiple unseen conversations once each", () => {
  const plan = planLearningElementConversations(
    [base, { ...base, id: "10328" }],
    true,
    new Set<string>(),
    "https://e-edu.inje.ac.kr",
  );
  assertEquals(plan.newItems.map((item) => item.sourceId), ["10619", "10328"]);
});

Deno.test("missing optional fields do not crash filtering", () => {
  assertEquals(isLearningElementConversation({ id: "empty" }), false);
  assertEquals(isLearningElementConversation({}), false);
});

Deno.test("extracts the direct learning-element URL", () => {
  const url = extractLearningElementUrl(
    "다른 링크 https://example.com\n학습요소 바로가기 : https://e-edu.inje.ac.kr/items/1).",
  );
  assertEquals(url, "https://e-edu.inje.ac.kr/items/1");

  const plan = planLearningElementConversations(
    [base],
    true,
    new Set(),
    "https://e-edu.inje.ac.kr",
  );
  assertStringIncludes(plan.newItems[0].click, "/modules/items/1");
});

Deno.test("first run baselines historical conversations", () => {
  const plan = planLearningElementConversations(
    [base],
    false,
    new Set(),
    "https://e-edu.inje.ac.kr",
  );
  assertEquals(plan.matched.length, 1);
  assertEquals(plan.newItems.length, 0);
});

Deno.test("an independent inbox failure is contained", async () => {
  let laterMonitorRan = false;
  const errors: unknown[] = [];
  const result = await runIndependentCheck(
    () => Promise.reject(new Error("inbox unavailable")),
    (error) => errors.push(error),
  );
  laterMonitorRan = true;

  assertEquals(result, null);
  assertEquals(errors.length, 1);
  assertEquals(laterMonitorRan, true);
});
