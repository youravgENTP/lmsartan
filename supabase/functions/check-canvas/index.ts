import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

type CanvasCourse = {
  id: number;
  name?: string;
  access_restricted_by_date?: boolean;
  enrollments?: Array<{
    enrollment_state?: string;
  }>;
};

type CanvasModuleItem = {
  id: number;
  title: string;
  type: string;
  html_url?: string;
  external_url?: string;
  content_id?: number;
};

type CanvasModule = {
  id: number;
  name: string;
  position: number;
  items?: CanvasModuleItem[];
};

type CanvasAttachment = {
  id: number;
  display_name?: string;
  filename?: string;
  size?: number;
  url?: string;
  updated_at?: string;
  content_type?: string;
  "content-type"?: string;
};

type CanvasAnnouncement = {
  id: number;
  title: string;
  message?: string;
  posted_at?: string | null;
  delayed_post_at?: string | null;
  published?: boolean;
  html_url?: string;
  context_code: string;
  attachments?: CanvasAttachment[];
};

type LearningXWeek = {
  week_position: number;
  unlock_at: string | null;
  lock_at: string | null;
  due_at: string | null;
  late_at: string | null;
};

type ParsedLtiForm = {
  action: string;
  fields: Array<[string, string]>;
};

type CookieJar = Map<string, string>;

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(",")) {
    if (!part.includes('rel="next"')) continue;

    const match = part.match(/<([^>]+)>/);
    if (match) return match[1];
  }

  return null;
}

async function canvasGetAll<T>(
  baseUrl: string,
  token: string,
  path: string,
): Promise<T[]> {
  let url = path.startsWith("http")
    ? path
    : `${baseUrl}${path}`;

  const results: T[] = [];

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();

      throw new Error(
        `Canvas API error ${response.status} ${response.statusText}: ${body}`,
      );
    }

    const page = await response.json();

    if (!Array.isArray(page)) {
      throw new Error(`Canvas API returned a non-array response for ${url}`);
    }

    results.push(...page as T[]);
    url = parseNextLink(response.headers.get("link"));
  }

  return results;
}

