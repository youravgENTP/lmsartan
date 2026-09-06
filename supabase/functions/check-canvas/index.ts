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
};

type CanvasModule = {
  id: number;
  name: string;
  items?: CanvasModuleItem[];
};

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function canvasGet<T>(
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

function notificationLabel(type: string): string {
  switch (type) {
    case "ExternalTool":
      return "새 강의 콘텐츠";
    case "Quiz":
      return "새 퀴즈";
    case "File":
      return "새 파일";
    case "Page":
      return "새 페이지";
    case "Assignment":
      return "새 과제";
    case "ExternalUrl":
      return "새 링크";
    default:
      return "새 콘텐츠";
  }
}

async function sendNtfy(
  baseUrl: string,
  topic: string,
  courseName: string,
  moduleName: string,
  item: CanvasModuleItem,
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/${topic}`;

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Title": `[LMSartan] ${courseName}`,
    "Tags": "books",
  };

  if (item.html_url) {
    headers["Click"] = item.html_url;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: `${notificationLabel(item.type)}\n${moduleName}\n${item.title}`,
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `ntfy error ${response.status} ${response.statusText}: ${body}`,
    );
  }
}

export default {
  fetch: withSupabase(
    { auth: ["secret"] },
    async (_req, ctx) => {
      const canvasBaseUrl = requiredEnv("CANVAS_BASE_URL").replace(/\/$/, "");
      const canvasToken = requiredEnv("CANVAS_ACCESS_TOKEN");

      const ntfyBaseUrl = requiredEnv("NTFY_BASE_URL");
      const ntfyTopic = requiredEnv("NTFY_TOPIC");

      let runId: number | null = null;
      let stage = "start";

      try {
        // A successful previous run means the initial baseline already exists.
        const {
          count: previousSuccessfulRuns,
          error: countError,
        } = await ctx.supabaseAdmin
          .from("watcher_runs")
          .select("*", {
            count: "exact",
            head: true,
          })
          .eq("status", "success");

        if (countError) {
          throw countError;
        }

        const isBaseline = (previousSuccessfulRuns ?? 0) === 0;

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

        if (runInsertError) {
          throw runInsertError;
        }

        runId = run.id;

        const {
          data: existingRows,
          error: existingError,
        } = await ctx.supabaseAdmin
          .from("canvas_items")
          .select("course_id,item_id");

        if (existingError) {
          throw existingError;
        }

        const existing = new Set(
          (existingRows ?? []).map(
            (row) => `${row.course_id}:${row.item_id}`,
          ),
        );

        const courses = await canvasGet<CanvasCourse[]>(
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
            (enrollment) => enrollment.enrollment_state === "active",
          );
        });

        const newRows: Array<{
          course_id: number;
          course_name: string;
          module_id: number;
          module_name: string;
          item_id: number;
          item_type: string;
          title: string;
          html_url: string | null;
          external_url: string | null;
        }> = [];

        const newNotifications: Array<{
          courseName: string;
          moduleName: string;
          item: CanvasModuleItem;
        }> = [];

        let itemsSeen = 0;

        for (const course of activeCourses) {
          const modules = await canvasGet<CanvasModule[]>(
            canvasBaseUrl,
            canvasToken,
            `/api/v1/courses/${course.id}/modules?include[]=items&per_page=100`,
          );

          for (const module of modules) {
            for (const item of module.items ?? []) {
              itemsSeen += 1;

              const key = `${course.id}:${item.id}`;

              if (existing.has(key)) {
                continue;
              }

              existing.add(key);

              newRows.push({
                course_id: course.id,
                course_name: course.name!,
                module_id: module.id,
                module_name: module.name,
                item_id: item.id,
                item_type: item.type,
                title: item.title,
                html_url: item.html_url ?? null,
                external_url: item.external_url ?? null,
              });

              newNotifications.push({
                courseName: course.name!,
                moduleName: module.name,
                item,
              });
            }
          }
        }

        if (newRows.length > 0) {
          const { error: insertError } = await ctx.supabaseAdmin
            .from("canvas_items")
            .insert(newRows);

          if (insertError) {
            throw insertError;
          }
        }

        // The very first successful run only establishes the baseline.
        if (!isBaseline) {
          for (const notification of newNotifications) {
            await sendNtfy(
              ntfyBaseUrl,
              ntfyTopic,
              notification.courseName,
              notification.moduleName,
              notification.item,
            );
          }
        }

        const { error: finishError } = await ctx.supabaseAdmin
          .from("watcher_runs")
          .update({
            finished_at: new Date().toISOString(),
            status: "success",
            courses_checked: activeCourses.length,
            items_seen: itemsSeen,
            new_items: newRows.length,
          })
          .eq("id", runId);

        if (finishError) {
          throw finishError;
        }

        return Response.json({
          ok: true,
          baseline: isBaseline,
          coursesChecked: activeCourses.length,
          itemsSeen,
          newItems: newRows.length,
          notificationsSent: isBaseline ? 0 : newNotifications.length,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "object"
              ? JSON.stringify(error)
              : String(error);

        if (runId !== null) {
          await ctx.supabaseAdmin
            .from("watcher_runs")
            .update({
              finished_at: new Date().toISOString(),
              status: "error",
              error_message: message,
            })
            .eq("id", runId);
        }

        console.error(message);

        return Response.json(
          {
            ok: false,
            error: message,
          },
          {
            status: 500,
          },
        );
      }
    },
  ),
};