export type WeekModuleItem = {
  id: number;
  title: string;
  type: string;
  published?: boolean;
  unlock_at?: string | null;
  content_details?: {
    locked_for_user?: boolean;
    unlock_at?: string | null;
  };
};

export type LearningXContentItem = {
  moduleItemId: number | null;
  title: string;
  unlockAt: string | null;
};

export type LearningXContentModule = {
  weekPosition: number;
  items: LearningXContentItem[];
};

type RawLearningXContentModule = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseLearningXContentModules(
  rawModules: RawLearningXContentModule[],
): LearningXContentModule[] {
  return rawModules.map((rawModule) => {
    const position = rawModule.week_position ?? rawModule.position;
    const rawItems = Array.isArray(rawModule.module_items)
      ? rawModule.module_items
      : Array.isArray(rawModule.items)
      ? rawModule.items
      : [];

    return {
      weekPosition: typeof position === "number" ? position : Number(position),
      items: rawItems.map((rawItem) => {
        const item = record(rawItem);
        const content = record(item.content_data);
        const moduleItemId = item.module_item_id ?? item.id;

        return {
          moduleItemId: typeof moduleItemId === "number"
            ? moduleItemId
            : Number.isFinite(Number(moduleItemId))
            ? Number(moduleItemId)
            : null,
          title: typeof item.title === "string"
            ? item.title
            : typeof content.title === "string"
            ? content.title
            : "",
          unlockAt: nullableString(content.unlock_at ?? item.unlock_at),
        };
      }),
    };
  }).filter((module) => Number.isFinite(module.weekPosition));
}

export function isLearningXContentAvailable(
  item: LearningXContentItem,
  now: Date,
): boolean {
  if (!item.unlockAt) return true;

  const unlockTime = new Date(item.unlockAt).getTime();
  return !Number.isNaN(unlockTime) && unlockTime <= now.getTime();
}

export function matchesLearningXContent(
  canvasItem: WeekModuleItem,
  contentItem: LearningXContentItem,
): boolean {
  return contentItem.moduleItemId === canvasItem.id ||
    contentItem.title.trim() === canvasItem.title.trim();
}

export function isCurrentlyAvailableWeekItem(
  item: WeekModuleItem,
  weekUnlocked: boolean,
  now: Date,
): boolean {
  if (!weekUnlocked || item.type === "SubHeader") return false;
  if (item.published === false) return false;
  if (item.content_details?.locked_for_user === true) return false;

  const unlockAt = item.content_details?.unlock_at ?? item.unlock_at;

  if (unlockAt) {
    const unlockTime = new Date(unlockAt).getTime();
    if (!Number.isNaN(unlockTime) && unlockTime > now.getTime()) return false;
  }

  return true;
}

export function shouldNotifyWeekRelease(
  learningxInitialized: boolean,
  previousWeekExists: boolean,
  releaseNotified: boolean,
  availableItems: WeekModuleItem[],
): boolean {
  return learningxInitialized &&
    previousWeekExists &&
    !releaseNotified &&
    availableItems.length > 0;
}

export function shouldNotifyLearningXItem(
  weekUnlocked: boolean,
  releaseNotified: boolean,
  includedInWeekRelease: boolean,
): boolean {
  return weekUnlocked && releaseNotified && !includedInWeekRelease;
}