async function canvasGetJson<T>(
  baseUrl: string,
  token: string,
  path: string,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Canvas API error ${response.status} ${response.statusText}: ${body}`,
    );
  }

  return await response.json() as T;
}

function splitSetCookieHeader(value: string | null): string[] {
  if (!value) return [];

  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

function absorbCookies(headers: Headers, jar: CookieJar): void {
  const extendedHeaders = headers as Headers & {
    getSetCookie?: () => string[];
  };

  const setCookies =
    typeof extendedHeaders.getSetCookie === "function"
      ? extendedHeaders.getSetCookie()
      : splitSetCookieHeader(headers.get("set-cookie"));

  for (const line of setCookies) {
    const firstPart = line.split(";")[0];
    const separator = firstPart.indexOf("=");

    if (separator <= 0) continue;

    const name = firstPart.slice(0, separator).trim();
    const value = firstPart.slice(separator + 1).trim();

    jar.set(name, value);
  }
}

function buildCookieHeader(jar: CookieJar): string {
  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function fetchWithCookies(
  initialUrl: string,
  init: RequestInit,
  jar: CookieJar,
  maxRedirects = 8,
): Promise<{ response: Response; finalUrl: string }> {
  let url = initialUrl;
  let method = init.method ?? "GET";
  let body = init.body;

  for (let i = 0; i <= maxRedirects; i++) {
    const headers = new Headers(init.headers);

    if (jar.size > 0) {
      headers.set("Cookie", buildCookieHeader(jar));
    }

    const response = await fetch(url, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });

    absorbCookies(response.headers, jar);

    if (
      response.status >= 300 &&
      response.status < 400
    ) {
      const location = response.headers.get("location");

      if (!location) {
        return { response, finalUrl: url };
      }

      url = new URL(location, url).toString();

      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method.toUpperCase() === "POST")
      ) {
        method = "GET";
        body = undefined;
      }

      continue;
    }

    return {
      response,
      finalUrl: url,
    };
  }

  throw new Error("Too many redirects while establishing LearningX session");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    );
}

function attributeValue(
  tag: string,
  attribute: string,
): string | null {
  const regex = new RegExp(
    `${attribute}\\s*=\\s*["']([^"']*)["']`,
    "i",
  );

  const match = tag.match(regex);

  return match ? decodeHtml(match[1]) : null;
}

function parseLtiForm(html: string): ParsedLtiForm {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];

  const form = forms.find((candidate) =>
    /id=["']tool_form["']/i.test(candidate)
  );

  if (!form) {
    throw new Error("Could not find LearningX tool_form");
  }

  const openingTag = form.match(/<form\b[^>]*>/i)?.[0];

  if (!openingTag) {
    throw new Error("Could not parse LearningX form opening tag");
  }

  const action = attributeValue(openingTag, "action");

  if (!action) {
    throw new Error("LearningX tool_form has no action");
  }

  const fields: Array<[string, string]> = [];

  for (const input of form.match(/<input\b[^>]*>/gi) ?? []) {
    const name = attributeValue(input, "name");

    if (!name) continue;

    fields.push([
      name,
      attributeValue(input, "value") ?? "",
    ]);
  }

  return {
    action,
    fields,
  };
}

function isLearningXItem(item: CanvasModuleItem): boolean {
  return (
    item.type === "ExternalTool" &&
    typeof item.external_url === "string" &&
    item.external_url.includes(
      "/learningx/lti/lecture_attendance/",
    )
  );
}

function moduleWeekPosition(module: CanvasModule): number {
  const match = module.name.match(/(\d+)\s*주차/);

  if (match) {
    return Number(match[1]);
  }

  return module.position;
}

async function getLearningXWeeks(
  baseUrl: string,
  canvasToken: string,
  courseId: number,
  launchItem: CanvasModuleItem,
): Promise<LearningXWeek[]> {
  if (!launchItem.external_url || !launchItem.content_id) {
    throw new Error(
      `LearningX item lacks external_url/content_id in course ${courseId}`,
    );
  }

  const params = new URLSearchParams({
    id: String(launchItem.content_id),
    url: launchItem.external_url,
  });

  const launchData = await canvasGetJson<{
    url: string;
  }>(
    baseUrl,
    canvasToken,
    `/api/v1/courses/${courseId}/external_tools/sessionless_launch?${params}`,
  );

  const jar: CookieJar = new Map();

  const launchResult = await fetchWithCookies(
    launchData.url,
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    },
    jar,
  );

  if (!launchResult.response.ok) {
    const body = await launchResult.response.text();

    throw new Error(
      `Canvas LTI launch failed: ${launchResult.response.status} ${body}`,
    );
  }

  const launchHtml = await launchResult.response.text();
  const form = parseLtiForm(launchHtml);

  const formBody = new URLSearchParams();

  for (const [name, value] of form.fields) {
    formBody.append(name, value);
  }

  const ltiResult = await fetchWithCookies(
    form.action,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
        Referer: `${baseUrl}/courses/${courseId}`,
      },
      body: formBody.toString(),
    },
    jar,
  );

  if (!ltiResult.response.ok) {
    const body = await ltiResult.response.text();

    throw new Error(
      `LearningX LTI login failed: ${ltiResult.response.status} ${body}`,
    );
  }

  // Consume the LTI response body so the request completes cleanly.
  await ltiResult.response.text();

  const xnApiToken = jar.get("xn_api_token");

  if (!xnApiToken) {
    throw new Error(
      `LearningX did not issue xn_api_token for course ${courseId}`,
    );
  }

  const lessonsResult = await fetchWithCookies(
    `${baseUrl}/learningx/api/v1/courses/${courseId}/lessons`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${xnApiToken}`,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0",
        Referer: ltiResult.finalUrl,
      },
    },
    jar,
  );

  if (!lessonsResult.response.ok) {
    const body = await lessonsResult.response.text();

    throw new Error(
      `LearningX lessons API failed: ${lessonsResult.response.status} ${body}`,
    );
  }

  return await lessonsResult.response.json() as LearningXWeek[];
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function plainText(html?: string): string {
  if (!html) return "";

  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function truncate(value: string, max = 400): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

async function featureInitialized(
  admin: any,
  eventType: string,
): Promise<boolean> {
  const { count, error } = await admin
    .from("notification_log")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("event_type", eventType)
    .eq("status", "success");

  if (error) throw error;

  return (count ?? 0) > 0;
}

async function markFeatureInitialized(
  admin: any,
  eventType: string,
): Promise<void> {
  const { error } = await admin
    .from("notification_log")
    .insert({
      event_type: eventType,
      channel: "system",
      status: "success",
      source_id: "v1",
      title: "Feature baseline completed",
    });

  if (error) throw error;
}

async function notificationAlreadySent(
  admin: any,
  eventType: string,
  courseId: number,
  sourceId: string,
): Promise<boolean> {
  const { count, error } = await admin
    .from("notification_log")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("event_type", eventType)
    .eq("course_id", courseId)
    .eq("source_id", sourceId)
    .eq("status", "success");

  if (error) throw error;

  return (count ?? 0) > 0;
}

async function sendLoggedNtfy(
  admin: any,
  baseUrl: string,
  topic: string,
  eventType: string,
  courseId: number,
  sourceId: string,
  title: string,
  message: string,
  click?: string,
): Promise<boolean> {
  if (
    await notificationAlreadySent(
      admin,
      eventType,
      courseId,
      sourceId,
    )
  ) {
    return false;
  }

  const payload: Record<string, unknown> = {
    topic,
    title,
    message,
    tags: ["books"],
  };

  if (click) {
    payload.click = click;
  }

  const response = await fetch(
    baseUrl.replace(/\/$/, ""),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  const responseText =
    await response.text();

  let ntfyResponse: Record<string, unknown> | null =
    null;

  try {
    ntfyResponse =
      JSON.parse(responseText);
  } catch {
    ntfyResponse = null;
  }

  if (!response.ok) {
    const errorMessage =
      `${response.status} ${response.statusText}: ${responseText}`;

    await admin
      .from("notification_log")
      .insert({
        event_type: eventType,
        course_id: courseId,
        source_id: sourceId,
        channel: "ntfy",
        title,
        message,
        status: "error",
        error_message: errorMessage,
        ntfy_topic: topic,
        ntfy_response_json: ntfyResponse,
      });

    throw new Error(`ntfy error ${errorMessage}`);
  }

  const ntfyMessageTime =
    typeof ntfyResponse?.time === "number"
      ? new Date(
        ntfyResponse.time * 1000,
      ).toISOString()
      : null;

  const { error } = await admin
    .from("notification_log")
    .insert({
      event_type: eventType,
      course_id: courseId,
      source_id: sourceId,
      channel: "ntfy",
      title,
      message,
      status: "success",
      ntfy_topic:
        typeof ntfyResponse?.topic === "string"
          ? ntfyResponse.topic
          : topic,
      ntfy_message_id:
        typeof ntfyResponse?.id === "string"
          ? ntfyResponse.id
          : null,
      ntfy_message_time:
        ntfyMessageTime,
      ntfy_response_json:
        ntfyResponse,
    });

  if (error) throw error;

  return true;
}

async function announcementFingerprint(
  announcement: CanvasAnnouncement,
): Promise<string> {
  const normalizedAttachments = (announcement.attachments ?? [])
    .map((attachment) => ({
      id: attachment.id,
      display_name:
        attachment.display_name ?? attachment.filename ?? null,
      size: attachment.size ?? null,
      url: attachment.url ?? null,
      updated_at: attachment.updated_at ?? null,
    }))
    .sort((a, b) => a.id - b.id);

  return await sha256(
    JSON.stringify({
      title: announcement.title,
      message: announcement.message ?? "",
      published: announcement.published ?? null,
      delayed_post_at: announcement.delayed_post_at ?? null,
      attachments: normalizedAttachments,
    }),
  );
}

export default {
  fetch: withSupabase(
    { auth: ["secret"] },
    async (_req, ctx) => {
      const canvasBaseUrl =
        requiredEnv("CANVAS_BASE_URL").replace(/\/$/, "");

      const canvasToken =
        requiredEnv("CANVAS_ACCESS_TOKEN");

      const ntfyBaseUrl =
        requiredEnv("NTFY_BASE_URL");

      const ntfyTopic =
        requiredEnv("NTFY_TOPIC");

      let runId: number | null = null;
      let stage = "start";

      let notificationsSent = 0;
      let announcementsSeen = 0;
      let announcementChanges = 0;
      let learningxWeeksSeen = 0;

      const learningxWarnings: string[] = [];

      try {
        stage = "checking existing baselines";

        const {
          data: firstSuccessfulRun,
          error: firstRunError,
        } = await ctx.supabaseAdmin
          .from("watcher_runs")
          .select("finished_at")
          .eq("status", "success")
          .order("started_at", {
            ascending: true,
          })
          .limit(1)
          .maybeSingle();

        if (firstRunError) throw firstRunError;

        const moduleBaseline =
          !firstSuccessfulRun;

        const moduleBaselineCutoff =
          firstSuccessfulRun?.finished_at
            ? new Date(firstSuccessfulRun.finished_at)
            : null;

        const announcementsInitialized =
          await featureInitialized(
            ctx.supabaseAdmin,
            "baseline_announcements",
          );

        const learningxInitialized =
          await featureInitialized(
            ctx.supabaseAdmin,
            "baseline_learningx",
          );

        stage = "creating watcher run";

        const {
          data: run,
          error: runInsertError,
        } = await ctx.supabaseAdmin
          .from("watcher_runs")
          .insert({
            status: "running",
          })
          .select("id")
          .single();

        if (runInsertError) throw runInsertError;

        runId = run.id;

        stage = "loading existing state";

        const {
          data: existingItemRows,
          error: existingItemsError,
        } = await ctx.supabaseAdmin
          .from("canvas_items")
          .select("course_id,item_id,first_seen_at");

        if (existingItemsError) throw existingItemsError;

        const existingItems = new Map(
          (existingItemRows ?? []).map(
            (row) => [
              `${row.course_id}:${row.item_id}`,
              row,
            ],
          ),
        );

        const {
          data: existingAnnouncementRows,
          error: existingAnnouncementsError,
        } = await ctx.supabaseAdmin
          .from("canvas_announcements")
          .select(
            "course_id,announcement_id,content_fingerprint,last_changed_at",
          );

        if (existingAnnouncementsError) {
          throw existingAnnouncementsError;
        }

        const existingAnnouncements = new Map(
          (existingAnnouncementRows ?? []).map((row) => [
            `${row.course_id}:${row.announcement_id}`,
            row,
          ]),
        );

        const {
          data: existingWeekRows,
          error: existingWeeksError,
        } = await ctx.supabaseAdmin
          .from("learningx_weeks")
          .select(
            "course_id,week_position,is_unlocked,unlock_notified_at",
          );

        if (existingWeeksError) throw existingWeeksError;

        const existingWeeks = new Map(
          (existingWeekRows ?? []).map((row) => [
            `${row.course_id}:${row.week_position}`,
            row,
          ]),
        );

        stage = "fetching Canvas courses";

        const courses = await canvasGetAll<CanvasCourse>(
          canvasBaseUrl,
          canvasToken,
          "/api/v1/courses?per_page=100",
        );

        const activeCourses = courses.filter((course) => {
          if (!course.name) return false;
          if (course.access_restricted_by_date) return false;

          if (!course.enrollments?.length) {
            return true;
          }

          return course.enrollments.some(
            (enrollment) =>
              enrollment.enrollment_state === "active",
          );
        });

        const currentItemRows: Array<{
          course_id: number;
          course_name: string;
          module_id: number;
          module_name: string;
          item_id: number;
          item_type: string;
          title: string;
          html_url: string | null;
          external_url: string | null;
          last_seen_at: string;
        }> = [];

        let itemsSeen = 0;
        let newItems = 0;

        for (const course of activeCourses) {
          stage =
            `fetching modules for course ${course.id}`;

          const modules =
            await canvasGetAll<CanvasModule>(
              canvasBaseUrl,
              canvasToken,
              `/api/v1/courses/${course.id}/modules?include[]=items&per_page=100`,
            );

          const launchItem = modules
            .flatMap((module) => module.items ?? [])
            .find(isLearningXItem);

          let weekSchedule =
            new Map<number, LearningXWeek>();

          const weeksUnlockedThisRun =
            new Set<number>();

          if (launchItem) {
            stage =
              `fetching LearningX schedule for course ${course.id}`;

            try {
              const weeks = await getLearningXWeeks(
                canvasBaseUrl,
                canvasToken,
                course.id,
                launchItem,
              );

              learningxWeeksSeen += weeks.length;

              weekSchedule = new Map(
                weeks.map((week) => [
                  week.week_position,
                  week,
                ]),
              );

              for (const week of weeks) {
                const key =
                  `${course.id}:${week.week_position}`;

                const previous =
                  existingWeeks.get(key);

                const now = new Date();

                const unlocked =
                  week.unlock_at === null ||
                  new Date(week.unlock_at) <= now;

                let unlockNotifiedAt =
                  previous?.unlock_notified_at ?? null;

                const transitionedToUnlocked =
                  Boolean(
                    learningxInitialized &&
                    previous &&
                    !previous.is_unlocked &&
                    unlocked &&
                    !previous.unlock_notified_at,
                  );

                if (transitionedToUnlocked) {
                  const module = modules.find(
                    (candidate) =>
                      moduleWeekPosition(candidate) ===
                      week.week_position,
                  );

                  const lectureTitles =
                    (module?.items ?? [])
                      .filter(isLearningXItem)
                      .map((item) => item.title);

                  const message = lectureTitles.length > 0
                    ? [
                      `${week.week_position}주차 강의가 공개되었습니다.`,
                      "",
                      ...lectureTitles,
                    ].join("\n")
                    : `${week.week_position}주차 강의가 공개되었습니다.`;

                  const sent = await sendLoggedNtfy(
                    ctx.supabaseAdmin,
                    ntfyBaseUrl,
                    ntfyTopic,
                    "learningx_week_unlocked",
                    course.id,
                    String(week.week_position),
                    `[LMSartan] ${course.name}`,
                    message,
                    `${canvasBaseUrl}/courses/${course.id}/modules`,
                  );

                  if (sent) notificationsSent += 1;

                  unlockNotifiedAt =
                    new Date().toISOString();

                  weeksUnlockedThisRun.add(
                    week.week_position,
                  );
                } else if (
                  !learningxInitialized &&
                  unlocked
                ) {
                  // Existing already-open weeks become baseline
                  // without creating historical notifications.
                  unlockNotifiedAt =
                    new Date().toISOString();
                } else if (
                  learningxInitialized &&
                  !previous &&
                  unlocked
                ) {
                  // A newly discovered course/week may already be old.
                  // Do not flood historical unlock notifications.
                  unlockNotifiedAt =
                    new Date().toISOString();
                }

                const { error: weekUpsertError } =
                  await ctx.supabaseAdmin
                    .from("learningx_weeks")
                    .upsert({
                      course_id: course.id,
                      course_name: course.name!,
                      week_position:
                        week.week_position,
                      unlock_at: week.unlock_at,
                      lock_at: week.lock_at,
                      due_at: week.due_at,
                      late_at: week.late_at,
                      is_unlocked: unlocked,
                      unlock_notified_at:
                        unlockNotifiedAt,
                      last_seen_at:
                        new Date().toISOString(),
                    }, {
                      onConflict:
                        "course_id,week_position",
                    });

                if (weekUpsertError) {
                  throw weekUpsertError;
                }
              }
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : String(error);

              learningxWarnings.push(
                `course ${course.id}: ${message}`,
              );

              console.error(
                `LearningX warning for course ${course.id}:`,
                message,
              );
            }
          }

          for (const module of modules) {
            const weekPosition =
              moduleWeekPosition(module);

            for (const item of module.items ?? []) {
              itemsSeen += 1;

              const key =
                `${course.id}:${item.id}`;

              const existingItem =
                existingItems.get(key);

              const isNew =
                !existingItem;

              if (isNew) newItems += 1;

              currentItemRows.push({
                course_id: course.id,
                course_name: course.name!,
                module_id: module.id,
                module_name: module.name,
                item_id: item.id,
                item_type: item.type,
                title: item.title,
                html_url:
                  item.html_url ?? null,
                external_url:
                  item.external_url ?? null,
                last_seen_at:
                  new Date().toISOString(),
              });

              if (moduleBaseline) {
                continue;
              }

              const itemAlreadySent =
                await notificationAlreadySent(
                  ctx.supabaseAdmin,
                  "module_item_new",
                  course.id,
                  String(item.id),
                );

              if (itemAlreadySent) {
                continue;
              }

              const firstSeenAt =
                existingItem?.first_seen_at
                  ? new Date(existingItem.first_seen_at)
                  : new Date();

              const eligibleForCatchup =
                isNew ||
                (
                  moduleBaselineCutoff !== null &&
                  firstSeenAt > moduleBaselineCutoff
                );

              if (!eligibleForCatchup) {
                continue;
              }

              let message =
                `${module.name}\n${item.title}`;

              if (isLearningXItem(item)) {
                const week =
                  weekSchedule.get(weekPosition);

                if (week?.unlock_at) {
                  const unlocked =
                    new Date(week.unlock_at) <= new Date();

                  if (!unlocked) {
                    message = [
                      "새 콘텐츠가 등록되었습니다.",
                      "아직 공개 전입니다.",
                      "",
                      module.name,
                      item.title,
                      "",
                      `공개 예정: ${week.unlock_at}`,
                    ].join("\n");
                  } else {
                    message = [
                      "새 콘텐츠가 등록되었습니다.",
                      "",
                      module.name,
                      item.title,
                    ].join("\n");
                  }
                } else {
                  message = [
                    "새 콘텐츠가 등록되었습니다.",
                    "",
                    module.name,
                    item.title,
                  ].join("\n");
                }
              }

              const sent = await sendLoggedNtfy(
                ctx.supabaseAdmin,
                ntfyBaseUrl,
                ntfyTopic,
                "module_item_new",
                course.id,
                String(item.id),
                `[LMSartan] ${course.name}`,
                message,
                item.html_url,
              );

              if (sent) notificationsSent += 1;
            }
          }
        }

        stage = "upserting Canvas module items";

        if (currentItemRows.length > 0) {
          const { error: itemUpsertError } =
            await ctx.supabaseAdmin
              .from("canvas_items")
              .upsert(
                currentItemRows,
                {
                  onConflict:
                    "course_id,item_id",
                },
              );

          if (itemUpsertError) {
            throw itemUpsertError;
          }
        }

        stage = "fetching Canvas announcements";

        const announcementParams =
          new URLSearchParams();

        for (const course of activeCourses) {
          announcementParams.append(
            "context_codes[]",
            `course_${course.id}`,
          );
        }

        announcementParams.set(
          "per_page",
          "100",
        );

        const announcements =
          await canvasGetAll<CanvasAnnouncement>(
            canvasBaseUrl,
            canvasToken,
            `/api/v1/announcements?${announcementParams}`,
          );

        announcementsSeen =
          announcements.length;

        const courseNames = new Map(
          activeCourses.map((course) => [
            course.id,
            course.name!,
          ]),
        );

        for (const announcement of announcements) {
          const courseMatch =
            announcement.context_code.match(
              /^course_(\d+)$/,
            );

          if (!courseMatch) continue;

          const courseId =
            Number(courseMatch[1]);

          const courseName =
            courseNames.get(courseId) ??
            `Course ${courseId}`;

          const key =
            `${courseId}:${announcement.id}`;

          const previous =
            existingAnnouncements.get(key);

          const fingerprint =
            await announcementFingerprint(
              announcement,
            );

          const changed =
            Boolean(
              previous &&
              previous.content_fingerprint !==
                fingerprint,
            );

          const isNew = !previous;

          const newAnnouncementAlreadySent =
            await notificationAlreadySent(
              ctx.supabaseAdmin,
              "announcement_new",
              courseId,
              String(announcement.id),
            );

          const needsNewAnnouncement =
            announcementsInitialized &&
            !newAnnouncementAlreadySent;

          const needsChangedAnnouncement =
            announcementsInitialized &&
            newAnnouncementAlreadySent &&
            changed;

          if (
            needsNewAnnouncement ||
            needsChangedAnnouncement
          ) {
            const attachments =
              announcement.attachments ?? [];

            const attachmentText =
              attachments.length > 0
                ? `\n\n첨부파일: ${
                  attachments
                    .map((file) =>
                      file.display_name ??
                      file.filename ??
                      `파일 ${file.id}`
                    )
                    .join(", ")
                }`
                : "";

            const body =
              plainText(announcement.message);

            const eventType =
              needsNewAnnouncement
                ? "announcement_new"
                : "announcement_changed";

            const message = truncate(
              [
                needsNewAnnouncement
                  ? "새 공지사항"
                  : "공지사항이 변경되었습니다",
                "",
                announcement.title,
                body ? `\n${body}` : "",
                attachmentText,
              ].join("\n"),
              900,
            );

            const sourceId =
              needsNewAnnouncement
                ? String(announcement.id)
                : `${announcement.id}:${fingerprint}`;

            const sent = await sendLoggedNtfy(
              ctx.supabaseAdmin,
              ntfyBaseUrl,
              ntfyTopic,
              eventType,
              courseId,
              sourceId,
              `[LMSartan] ${courseName}`,
              message,
              announcement.html_url,
            );

            if (sent) notificationsSent += 1;

            announcementChanges += 1;
          }

          const lastChangedAt =
            changed || isNew
              ? new Date().toISOString()
              : previous?.last_changed_at ??
                new Date().toISOString();

          const {
            error: announcementUpsertError,
          } = await ctx.supabaseAdmin
            .from("canvas_announcements")
            .upsert({
              course_id: courseId,
              course_name: courseName,
              announcement_id:
                announcement.id,
              title:
                announcement.title,
              message_html:
                announcement.message ?? null,
              posted_at:
                announcement.posted_at ?? null,
              delayed_post_at:
                announcement.delayed_post_at ??
                null,
              published:
                announcement.published ?? null,
              html_url:
                announcement.html_url ?? null,
              attachments_json:
                announcement.attachments ?? [],
              content_fingerprint:
                fingerprint,
              last_seen_at:
                new Date().toISOString(),
              last_changed_at:
                lastChangedAt,
            }, {
              onConflict:
                "course_id,announcement_id",
            });

          if (announcementUpsertError) {
            throw announcementUpsertError;
          }
        }

        if (!announcementsInitialized) {
          stage =
            "marking announcement baseline";

          await markFeatureInitialized(
            ctx.supabaseAdmin,
            "baseline_announcements",
          );
        }

        if (!learningxInitialized) {
          stage =
            "marking LearningX baseline";

          await markFeatureInitialized(
            ctx.supabaseAdmin,
            "baseline_learningx",
          );
        }

        stage = "finishing watcher run";

        const { error: finishError } =
          await ctx.supabaseAdmin
            .from("watcher_runs")
            .update({
              finished_at:
                new Date().toISOString(),
              status: "success",
              courses_checked:
                activeCourses.length,
              items_seen: itemsSeen,
              new_items: newItems,
            })
            .eq("id", runId);

        if (finishError) throw finishError;

        return Response.json({
          ok: true,

          moduleBaseline,

          coursesChecked:
            activeCourses.length,

          itemsSeen,
          newItems,

          announcementsSeen,
          announcementChanges,

          learningxWeeksSeen,
          learningxWarnings,

          notificationsSent,
        });
      } catch (error) {
        const detail =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : typeof error === "object"
              ? JSON.stringify(
                error,
                Object.getOwnPropertyNames(
                  error as object,
                ),
              )
              : String(error);

        const message =
          `[${stage}] ${detail}`;

        if (runId !== null) {
          await ctx.supabaseAdmin
            .from("watcher_runs")
            .update({
              finished_at:
                new Date().toISOString(),
              status: "error",
              error_message: message,
            })
            .eq("id", runId);
        }

        console.error(message);

        return Response.json(
          {
            ok: false,
            stage,
            error: detail,
          },
          {
            status: 500,
          },
        );
      }
    },
  ),
};