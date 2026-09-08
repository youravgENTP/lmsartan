export type CanvasConversation = {
  id?: string | number | null;
  subject?: string | null;
  last_message?: string | null;
  last_message_at?: string | null;
  context_code?: string | null;
  context_name?: string | null;
  participants?:
    | Array<
      {
        name?: string | null;
        full_name?: string | null;
      } | null
    >
    | null;
};

export type LearningElementConversation = {
  sourceId: string;
  courseId: number | null;
  courseName: string;
  subject: string;
  message: string;
  messageAt: string | null;
  click: string;
};

const LEARNING_ELEMENT_SENDER = "새 학습요소 등록 알림";
const REGISTRATION_SUBJECT =
  /^\s*\[[^\]]+\]\s*['‘’][\s\S]+['‘’](?:이|가)\s*등록되었습니다\.?\s*$/;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

function cleanUrl(value: string): string {
  return value.replace(/[),.;!?\]}>'”’]+$/g, "");
}

export function extractLearningElementUrl(
  message?: string | null,
): string | null {
  if (!message) return null;

  const marker = message.indexOf("학습요소 바로가기");
  const preferredText = marker >= 0 ? message.slice(marker) : message;
  const preferred = preferredText.match(URL_PATTERN)?.[0];

  if (preferred) return cleanUrl(preferred);

  const fallback = message.match(URL_PATTERN)?.[0];
  return fallback ? cleanUrl(fallback) : null;
}

export function isLearningElementConversation(
  conversation: CanvasConversation,
): boolean {
  if (conversation.id === null || conversation.id === undefined) {
    return false;
  }

  const senderMatches = (conversation.participants ?? []).some(
    (participant) =>
      participant?.name === LEARNING_ELEMENT_SENDER ||
      participant?.full_name === LEARNING_ELEMENT_SENDER,
  );

  const subjectMatches = typeof conversation.subject === "string" &&
    REGISTRATION_SUBJECT.test(conversation.subject);

  // The LMS system sender is the strongest signal. The subject pattern is
  // retained as a fallback for responses that omit participant details.
  return senderMatches || subjectMatches;
}

export function normalizeLearningElementConversation(
  conversation: CanvasConversation,
  canvasBaseUrl: string,
): LearningElementConversation | null {
  if (!isLearningElementConversation(conversation)) return null;

  const courseMatch = conversation.context_code?.match(/^course_(\d+)$/);
  const courseId = courseMatch ? Number(courseMatch[1]) : null;
  const courseName = conversation.context_name?.trim() ||
    conversation.subject?.match(/^\s*\[([^\]]+)\]/)?.[1]?.trim() ||
    "LMS";
  const subject = conversation.subject?.trim() ||
    "새 학습요소가 등록되었습니다.";
  const body = conversation.last_message?.trim() || subject;
  const directUrl = extractLearningElementUrl(conversation.last_message);
  const click = directUrl ||
    (courseId !== null
      ? `${canvasBaseUrl.replace(/\/$/, "")}/courses/${courseId}`
      : `${canvasBaseUrl.replace(/\/$/, "")}/conversations`);

  return {
    sourceId: String(conversation.id),
    courseId,
    courseName,
    subject,
    message: `${subject}\n\n${body}`,
    messageAt: conversation.last_message_at ?? null,
    click,
  };
}

export function planLearningElementConversations(
  conversations: CanvasConversation[],
  initialized: boolean,
  seenIds: ReadonlySet<string>,
  canvasBaseUrl: string,
): {
  matched: LearningElementConversation[];
  newItems: LearningElementConversation[];
} {
  const matched = conversations
    .map((conversation) =>
      normalizeLearningElementConversation(conversation, canvasBaseUrl)
    )
    .filter((item): item is LearningElementConversation => item !== null);

  return {
    matched,
    newItems: initialized
      ? matched.filter((item) => !seenIds.has(item.sourceId))
      : [],
  };
}

export async function runIndependentCheck<T>(
  check: () => Promise<T>,
  onError: (error: unknown) => void,
): Promise<T | null> {
  try {
    return await check();
  } catch (error) {
    onError(error);
    return null;
  }
}
