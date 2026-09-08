import {
  assertEquals,
} from "@std/assert";
import {
  isCurrentlyAvailableWeekItem,
  isLearningXContentAvailable,
  matchesLearningXContent,
  parseLearningXContentModules,
  shouldNotifyLearningXItem,
  shouldNotifyWeekRelease,
  type WeekModuleItem,
} from "./week_release.ts";

const now = new Date("2026-09-08T00:00:00Z");
const file: WeekModuleItem = {
  id: 1,
  title: "복습자료-1",
  type: "File",
};

Deno.test("an unlocked empty week does not release and remains eligible", () => {
  assertEquals(shouldNotifyWeekRelease(true, true, false, []), false);
  assertEquals(shouldNotifyWeekRelease(true, true, false, [file]), true);
});

Deno.test("an already released week does not release again", () => {
  assertEquals(shouldNotifyWeekRelease(true, true, true, [file]), false);
  assertEquals(shouldNotifyLearningXItem(true, true, false), true);
  assertEquals(shouldNotifyLearningXItem(true, true, true), false);
});

Deno.test("persisted unnotified state releases after restart", () => {
  const persisted = { exists: true, releaseNotified: false };
  assertEquals(
    shouldNotifyWeekRelease(
      true,
      persisted.exists,
      persisted.releaseNotified,
      [file],
    ),
    true,
  );
});

Deno.test("newly discovered existing content is baselined", () => {
  assertEquals(shouldNotifyWeekRelease(true, false, false, [file]), false);
});

Deno.test("only real currently available items count", () => {
  assertEquals(isCurrentlyAvailableWeekItem(file, true, now), true);
  assertEquals(isCurrentlyAvailableWeekItem(file, false, now), false);
  assertEquals(
    isCurrentlyAvailableWeekItem({ ...file, type: "SubHeader" }, true, now),
    false,
  );
  assertEquals(
    isCurrentlyAvailableWeekItem({ ...file, published: false }, true, now),
    false,
  );
  assertEquals(
    isCurrentlyAvailableWeekItem({
      ...file,
      content_details: { locked_for_user: true },
    }, true, now),
    false,
  );
  assertEquals(
    isCurrentlyAvailableWeekItem({
      ...file,
      content_details: { unlock_at: "2026-09-08T00:37:00Z" },
    }, true, now),
    false,
  );
});

Deno.test("LearningX content uses its own viewing start", () => {
  const [module] = parseLearningXContentModules([{
    week_position: 2,
    module_items: [{
      module_item_id: 99,
      title: "(3학년)2026_coagulation",
      content_data: { unlock_at: "2026-09-09T00:00:00+09:00" },
    }],
  }]);
  const content = module.items[0];

  assertEquals(module.weekPosition, 2);
  assertEquals(
    matchesLearningXContent({
      id: 99,
      title: "(3학년)2026_coagulation",
      type: "ExternalTool",
    }, content),
    true,
  );
  assertEquals(isLearningXContentAvailable(content, now), false);
  assertEquals(
    isLearningXContentAvailable(content, new Date("2026-09-09T00:00:00+09:00")),
    true,
  );
});
